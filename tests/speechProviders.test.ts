import { describe, it, expect, vi } from "vitest";

import {
  assertSpeechCredentials,
  DEFAULT_SPEECH_SPEC,
  importProviderModule,
  loadSpeechModel,
  parseSpeechSpec,
  type ModuleImporter,
} from "../src/speechProviders.js";

describe("parseSpeechSpec", () => {
  it("splits provider and model", () => {
    expect(parseSpeechSpec("elevenlabs:eleven_v3")).toEqual({
      provider: "elevenlabs",
      model: "eleven_v3",
    });
    expect(parseSpeechSpec("hume")).toEqual({
      provider: "hume",
      model: undefined,
    });
    expect(parseSpeechSpec("OpenAI:gpt-4o-mini-tts").provider).toBe("openai");
  });

  it("rejects malformed specs", () => {
    expect(() => parseSpeechSpec("eleven labs")).toThrow(
      /not a valid provider/,
    );
    expect(() => parseSpeechSpec("openai:")).toThrow(/empty model/);
  });
});

describe("assertSpeechCredentials", () => {
  it("names the missing env var for bundled providers", () => {
    expect(() =>
      assertSpeechCredentials({ provider: "elevenlabs" }, {}),
    ).toThrow(/ELEVENLABS_API_KEY/);
    expect(() =>
      assertSpeechCredentials({ provider: "openai" }, { OPENAI_API_KEY: "x" }),
    ).not.toThrow();
  });

  it("does not guess for unknown providers", () => {
    expect(() =>
      assertSpeechCredentials({ provider: "acme" }, {}),
    ).not.toThrow();
  });
});

function fakeImporter(modules: Record<string, Record<string, unknown>>) {
  const calls: string[] = [];
  const importer: ModuleImporter = async (specifier) => {
    calls.push(specifier);
    const m = modules[specifier];
    if (!m) throw new Error(`Cannot find package '${specifier}'`);
    return m;
  };
  return { importer, calls };
}

describe("loadSpeechModel", () => {
  it("uses the provider's default instance and its speech factory", async () => {
    const speech = vi.fn((id: string) => ({
      specificationVersion: "v4",
      modelId: id,
    }));
    const { importer, calls } = fakeImporter({
      "@ai-sdk/elevenlabs": {
        elevenlabs: { speech },
        createElevenLabs: () => ({}),
      },
    });
    const model = await loadSpeechModel(
      { provider: "elevenlabs", model: "eleven_v3" },
      { importer, cwd: "/nonexistent" },
    );
    expect(model).toMatchObject({ modelId: "eleven_v3" });
    expect(speech).toHaveBeenCalledWith("eleven_v3");
    // cwd had no copy → fell through to the bare specifier.
    expect(calls).toEqual(["@ai-sdk/elevenlabs"]);
  });

  it("applies the bundled default model when none is given", async () => {
    const speech = vi.fn((id: string) => ({ modelId: id }));
    const { importer } = fakeImporter({
      "@ai-sdk/openai": { openai: { speech } },
    });
    await loadSpeechModel(DEFAULT_SPEECH_SPEC, {
      importer,
      cwd: "/nonexistent",
    });
    await loadSpeechModel(
      { provider: "openai" },
      { importer, cwd: "/nonexistent" },
    );
    expect(speech).toHaveBeenNthCalledWith(1, "gpt-4o-mini-tts");
    expect(speech).toHaveBeenNthCalledWith(2, "gpt-4o-mini-tts");
  });

  it("calls a single-model provider's factory with no id", async () => {
    const speech = vi.fn(() => ({ modelId: "hume" }));
    const { importer } = fakeImporter({ "@ai-sdk/hume": { hume: { speech } } });
    await loadSpeechModel(
      { provider: "hume" },
      { importer, cwd: "/nonexistent" },
    );
    expect(speech).toHaveBeenCalledWith();
  });

  it("prefers the standard speechModel factory when present", async () => {
    const speechModel = vi.fn((id: string) => ({ modelId: id }));
    const speech = vi.fn();
    const { importer } = fakeImporter({
      "@ai-sdk/acme": { acme: { speechModel, speech } },
    });
    await loadSpeechModel(
      { provider: "acme", model: "m1" },
      { importer, cwd: "/nonexistent" },
    );
    expect(speechModel).toHaveBeenCalledWith("m1");
    expect(speech).not.toHaveBeenCalled();
  });

  it("requires a model id for an unknown provider", async () => {
    const { importer } = fakeImporter({
      "@ai-sdk/acme": { acme: { speech: vi.fn() } },
    });
    await expect(
      loadSpeechModel({ provider: "acme" }, { importer, cwd: "/nonexistent" }),
    ).rejects.toThrow(/model id is required/);
  });

  it("explains how to install a missing provider package", async () => {
    const { importer } = fakeImporter({});
    await expect(
      importProviderModule("acme", { importer, cwd: "/nonexistent" }),
    ).rejects.toThrow(/npm i @ai-sdk\/acme/);
  });

  it("really resolves a bundled provider without a fake importer", async () => {
    const model = await loadSpeechModel(
      { provider: "openai", model: "gpt-4o-mini-tts" },
      { cwd: "/nonexistent" },
    );
    expect(model).toMatchObject({
      modelId: "gpt-4o-mini-tts",
      provider: expect.stringContaining("openai"),
    });
  });
});
