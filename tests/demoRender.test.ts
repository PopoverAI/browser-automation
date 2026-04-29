import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { renderTimeline } from "../src/demo/render.js";
import type { TTSProvider } from "../src/demo/tts.js";
import type { CapturedFrame, TimelineEntry } from "../src/demo/recorder.js";

function makeTimeline(): {
  timeline: TimelineEntry[];
  frames: CapturedFrame[];
} {
  // Two segments, three frames each, with a 10ms gap of un-narrated frames
  // between them that should be excluded from both segments.
  const f = (t: number, label: string): CapturedFrame => ({
    timestamp: t,
    data: Buffer.from(`fake-png-${label}`).toString("base64"),
  });

  const entry1: TimelineEntry = {
    instruction: "go to login",
    narrative: "navigating to login",
    startTime: 1000,
    endTime: 1100,
    frameCount: 3,
    segmentDuration: 0.1,
  };
  const entry2: TimelineEntry = {
    instruction: "submit",
    narrative: "submitting the form",
    startTime: 1200,
    endTime: 1300,
    frameCount: 3,
    segmentDuration: 0.1,
  };

  const frames: CapturedFrame[] = [
    f(1010, "a1"),
    f(1050, "a2"),
    f(1090, "a3"),
    // un-narrated:
    f(1150, "between"),
    // entry 2:
    f(1210, "b1"),
    f(1250, "b2"),
    f(1290, "b3"),
  ];

  return { timeline: [entry1, entry2], frames };
}

function fakeExec(records: Array<{ cmd: string; output: string }>) {
  return (cmd: string): string => {
    const r = records.find((rec) => cmd.includes(rec.cmd));
    if (r) return r.output;
    return "";
  };
}

describe("renderTimeline", () => {
  let outputDir: string;
  let tts: TTSProvider;

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), "demo-render-test-"));
    tts = {
      speak: vi.fn(async (text: string) => ({
        audio: new Uint8Array(Buffer.from(`audio-for-${text}`)),
        extension: "mp3",
      })),
    };
  });

  afterEach(() => {
    if (existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("invokes TTS for each timeline entry", async () => {
    const { timeline, frames } = makeTimeline();
    const exec = vi.fn((cmd: string) => {
      // Audio duration probe: return a parseable timestamp.
      if (cmd.includes("grep Duration")) return "00:00:02.50";
      return "";
    });

    await renderTimeline({
      timeline,
      frames,
      outputDir,
      tts,
      exec,
      keepIntermediates: true,
    });

    expect(tts.speak).toHaveBeenCalledTimes(2);
    expect((tts.speak as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "navigating to login",
    );
    expect((tts.speak as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe(
      "submitting the form",
    );
  });

  it("filters frames to each entry's [startTime, endTime] window", async () => {
    const { timeline, frames } = makeTimeline();
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("grep Duration")) return "00:00:02.50";
      return "";
    });

    const result = await renderTimeline({
      timeline,
      frames,
      outputDir,
      tts,
      exec,
      keepIntermediates: true,
    });

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].frameCount).toBe(3);
    expect(result.segments[1].frameCount).toBe(3);

    // The "between" frame should not show up in either segment's frame dir.
    const seg0FrameContents = readFileSync(
      join(outputDir, "segment-0-frames", "frame-000.png"),
      "utf8",
    );
    expect(seg0FrameContents).toContain("a1");
    const seg1FrameContents = readFileSync(
      join(outputDir, "segment-1-frames", "frame-000.png"),
      "utf8",
    );
    expect(seg1FrameContents).toContain("b1");
  });

  it("calls ffmpeg per segment + once for the final concat", async () => {
    const { timeline, frames } = makeTimeline();
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("grep Duration")) return "00:00:02.50";
      return "";
    });

    await renderTimeline({
      timeline,
      frames,
      outputDir,
      tts,
      exec,
      keepIntermediates: true,
    });

    const calls = exec.mock.calls.map((c) => c[0]);
    const probeCalls = calls.filter((c) => c.includes("grep Duration"));
    const encodeCalls = calls.filter(
      (c) => c.includes("-f concat") && c.includes("libx264"),
    );
    const concatCalls = calls.filter(
      (c) => c.includes("-f concat") && c.includes("-c copy"),
    );

    expect(probeCalls).toHaveLength(2);
    expect(encodeCalls).toHaveLength(2);
    expect(concatCalls).toHaveLength(1);
  });

  it("includes the even-dimension scale filter in encode commands", async () => {
    const { timeline, frames } = makeTimeline();
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("grep Duration")) return "00:00:02.50";
      return "";
    });

    await renderTimeline({
      timeline,
      frames,
      outputDir,
      tts,
      exec,
      keepIntermediates: true,
    });

    const encodeCmd = exec.mock.calls
      .map((c) => c[0])
      .find((c) => c.includes("libx264"));
    expect(encodeCmd).toContain("scale=trunc(iw/2)*2:trunc(ih/2)*2");
    expect(encodeCmd).toContain("-t 00:00:02.50");
  });

  it("produces a concat list with one entry per segment in order", async () => {
    const { timeline, frames } = makeTimeline();
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("grep Duration")) return "00:00:02.50";
      // Simulate ffmpeg writing the final mp4.
      const m = cmd.match(/-c copy "([^"]+)"/);
      if (m) writeFileSync(m[1], "fake mp4 data");
      return "";
    });

    await renderTimeline({
      timeline,
      frames,
      outputDir,
      tts,
      exec,
      keepIntermediates: true,
    });

    const segmentsList = readFileSync(
      join(outputDir, "segments.txt"),
      "utf8",
    );
    const lines = segmentsList.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/segment-0\.mp4/);
    expect(lines[1]).toMatch(/segment-1\.mp4/);
  });

  it("cleans up intermediates by default", async () => {
    const { timeline, frames } = makeTimeline();
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("grep Duration")) return "00:00:02.50";
      // Simulate ffmpeg writing each output mp4 it's asked to produce.
      const out = cmd.match(/"([^"]+\.mp4)"\s*$/);
      if (out) writeFileSync(out[1], "fake mp4 data");
      return "";
    });

    const result = await renderTimeline({
      timeline,
      frames,
      outputDir,
      tts,
      exec,
    });

    expect(existsSync(result.videoPath)).toBe(true);
    expect(existsSync(join(outputDir, "segment-0.mp4"))).toBe(false);
    expect(existsSync(join(outputDir, "audio-0.mp3"))).toBe(false);
    expect(existsSync(join(outputDir, "segment-0-frames"))).toBe(false);
    expect(existsSync(join(outputDir, "segments.txt"))).toBe(false);

    for (const s of result.segments) {
      expect(s.segmentVideoPath).toBeUndefined();
      expect(s.ttsAudioPath).toBeUndefined();
    }
  });

  it("keeps intermediates when keepIntermediates: true", async () => {
    const { timeline, frames } = makeTimeline();
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("grep Duration")) return "00:00:02.50";
      const out = cmd.match(/"([^"]+\.mp4)"\s*$/);
      if (out) writeFileSync(out[1], "fake mp4 data");
      return "";
    });

    const result = await renderTimeline({
      timeline,
      frames,
      outputDir,
      tts,
      exec,
      keepIntermediates: true,
    });

    expect(existsSync(join(outputDir, "segment-0.mp4"))).toBe(true);
    expect(existsSync(join(outputDir, "audio-0.mp3"))).toBe(true);
    expect(result.segments[0].segmentVideoPath).toBeDefined();
    expect(result.segments[0].ttsAudioPath).toBeDefined();
  });

  it("falls back to the most recent prior frame when a segment has no frames in its own window", async () => {
    // Action emitted no visual change inside [startTime, endTime] (e.g. a
    // scroll that didn't actually move anything). The segment should still
    // render using the most recent frame captured before startTime — the
    // narration plays over a freeze of the page's current state.
    const timeline: TimelineEntry[] = [
      {
        instruction: "first",
        narrative: "first narrative",
        startTime: 1000,
        endTime: 1100,
        frameCount: 1,
        segmentDuration: 0.1,
      },
      {
        instruction: "no-op scroll",
        narrative: "no visible change",
        startTime: 1200,
        endTime: 1300,
        frameCount: 0,
        segmentDuration: 0.1,
      },
    ];
    const frames: CapturedFrame[] = [
      { timestamp: 1050, data: Buffer.from("frame-A").toString("base64") },
      // No frames between 1200 and 1300.
    ];
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("grep Duration")) return "00:00:01.50";
      const out = cmd.match(/"([^"]+\.mp4)"\s*$/);
      if (out) writeFileSync(out[1], "fake mp4 data");
      return "";
    });

    const result = await renderTimeline({
      timeline,
      frames,
      outputDir,
      tts,
      exec,
      keepIntermediates: true,
    });

    expect(result.segments).toHaveLength(2);
    expect(result.segments[1].frameCount).toBe(1);

    // The fallback frame is the one captured at t=1050.
    const fallbackFrame = readFileSync(
      join(outputDir, "segment-1-frames", "frame-000.png"),
      "utf8",
    );
    expect(fallbackFrame).toBe("frame-A");
  });

  it("throws when there are no frames at all in the buffer", async () => {
    const timeline: TimelineEntry[] = [
      {
        instruction: "missing",
        narrative: "no frames captured",
        startTime: 5000,
        endTime: 5100,
        frameCount: 0,
        segmentDuration: 0.1,
      },
    ];
    const frames: CapturedFrame[] = [];

    await expect(
      renderTimeline({
        timeline,
        frames,
        outputDir,
        tts,
        exec: fakeExec([]),
      }),
    ).rejects.toThrow(/no frames available/);
  });

  it("throws if duration probe output is unparseable", async () => {
    const { timeline, frames } = makeTimeline();
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("grep Duration")) return "garbage output";
      return "";
    });

    await expect(
      renderTimeline({
        timeline,
        frames,
        outputDir,
        tts,
        exec,
      }),
    ).rejects.toThrow(/could not parse audio duration/);
  });

  it("throws when timeline is empty", async () => {
    await expect(
      renderTimeline({
        timeline: [],
        frames: [],
        outputDir,
        tts,
      }),
    ).rejects.toThrow(/timeline is empty/);
  });
});
