import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";

import { createSilentTTS, estimateSpeechSeconds } from "../src/demo/tts.js";

describe("estimateSpeechSeconds", () => {
  it("scales with word count and respects the floor", () => {
    expect(estimateSpeechSeconds("hi")).toBe(1.5);
    expect(
      estimateSpeechSeconds("one two three four five six seven eight nine ten"),
    ).toBe(4);
    expect(estimateSpeechSeconds("a b c d", 2, 0)).toBe(2);
  });
});

// Only runs where an ffmpeg binary is reachable; the provider shells out to it.
const ffmpeg = [
  "/usr/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/opt/homebrew/bin/ffmpeg",
].find((p) => existsSync(p));

describe.skipIf(!ffmpeg)("createSilentTTS", () => {
  it("produces a WAV whose length matches the narration estimate", async () => {
    const tts = createSilentTTS({ ffmpegPath: ffmpeg });
    const r = await tts.speak(
      "one two three four five six seven eight nine ten",
      "alloy",
    );
    expect(r.extension).toBe("wav");
    expect(Buffer.from(r.audio.subarray(0, 4)).toString()).toBe("RIFF");
    // 24 kHz mono 16-bit → 48 000 bytes/s; 10 words / 2.5 wps = 4 s (+ header).
    expect(r.audio.byteLength).toBeGreaterThan(4 * 48_000);
    expect(r.audio.byteLength).toBeLessThan(4 * 48_000 + 4096);
  });

  it("fails at construction when no ffmpeg is available", () => {
    expect(() => createSilentTTS({ ffmpegPath: "" })).toThrow(/ffmpeg/);
  });
});
