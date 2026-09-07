import { readFileSync } from "node:fs";

import { z } from "zod/v4";

/**
 * The steps file: what `browser-demo` records. Defined once here so the
 * validator, the published JSON Schema (`browser-demo schema`), and the
 * starter example (`browser-demo example`) cannot drift apart.
 */

const SpeechOverridesSchema = z.object({
  voice: z
    .string()
    .optional()
    .describe("Voice id for the narration provider (provider-specific)."),
  instructions: z
    .string()
    .optional()
    .describe(
      "Delivery instructions, e.g. 'warm and unhurried' (provider support varies).",
    ),
  speed: z.number().positive().optional().describe("Speaking rate multiplier."),
  language: z
    .string()
    .optional()
    .describe("ISO 639-1 language code, or 'auto'."),
});

const SpeechSchema = SpeechOverridesSchema.extend({
  provider: z
    .string()
    .min(1)
    .optional()
    .describe(
      "AI SDK speech provider: openai (default), elevenlabs, lmnt, hume, deepgram, or any @ai-sdk/<name> that is installed.",
    ),
  model: z
    .string()
    .min(1)
    .optional()
    .describe("Provider model id, e.g. gpt-4o-mini-tts or eleven_v3."),
  outputFormat: z
    .string()
    .optional()
    .describe("Audio format requested from the provider (default mp3)."),
  providerOptions: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional()
    .describe("Provider-specific options, keyed by provider name."),
});

const StepSchema = z.object({
  narrate: z
    .string()
    .min(1)
    .describe(
      "What is said over this step. Decide it up front; it sets the segment's length.",
    ),
  commands: z
    .array(z.array(z.string()).min(1))
    .min(1)
    .describe(
      'agent-browser commands as argv arrays, run as one `agent-browser batch --bail`. E.g. [["find","text","Sign in","click"],["wait","--load","networkidle"]].',
    ),
  trailingDelay: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Milliseconds to keep capturing after the last command (default 1000).",
    ),
  speech: SpeechOverridesSchema.optional().describe(
    "Narration overrides for this step only.",
  ),
});

export const StepsFileSchema = z
  .object({
    url: z
      .string()
      .optional()
      .describe(
        "Opened with `agent-browser open` before recording. Omit to record what the daemon already has open.",
      ),
    openArgs: z
      .array(z.string())
      .optional()
      .describe('Extra arguments for `open`, e.g. ["--headers", "{...}"].'),
    speech: SpeechSchema.optional().describe(
      "Narration provider and voice. Default: openai gpt-4o-mini-tts, voice alloy.",
    ),
    steps: z.array(StepSchema).min(1),
  })
  .describe("browser-demo steps file");

export type StepsFile = z.infer<typeof StepsFileSchema>;
export type Step = z.infer<typeof StepSchema>;

export class StepsFileError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = "StepsFileError";
  }
}

export function parseStepsFileText(raw: string, path = "<steps>"): StepsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StepsFileError(
      `${path}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      path,
    );
  }
  const result = StepsFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new StepsFileError(
      `${path}: ${issues}\nRun \`browser-demo schema\` for the JSON Schema or \`browser-demo example\` for a starter file.`,
      path,
    );
  }
  return result.data;
}

export function parseStepsFile(path: string): StepsFile {
  return parseStepsFileText(readFileSync(path, "utf8"), path);
}

/** JSON Schema (draft 2020-12) for the steps file, generated from the validator. */
export function stepsFileJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(StepsFileSchema) as Record<string, unknown>;
}

/** A starter steps file that validates against the schema. */
export function exampleStepsFile(): StepsFile {
  return {
    url: "https://app.example.com/login",
    speech: {
      provider: "openai",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      instructions: "Friendly product walkthrough; unhurried.",
    },
    steps: [
      {
        narrate: "Sign in with the demo account.",
        commands: [
          ["fill", "#email", "demo@example.com"],
          ["fill", "#password", "hunter2"],
          ["find", "text", "Sign in", "click"],
          ["wait", "--load", "networkidle"],
        ],
      },
      {
        narrate: "The dashboard opens on this week's numbers.",
        commands: [
          ["find", "text", "This week", "click"],
          ["wait", "500"],
        ],
        trailingDelay: 1500,
      },
    ],
  };
}
