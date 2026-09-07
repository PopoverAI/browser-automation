import { describe, it, expect, vi } from "vitest";

import { resolveSpeech } from "../src/speechConfig.js";
import type { SpeechSpec } from "../src/speechProviders.js";

const env = {
  OPENAI_API_KEY: "k",
  ELEVENLABS_API_KEY: "k",
};

function fakeLoader() {
  return vi.fn(async (spec: SpeechSpec) => ({
    specificationVersion: "v4" as const,
    provider: spec.provider,
    modelId: spec.model ?? "",
    doGenerate: async () => {
      throw new Error("not called");
    },
  }));
}

describe("resolveSpeech", () => {
  it("defaults to openai gpt-4o-mini-tts with voice alloy", async () => {
    const loadModel = fakeLoader();
    const s = await resolveSpeech(undefined, {}, { loadModel, env });
    expect(loadModel).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-4o-mini-tts",
    });
    expect(s.voice).toBe("alloy");
  });

  it("keeps a model configured without a provider (default provider, that model)", async () => {
    const loadModel = fakeLoader();
    await resolveSpeech({ model: "tts-1-hd" }, {}, { loadModel, env });
    expect(loadModel).toHaveBeenCalledWith({
      provider: "openai",
      model: "tts-1-hd",
    });
  });

  it("matches the file's provider to the flag case-insensitively when choosing the voice", async () => {
    const loadModel = fakeLoader();
    const s = await resolveSpeech(
      { provider: "OpenAI", voice: "nova" },
      { tts: "openai" },
      { loadModel, env },
    );
    expect(s.voice).toBe("nova");
  });

  it("drops the file's voice when --tts switches provider, and lets --voice win", async () => {
    const loadModel = fakeLoader();
    const dropped = await resolveSpeech(
      { provider: "openai", voice: "nova" },
      { tts: "elevenlabs:eleven_v3" },
      { loadModel, env },
    );
    expect(dropped.voice).toBeUndefined();
    const flagged = await resolveSpeech(
      { provider: "openai", voice: "nova" },
      { voice: "shimmer" },
      { loadModel, env },
    );
    expect(flagged.voice).toBe("shimmer");
  });

  it("passes narration knobs through and checks credentials up front", async () => {
    const loadModel = fakeLoader();
    const s = await resolveSpeech(
      {
        provider: "elevenlabs",
        model: "eleven_v3",
        voice: "v",
        instructions: "warm",
        speed: 1.1,
        language: "en",
        providerOptions: { elevenlabs: { stability: 0.4 } },
      },
      {},
      { loadModel, env },
    );
    expect(s).toMatchObject({
      voice: "v",
      instructions: "warm",
      speed: 1.1,
      language: "en",
      providerOptions: { elevenlabs: { stability: 0.4 } },
    });
    await expect(
      resolveSpeech({ provider: "lmnt" }, {}, { loadModel, env: {} }),
    ).rejects.toThrow(/LMNT_API_KEY/);
    expect(loadModel).toHaveBeenCalledTimes(1);
  });
});
