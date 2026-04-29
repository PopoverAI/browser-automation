import { experimental_generateSpeech as generateSpeech } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

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
