#!/usr/bin/env node
/**
 * browser-demo — record a narrated demo video by driving agent-browser.
 *
 *   browser-demo steps.json --out ./demo
 *
 * The steps file is a JSON document:
 *
 *   {
 *     "url": "https://app.example.com",          // optional: opened before recording
 *     "openArgs": ["--headers", "{...}"],        // optional: extra args for `open`
 *     "speech": { "provider": "elevenlabs", "model": "eleven_v3", "voice": "..." }, // optional
 *     "steps": [
 *       { "narrate": "Sign in with the demo account.",
 *         "commands": [["fill", "#email", "demo@example.com"], ["click", "text=Sign in"], ["wait", "--load", "networkidle"]] }
 *     ]
 *   }
 *
 * Each step runs as one `agent-browser batch --bail` and becomes one narrated
 * segment. The daemon owns the browser: point it at a cloud provider with
 * `agent-browser -p browserbase open ...` (or `--cdp <wsUrl>`) beforehand and
 * pass the same `--session` here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { program } from "commander";
import { z } from "zod";

import { AgentBrowserClient } from "./agentBrowserClient.js";
import {
  attachAgentBrowserDemoRecorder,
  DemoStepError,
} from "./agentBrowserRecorder.js";
import type { SpeechOptions } from "./speech.js";
import {
  assertSpeechCredentials,
  DEFAULT_OPENAI_VOICE,
  DEFAULT_SPEECH_SPEC,
  loadSpeechModel,
  parseSpeechSpec,
  type SpeechSpec,
} from "./speechProviders.js";

const SpeechOverridesSchema = z.object({
  voice: z.string().optional(),
  instructions: z.string().optional(),
  speed: z.number().positive().optional(),
  language: z.string().optional(),
});

const SpeechSchema = SpeechOverridesSchema.extend({
  /** AI SDK provider package name, e.g. "openai", "elevenlabs". */
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  outputFormat: z.string().optional(),
  providerOptions: z.record(z.record(z.unknown())).optional(),
});

const StepSchema = z.object({
  narrate: z.string().min(1),
  commands: z.array(z.array(z.string()).min(1)).min(1),
  trailingDelay: z.number().int().nonnegative().optional(),
  speech: SpeechOverridesSchema.optional(),
});

const StepsFileSchema = z.object({
  url: z.string().optional(),
  openArgs: z.array(z.string()).optional(),
  speech: SpeechSchema.optional(),
  steps: z.array(StepSchema).min(1),
});

export type StepsFile = z.infer<typeof StepsFileSchema>;

interface CliOptions {
  out?: string;
  tts?: string;
  voice?: string;
  keep?: boolean;
  session?: string;
  agentBrowser?: string;
  trailingDelay?: string;
  maxFps?: string;
  silent?: boolean;
  ffmpeg?: string;
  json?: boolean;
}

function log(msg: string): void {
  process.stderr.write(`[browser-demo] ${msg}\n`);
}

export function parseStepsFile(path: string): StepsFile {
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${path}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const result = StepsFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `${path}: ${result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`,
    );
  }
  return result.data;
}

async function main(file: string, opts: CliOptions): Promise<void> {
  const steps = parseStepsFile(resolve(file));

  const client = new AgentBrowserClient({
    command: opts.agentBrowser ? opts.agentBrowser.split(/\s+/) : undefined,
    session: opts.session,
  });

  // Resolve narration before touching the browser so a missing key or
  // provider fails in the first second, not after the recording.
  const speech = opts.silent ? undefined : await resolveSpeech(steps, opts);

  if (steps.url) {
    log(`open ${steps.url}`);
    const r = await client.run(["open", steps.url, ...(steps.openArgs ?? [])], {
      timeoutMs: 60_000,
    });
    if (r.status !== 0) {
      throw new Error(
        `agent-browser open failed (exit ${r.status}): ${r.stderr || r.stdout}`,
      );
    }
  }

  const demo = await attachAgentBrowserDemoRecorder({
    client,
    trailingDelay: opts.trailingDelay ? Number(opts.trailingDelay) : undefined,
    maxFps: opts.maxFps ? Number(opts.maxFps) : undefined,
  });

  try {
    for (let i = 0; i < steps.steps.length; i++) {
      const s = steps.steps[i];
      log(`step ${i + 1}/${steps.steps.length}: ${s.narrate}`);
      await demo.step(s.commands, s.narrate, {
        trailingDelay: s.trailingDelay,
        speech: s.speech,
      });
    }
  } catch (err) {
    await demo.stop();
    if (err instanceof DemoStepError) {
      for (const r of err.results) {
        log(
          `  ${r.success ? "ok " : "ERR"} ${r.command.join(" ")}${r.error ? ` — ${r.error}` : ""}`,
        );
      }
    }
    throw err;
  }

  log("rendering…");
  const result = await demo.render({
    outputDir: opts.out ? resolve(opts.out) : undefined,
    keepIntermediates: opts.keep,
    speech,
    ffmpegPath: opts.ffmpeg,
  });

  const summary = {
    videoPath: result.videoPath,
    outputDir: result.outputDir,
    segments: result.timeline.map((e, i) => ({
      index: i,
      instruction: e.instruction,
      narrative: e.narrative,
      segmentDuration: e.segmentDuration,
      frameCount: e.frameCount,
    })),
  };
  if (opts.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    for (const s of summary.segments) {
      log(
        `  segment ${s.index}: ${s.frameCount} frames, ${s.segmentDuration.toFixed(1)}s — ${s.instruction}`,
      );
    }
    process.stdout.write(result.videoPath + "\n");
  }
}

/**
 * Precedence: --tts / --voice flags → the steps file's `speech` block →
 * OpenAI gpt-4o-mini-tts with voice "alloy". Credentials come from the
 * provider package's own env var (OPENAI_API_KEY, ELEVENLABS_API_KEY, …).
 */
export async function resolveSpeech(
  steps: StepsFile,
  opts: Pick<CliOptions, "tts" | "voice">,
  deps: { loadModel?: typeof loadSpeechModel; env?: NodeJS.ProcessEnv } = {},
): Promise<SpeechOptions> {
  const file = steps.speech ?? {};
  let spec: SpeechSpec;
  if (opts.tts) {
    spec = parseSpeechSpec(opts.tts);
  } else if (file.provider) {
    spec = { provider: file.provider.toLowerCase(), model: file.model };
  } else {
    spec = DEFAULT_SPEECH_SPEC;
  }
  assertSpeechCredentials(spec, deps.env);

  const model = await (deps.loadModel ?? loadSpeechModel)(spec);
  // Flags beat the file; the file's voice only applies to its own provider.
  const fileVoice =
    !opts.tts || opts.tts.split(":")[0].toLowerCase() === file.provider
      ? file.voice
      : undefined;
  const voice =
    opts.voice ??
    fileVoice ??
    (spec.provider === "openai" ? DEFAULT_OPENAI_VOICE : undefined);

  const speech: SpeechOptions = { model };
  if (voice) speech.voice = voice;
  if (file.instructions) speech.instructions = file.instructions;
  if (file.speed) speech.speed = file.speed;
  if (file.language) speech.language = file.language;
  if (file.outputFormat) speech.outputFormat = file.outputFormat;
  if (file.providerOptions) {
    speech.providerOptions =
      file.providerOptions as SpeechOptions["providerOptions"];
  }
  log(
    `narration: ${spec.provider}${spec.model ? `:${spec.model}` : ""}${voice ? ` (voice ${voice})` : ""}`,
  );
  return speech;
}

program
  .name("browser-demo")
  .description("Record a narrated demo video by driving agent-browser")
  .argument("<steps.json>", "steps file (see header comment for the schema)")
  .option("-o, --out <dir>", "output directory (default: a unique temp dir)")
  .option(
    "--tts <provider[:model]>",
    'narration provider, e.g. "elevenlabs:eleven_v3" (default: openai:gpt-4o-mini-tts)',
  )
  .option("--voice <voice>", "voice id for the narration provider")
  .option("--silent", "render a silent audio track (no key needed)")
  .option("--keep", "keep per-segment intermediates next to final.mp4")
  .option("--session <name>", "agent-browser --session to drive")
  .option(
    "--agent-browser <cmd>",
    'command used to invoke agent-browser (default: "npx agent-browser")',
  )
  .option(
    "--trailing-delay <ms>",
    "delay after each step before closing its segment (default 1000)",
  )
  .option(
    "--max-fps <n>",
    "cap the frame rate requested from the stream (default: uncapped)",
  )
  .option("--ffmpeg <path>", "ffmpeg binary (default: ffmpeg-static)")
  .option("--json", "print the result summary as JSON on stdout")
  .action(async (file: string, opts: CliOptions) => {
    try {
      await main(file, opts);
    } catch (err) {
      log(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
