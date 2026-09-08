import type { generateSpeech } from "ai";

/**
 * Narration configuration — everything `generateSpeech` accepts except the
 * text (which comes from each step) and the abort signal (which the render
 * call owns). `model` is any AI SDK speech model: `openai.speech(...)`,
 * `elevenlabs.speech(...)`, a hand-rolled `SpeechModelV4`, or a string id
 * if you've installed a provider registry that implements speech.
 */
export type SpeechOptions = Omit<
  Parameters<typeof generateSpeech>[0],
  "text" | "abortSignal"
>;

/**
 * Per-step overrides: the narration knobs that make sense to vary between
 * segments (a second voice, a different language). Model stays fixed.
 */
export type SpeechOverrides = Pick<
  SpeechOptions,
  "voice" | "instructions" | "speed" | "language"
>;

export interface SynthesizedAudio {
  audio: Uint8Array;
  /** Container/codec name as reported by the provider, e.g. "mp3", "wav". */
  format: string;
}

/** Sample rate used for the silent track. */
const SILENT_SAMPLE_RATE = 24_000;

/**
 * Estimate how long `text` would take to say aloud. Sizes silent segments
 * so a --silent render has the same pacing a narrated one would.
 */
export function estimateSpeechSeconds(
  text: string,
  wordsPerSecond = 2.5,
  minSeconds = 1.5,
): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(minSeconds, words / wordsPerSecond);
}

/**
 * A silent 16-bit mono PCM WAV of the given length. Pure JS — no ffmpeg
 * needed to make silence.
 */
export function silentWav(
  seconds: number,
  sampleRate = SILENT_SAMPLE_RATE,
): Uint8Array {
  const frames = Math.max(1, Math.round(seconds * sampleRate));
  const dataBytes = frames * 2;
  const buf = Buffer.alloc(44 + dataBytes); // data region is already zeroed
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Narrate `text`: through the AI SDK when `speech` is configured, otherwise
 * as silence sized to the text. The SDK is imported lazily so a silent
 * render never loads it.
 */
export async function synthesize(
  text: string,
  speech: SpeechOptions | undefined,
  opts: {
    signal?: AbortSignal;
    onWarning?: (warnings: unknown[]) => void;
  } = {},
): Promise<SynthesizedAudio> {
  if (!speech) {
    return { audio: silentWav(estimateSpeechSeconds(text)), format: "wav" };
  }
  const { generateSpeech } = await import("ai");
  const result = await generateSpeech({
    outputFormat: "mp3",
    ...speech,
    text,
    abortSignal: opts.signal,
  });
  if (result.warnings.length > 0) {
    (opts.onWarning ?? defaultWarn)(result.warnings);
  }
  return { audio: result.audio.uint8Array, format: result.audio.format };
}

function defaultWarn(warnings: unknown[]): void {
  for (const w of warnings) {
    const msg =
      typeof w === "object" && w && "message" in w
        ? String((w as { message: unknown }).message)
        : JSON.stringify(w);
    process.stderr.write(`[speech] warning: ${msg}\n`);
  }
}
