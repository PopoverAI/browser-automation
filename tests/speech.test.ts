import { describe, it, expect, vi } from "vitest";
import { MockSpeechModelV4 } from "ai/test";

import { estimateSpeechSeconds, silentWav, synthesize } from "../src/speech.js";

describe("estimateSpeechSeconds", () => {
  it("scales with word count and respects the floor", () => {
    expect(estimateSpeechSeconds("hi")).toBe(1.5);
    expect(
      estimateSpeechSeconds("one two three four five six seven eight nine ten"),
    ).toBe(4);
    expect(estimateSpeechSeconds("a b c d", 2, 0)).toBe(2);
  });
});

describe("silentWav", () => {
  it("writes a valid 16-bit mono PCM header sized to the duration", () => {
    const wav = Buffer.from(silentWav(2, 24_000));
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    const dataBytes = wav.readUInt32LE(40);
    expect(dataBytes).toBe(2 * 24_000 * 2);
    expect(wav.length).toBe(44 + dataBytes);
    expect(wav.readUInt32LE(4)).toBe(36 + dataBytes);
    // Body is silence.
    expect(wav.subarray(44).every((b) => b === 0)).toBe(true);
  });
});

describe("synthesize", () => {
  it("returns silence sized to the text when no speech is configured", async () => {
    const r = await synthesize(
      "one two three four five six seven eight nine ten",
      undefined,
    );
    expect(r.format).toBe("wav");
    expect(r.audio.byteLength).toBe(44 + 4 * 24_000 * 2);
  });

  it("calls the speech model with text + options and reports the provider's format", async () => {
    // The SDK sniffs the format from the bytes (falling back to mp3), so
    // hand it a real WAV to prove the reported format flows through.
    const wavBytes = silentWav(0.01);
    const doGenerate = vi.fn(async () => ({
      audio: wavBytes,
      warnings: [],
      response: { timestamp: new Date(), modelId: "m" },
    }));
    const r = await synthesize(
      "hello",
      {
        model: new MockSpeechModelV4({ doGenerate }),
        voice: "v",
        instructions: "slowly",
        outputFormat: "wav",
      },
      { signal: undefined },
    );
    expect(doGenerate).toHaveBeenCalledTimes(1);
    expect(doGenerate.mock.calls[0][0]).toMatchObject({
      text: "hello",
      voice: "v",
      instructions: "slowly",
      outputFormat: "wav",
    });
    expect(r.audio).toEqual(wavBytes);
    expect(r.format).toBe("wav");
  });

  it("surfaces provider warnings through onWarning", async () => {
    const onWarning = vi.fn();
    await synthesize(
      "hello",
      {
        model: new MockSpeechModelV4({
          doGenerate: async () => ({
            audio: new Uint8Array([1]),
            warnings: [
              {
                type: "unsupported",
                feature: "speed",
                message: "speed unsupported",
              },
            ],
            response: { timestamp: new Date(), modelId: "m" },
          }),
        }),
      },
      { onWarning },
    );
    expect(onWarning).toHaveBeenCalledTimes(1);
  });
});
