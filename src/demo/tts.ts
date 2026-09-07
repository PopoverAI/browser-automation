import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { experimental_generateSpeech as generateSpeech } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import ffmpegStaticPath from "ffmpeg-static";

export interface TTSResult {
  /** Raw audio bytes (mp3). */
  audio: Uint8Array;
  /** File extension to use when writing to disk (e.g. "mp3"). */
  extension: string;
}

/**
 * A TTS provider takes narration text and a voice id and returns audio bytes.
 * The default implementation uses OpenAI's `gpt-4o-mini-tts`. Callers can
 * supply a custom provider via `renderTimeline({ tts: ... })` to plug in a
 * different backend (e.g. Gemini, ElevenLabs) without touching the pipeline.
 */
export interface TTSProvider {
  speak(text: string, voice: string): Promise<TTSResult>;
}

/**
 * Default OpenAI TTS provider. Reads `OPENAI_API_KEY` from the environment
 * unless an explicit key is passed. Throws at construction time if no key
 * is available, so callers see a clear error instead of an opaque SDK
 * exception on the first `speak()` call.
 */
export function createOpenAITTS(opts: {
  apiKey?: string;
  model?: string;
} = {}): TTSProvider {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "createOpenAITTS: OPENAI_API_KEY is not set (and no apiKey was supplied). Set the env var or pass { apiKey } explicitly.",
    );
  }
  const provider = createOpenAI({ apiKey });
  const modelId = opts.model ?? "gpt-4o-mini-tts";
  return {
    async speak(text, voice) {
      const speech = await generateSpeech({
        model: provider.speech(modelId),
        text,
        voice,
      });
      return {
        audio: speech.audio.uint8Array,
        extension: "mp3",
      };
    },
  };
}

export interface SilentTTSOptions {
  /** ffmpeg binary used to synthesise silence. Defaults to ffmpeg-static's. */
  ffmpegPath?: string;
  /** Speaking rate used to size each silent segment. Default 2.5 words/second. */
  wordsPerSecond?: number;
  /** Floor for a segment's duration in seconds. Default 1.5. */
  minSeconds?: number;
}

/**
 * Estimate how long `text` would take to say aloud. Shared by the silent
 * provider so its segment lengths track real narration pacing.
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
 * A TTS provider that produces silence sized to the narration. Useful for
 * dry runs, CI, and environments without an OpenAI key: the rendered video
 * has the same segment timing a narrated one would, just no voice track.
 */
export function createSilentTTS(opts: SilentTTSOptions = {}): TTSProvider {
  const ffmpeg = opts.ffmpegPath ?? ffmpegStaticPath;
  if (!ffmpeg) {
    throw new Error(
      "createSilentTTS: no ffmpeg binary available — install ffmpeg-static's binary or pass { ffmpegPath }.",
    );
  }
  return {
    async speak(text) {
      const seconds = estimateSpeechSeconds(
        text,
        opts.wordsPerSecond,
        opts.minSeconds,
      );
      // Write to a file rather than a pipe: WAV headers carry byte counts
      // that ffmpeg can only fill in on a seekable output.
      const tmp = join(tmpdir(), `browser-demo-silence-${randomUUID()}.wav`);
      try {
        const r = spawnSync(ffmpeg, [
          "-hide_banner",
          "-loglevel", "error",
          "-y",
          "-f", "lavfi",
          "-i", "anullsrc=r=24000:cl=mono",
          "-t", seconds.toFixed(3),
          tmp,
        ]);
        if (r.error) throw r.error;
        if (r.status !== 0) {
          throw new Error(
            `createSilentTTS: ffmpeg exited with status ${r.status}: ${r.stderr?.toString().slice(0, 500)}`,
          );
        }
        return { audio: new Uint8Array(readFileSync(tmp)), extension: "wav" };
      } finally {
        rmSync(tmp, { force: true });
      }
    },
  };
}
