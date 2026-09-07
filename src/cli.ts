/**
 * browser-demo — record a narrated demo video by driving agent-browser.
 *
 *   browser-demo guide             the agent-facing guide (SKILL.md)
 *   browser-demo schema            JSON Schema for the steps file
 *   browser-demo example           a starter steps file
 *   browser-demo validate FILE     check a steps file without recording
 *   browser-demo record FILE       record; `browser-demo FILE` is the same
 *
 * The steps file is defined in ./stepsFile.ts; the guide lives in SKILL.md
 * at the package root so it ships with, and matches, this binary.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { program } from "commander";

import { AgentBrowserClient } from "./agentBrowserClient.js";
import {
  attachAgentBrowserDemoRecorder,
  DemoStepError,
  stepFailureHints,
} from "./agentBrowserRecorder.js";
import type { SpeechOptions } from "./speech.js";
import {
  exampleStepsFile,
  parseStepsFile,
  StepsFileError,
  stepsFileJsonSchema,
  type StepsFile,
} from "./stepsFile.js";
import {
  assertSpeechCredentials,
  DEFAULT_OPENAI_VOICE,
  DEFAULT_SPEECH_SPEC,
  loadSpeechModel,
  parseSpeechSpec,
  type SpeechSpec,
} from "./speechProviders.js";

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
      for (const hint of stepFailureHints(err)) log(`  hint: ${hint}`);
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

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readGuide(): string {
  return readFileSync(join(PACKAGE_ROOT, "SKILL.md"), "utf8");
}

const recordOptions = (cmd: typeof program) =>
  cmd
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
    .option("--json", "print the result summary as JSON on stdout");

function fail(err: unknown): void {
  log(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

program
  .name("browser-demo")
  .description("Record a narrated demo video by driving agent-browser")
  .addHelpText(
    "before",
    `Start here (for AI agents):
  browser-demo guide           Workflow, steps-file format, commands that work, how to read failures
  browser-demo schema          JSON Schema for the steps file
  browser-demo example         A starter steps file to edit
  browser-demo validate FILE   Check a steps file without touching a browser

Typical run:
  agent-browser open https://app.example.com && agent-browser snapshot -i   # explore
  browser-demo validate steps.json
  browser-demo record steps.json --silent --out ./demo                       # dry run, no key
  OPENAI_API_KEY=... browser-demo record steps.json --out ./demo             # narrated
`,
  )
  .showHelpAfterError("(run `browser-demo guide` for the full workflow)");

recordOptions(
  program
    .command("record", { isDefault: true })
    .description("record steps.json to an mp4 (default command)")
    .argument(
      "<steps.json>",
      "steps file — `browser-demo schema` / `browser-demo example` describe it",
    ),
).action(async (file: string, opts: CliOptions) => {
  try {
    await main(file, opts);
  } catch (err) {
    fail(err);
  }
});

program
  .command("validate")
  .description("parse and validate a steps file; exits non-zero on problems")
  .argument("<steps.json>")
  .action((file: string) => {
    try {
      const steps = parseStepsFile(resolve(file));
      const provider = steps.speech?.provider ?? "openai";
      process.stdout.write(
        `${file}: ok — ${steps.steps.length} step(s), ${steps.url ? `opens ${steps.url}` : "records the daemon's current page"}, narration via ${provider}${steps.speech?.model ? `:${steps.speech.model}` : ""}\n`,
      );
    } catch (err) {
      fail(err instanceof StepsFileError ? err.message : err);
    }
  });

program
  .command("guide")
  .description("print the agent-facing guide (SKILL.md)")
  .action(() => {
    process.stdout.write(readGuide());
  });

program
  .command("schema")
  .description("print the steps file JSON Schema (draft 2020-12)")
  .action(() => {
    process.stdout.write(JSON.stringify(stepsFileJsonSchema(), null, 2) + "\n");
  });

program
  .command("example")
  .description("print a starter steps file")
  .action(() => {
    process.stdout.write(JSON.stringify(exampleStepsFile(), null, 2) + "\n");
  });

// Agents pipe help and guides into `head`; a closed pipe is not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

// A bare `browser-demo` should orient, not complain about a missing argument.
if (process.argv.length <= 2) {
  program.outputHelp();
} else {
  program.parseAsync(process.argv);
}
