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

import { renderTimeline } from "../src/render.js";
import type { ExecResult, ExecRunner } from "../src/render.js";
import type { SpeechModel } from "ai";
import { MockSpeechModelV4 } from "ai/test";

type SpeechModelV4Like = Extract<SpeechModel, { specificationVersion: "v4" }>;

import type { SpeechOptions } from "../src/speech.js";
import type { CapturedFrame, TimelineEntry } from "../src/timeline.js";

function makeTimeline(): {
  timeline: TimelineEntry[];
  frames: CapturedFrame[];
} {
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
    f(1150, "between"),
    f(1210, "b1"),
    f(1250, "b2"),
    f(1290, "b3"),
  ];

  return { timeline: [entry1, entry2], frames };
}

const PROBE_STDERR =
  "ffmpeg version blah\n  Duration: 00:00:02.50, start: 0.000000, bitrate: 32 kb/s\n  Stream #0:0\n";

/**
 * A reasonable default exec stub: probe calls (`-i path`, no output) return
 * stderr with a Duration line; encode/concat calls return status 0 and write
 * a placeholder mp4 to whatever output path appears last in the args.
 */
function makeDefaultExec(): {
  exec: ExecRunner & {
    mock: { calls: Array<[string, ReadonlyArray<string>]> };
  };
} {
  const calls: Array<[string, ReadonlyArray<string>]> = [];
  const fn = (bin: string, args: ReadonlyArray<string>): ExecResult => {
    calls.push([bin, args]);
    const isProbe = args.length === 2 && args[0] === "-i";
    if (isProbe) {
      return { stdout: "", stderr: PROBE_STDERR, status: 1 };
    }
    // For encode/concat: pretend ffmpeg succeeded and create the output file
    // (concat-list lookups depend on it existing).
    const last = args[args.length - 1];
    if (last && last.endsWith(".mp4")) {
      writeFileSync(last, "fake mp4 data");
    }
    return { stdout: "", stderr: "", status: 0 };
  };
  Object.defineProperty(fn, "mock", { value: { calls } });
  return {
    exec: fn as unknown as ExecRunner & {
      mock: { calls: Array<[string, ReadonlyArray<string>]> };
    },
  };
}

describe("renderTimeline", () => {
  let outputDir: string;
  let doGenerate: ReturnType<typeof vi.fn<SpeechModelV4Like["doGenerate"]>>;
  let speech: SpeechOptions;

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), "demo-render-test-"));
    doGenerate = vi.fn<SpeechModelV4Like["doGenerate"]>(async ({ text }) => ({
      audio: new Uint8Array(Buffer.from(`audio-for-${text}`)),
      warnings: [],
      response: { timestamp: new Date(), modelId: "mock" },
    }));
    speech = {
      model: new MockSpeechModelV4({ doGenerate }),
      voice: "test-voice",
    };
  });

  afterEach(() => {
    if (existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("synthesises narration for each timeline entry through the speech model", async () => {
    const { timeline, frames } = makeTimeline();
    const { exec } = makeDefaultExec();

    await renderTimeline({
      timeline,
      frames,
      outputDir,
      speech,
      exec,
      keepIntermediates: true,
    });

    expect(doGenerate).toHaveBeenCalledTimes(2);
    const texts = doGenerate.mock.calls.map((c) => c[0].text);
    expect(texts).toEqual(["navigating to login", "submitting the form"]);
    // Render-level options reach the model; the default output format is mp3.
    expect(doGenerate.mock.calls[0][0]).toMatchObject({
      voice: "test-voice",
      outputFormat: "mp3",
    });
  });

  it("merges per-entry speech overrides over the render's speech options", async () => {
    const { timeline, frames } = makeTimeline();
    const { exec } = makeDefaultExec();
    timeline[1] = {
      ...timeline[1],
      speech: { voice: "other", language: "es" },
    };

    await renderTimeline({ timeline, frames, outputDir, speech, exec });

    expect(doGenerate.mock.calls[0][0]).toMatchObject({ voice: "test-voice" });
    expect(doGenerate.mock.calls[1][0]).toMatchObject({
      voice: "other",
      language: "es",
    });
  });

  it("renders a silent wav track when no speech is configured", async () => {
    const { timeline, frames } = makeTimeline();
    const { exec } = makeDefaultExec();

    const result = await renderTimeline({
      timeline,
      frames,
      outputDir,
      exec,
      keepIntermediates: true,
    });

    const wav = readFileSync(join(outputDir, "audio-0.wav"));
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(result.segments[0].audioPath).toMatch(/audio-0\.wav$/);
  });

  it("filters frames to each entry's [startTime, endTime] window", async () => {
    const { timeline, frames } = makeTimeline();
    const { exec } = makeDefaultExec();

    const result = await renderTimeline({
      timeline,
      frames,
      outputDir,
      speech,
      exec,
      keepIntermediates: true,
    });

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].frameCount).toBe(3);
    expect(result.segments[1].frameCount).toBe(3);

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
    const { exec } = makeDefaultExec();

    await renderTimeline({
      timeline,
      frames,
      outputDir,
      speech,
      exec,
      keepIntermediates: true,
    });

    const calls = exec.mock.calls;
    const probeCalls = calls.filter(
      ([, args]) => args.length === 2 && args[0] === "-i",
    );
    const encodeCalls = calls.filter(([, args]) => args.includes("libx264"));
    const concatCalls = calls.filter(
      ([, args]) =>
        args.includes("concat") &&
        args.includes("copy") &&
        !args.includes("libx264"),
    );

    expect(probeCalls).toHaveLength(2);
    expect(encodeCalls).toHaveLength(2);
    expect(concatCalls).toHaveLength(1);
  });

  it("includes the even-dimension scale filter in encode commands", async () => {
    const { timeline, frames } = makeTimeline();
    const { exec } = makeDefaultExec();

    await renderTimeline({
      timeline,
      frames,
      outputDir,
      speech,
      exec,
      keepIntermediates: true,
    });

    const encodeCall = exec.mock.calls.find(([, args]) =>
      args.includes("libx264"),
    );
    expect(encodeCall).toBeDefined();
    const encodeArgs = encodeCall![1] as ReadonlyArray<string>;
    expect(encodeArgs).toContain("scale=trunc(iw/2)*2:trunc(ih/2)*2");
    // Segment length is max(video, audio): audio is padded and the encode
    // stops at the video's end, whose last frame is held to the audio length.
    expect(encodeArgs).toContain("apad");
    expect(encodeArgs).toContain("-shortest");
    expect(encodeArgs).not.toContain("-t");
  });

  it("holds the last frame until the narration ends (plus a short tail)", async () => {
    const { timeline, frames } = makeTimeline();
    const { exec } = makeDefaultExec();
    const outputDir = mkdtempSync(join(tmpdir(), "demo-render-hold-"));
    try {
      await renderTimeline({
        timeline: [timeline[0]],
        frames,
        outputDir,
        speech,
        exec,
        keepIntermediates: true,
      });
      const list = readFileSync(
        join(outputDir, "segment-0-frames", "frames.txt"),
        "utf8",
      );
      const durations = [...list.matchAll(/duration ([\d.]+)/g)].map((m) =>
        Number(m[1]),
      );
      // Frames at 1010/1050/1090: two 0.1s (clamped from 0.04) holds, then the
      // last frame runs to the 2.5s narration end: 2.5 - 0.08 + 0.25.
      expect(durations).toHaveLength(3);
      expect(durations[0]).toBeCloseTo(0.1, 3);
      expect(durations[1]).toBeCloseTo(0.1, 3);
      expect(durations[2]).toBeCloseTo(2.67, 3);
      // Trailing repeated file line so the last duration is honored.
      expect(list.trim().endsWith("frame-002.png'")).toBe(true);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("produces a concat list with one entry per segment in order", async () => {
    const { timeline, frames } = makeTimeline();
    const { exec } = makeDefaultExec();

    await renderTimeline({
      timeline,
      frames,
      outputDir,
      speech,
      exec,
      keepIntermediates: true,
    });

    const segmentsList = readFileSync(join(outputDir, "segments.txt"), "utf8");
    const lines = segmentsList.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/segment-0\.mp4/);
    expect(lines[1]).toMatch(/segment-1\.mp4/);
  });

  it("never invokes the exec runner with a shell command string (no shell)", async () => {
    // Regression test for the shell-injection vector: outputDir flows in from
    // the caller and used to be interpolated into a shell command. The exec
    // contract is now (bin, args) — verify every invocation passes args as an
    // array and the binary as a separate string. Shell metacharacters in any
    // input must be treated as literal path bytes by ffmpeg.
    const { timeline, frames } = makeTimeline();
    const { exec } = makeDefaultExec();
    const trickySubdir = `weird $(touch /tmp/PWNED) 'and"quotes`;
    const trickyDir = join(outputDir, trickySubdir);

    await renderTimeline({
      timeline,
      frames,
      outputDir: trickyDir,
      speech,
      exec,
      keepIntermediates: true,
    });

    expect(exec.mock.calls.length).toBeGreaterThan(0);
    for (const [bin, args] of exec.mock.calls) {
      expect(typeof bin).toBe("string");
      expect(Array.isArray(args)).toBe(true);
      // The dangerous metacharacters appear (literally) inside individual args
      // but never as their own command tokens.
      expect(args).not.toContain("touch");
      expect(args).not.toContain("/tmp/PWNED");
    }
    // And the dangerous side effect did not happen.
    expect(existsSync("/tmp/PWNED")).toBe(false);
  });

  it("escapes single quotes in concat-demuxer paths", async () => {
    // ffmpeg's concat demuxer wraps each path in single quotes. If a path
    // legitimately contains a single quote, the documented escape is
    // 'foo'\''bar'. Ensure we apply it so an outputDir containing a quote
    // doesn't produce an invalid concat file.
    const { timeline, frames } = makeTimeline();
    const { exec } = makeDefaultExec();
    const trickyDir = join(outputDir, "with'quote");

    await renderTimeline({
      timeline,
      frames,
      outputDir: trickyDir,
      speech,
      exec,
      keepIntermediates: true,
    });

    const list = readFileSync(join(trickyDir, "segments.txt"), "utf8");
    // Each line should still wrap the path in single quotes and use the
    // documented '\'' escape. No bare single quotes inside the path region.
    for (const line of list.split("\n")) {
      // The pattern `file 'PATH'` plus optional escaped-quote sequences inside.
      expect(line.startsWith("file '")).toBe(true);
      expect(line.endsWith("'")).toBe(true);
      expect(line).toContain("'\\''");
    }
  });

  it("falls back to the most recent prior frame when a segment has no frames in its own window", async () => {
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
    ];
    const { exec } = makeDefaultExec();

    const result = await renderTimeline({
      timeline,
      frames,
      outputDir,
      speech,
      exec,
      keepIntermediates: true,
    });

    expect(result.segments).toHaveLength(2);
    expect(result.segments[1].frameCount).toBe(1);

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
    const { exec } = makeDefaultExec();

    await expect(
      renderTimeline({
        timeline,
        frames,
        outputDir,
        speech,
        exec,
      }),
    ).rejects.toThrow(/no frames available/);
  });

  it("cleans up intermediates by default", async () => {
    const { timeline, frames } = makeTimeline();
    const { exec } = makeDefaultExec();

    const result = await renderTimeline({
      timeline,
      frames,
      outputDir,
      speech,
      exec,
    });

    expect(existsSync(result.videoPath)).toBe(true);
    expect(existsSync(join(outputDir, "segment-0.mp4"))).toBe(false);
    expect(existsSync(join(outputDir, "audio-0.mp3"))).toBe(false);
    expect(existsSync(join(outputDir, "segment-0-frames"))).toBe(false);
    expect(existsSync(join(outputDir, "segments.txt"))).toBe(false);

    for (const s of result.segments) {
      expect(s.segmentVideoPath).toBeUndefined();
      expect(s.audioPath).toBeUndefined();
    }
  });

  it("keeps intermediates when keepIntermediates: true", async () => {
    const { timeline, frames } = makeTimeline();
    const { exec } = makeDefaultExec();

    const result = await renderTimeline({
      timeline,
      frames,
      outputDir,
      speech,
      exec,
      keepIntermediates: true,
    });

    expect(existsSync(join(outputDir, "segment-0.mp4"))).toBe(true);
    expect(existsSync(join(outputDir, "audio-0.mp3"))).toBe(true);
    expect(result.segments[0].segmentVideoPath).toBeDefined();
    expect(result.segments[0].audioPath).toBeDefined();
  });

  it("throws if the duration probe stderr has no Duration line", async () => {
    const { timeline, frames } = makeTimeline();
    const exec: ExecRunner = (_bin, args) => {
      const isProbe = args.length === 2 && args[0] === "-i";
      if (isProbe) return { stdout: "", stderr: "garbage output", status: 1 };
      return { stdout: "", stderr: "", status: 0 };
    };

    await expect(
      renderTimeline({ timeline, frames, outputDir, speech, exec }),
    ).rejects.toThrow(/could not parse audio duration/);
  });

  it("throws when timeline is empty", async () => {
    await expect(
      renderTimeline({
        timeline: [],
        frames: [],
        outputDir,
        speech,
      }),
    ).rejects.toThrow(/timeline is empty/);
  });

  it("throws if ffmpeg encode exits non-zero", async () => {
    const { timeline, frames } = makeTimeline();
    const exec: ExecRunner = (_bin, args) => {
      const isProbe = args.length === 2 && args[0] === "-i";
      if (isProbe) return { stdout: "", stderr: PROBE_STDERR, status: 1 };
      // Encode call: simulate failure.
      return {
        stdout: "",
        stderr: "Conversion failed!",
        status: 1,
      };
    };

    await expect(
      renderTimeline({ timeline, frames, outputDir, speech, exec }),
    ).rejects.toThrow(/ffmpeg exited with status 1/);
  });
});

describe("renderTimeline frame encodings", () => {
  it("writes jpeg frames with a .jpg extension and png frames with .png", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "demo-render-fmt-"));
    const seen: string[][] = [];
    const exec: ExecRunner = (_bin, args) => {
      seen.push([...args]);
      // Probe (`-i audio`, no output): return a duration line.
      if (args.length === 2 && args[0] === "-i") {
        return { stdout: "", stderr: PROBE_STDERR, status: 1 };
      }
      const out = args[args.length - 1];
      writeFileSync(out, "fake");
      return { stdout: "", stderr: "", status: 0 };
    };
    const speech: SpeechOptions = {
      model: new MockSpeechModelV4({
        doGenerate: async () => ({
          audio: new Uint8Array([1, 2, 3]),
          warnings: [],
          response: { timestamp: new Date(), modelId: "mock" },
        }),
      }),
    };
    const entry: TimelineEntry = {
      instruction: "x",
      narrative: "y",
      startTime: 1000,
      endTime: 1100,
      frameCount: 2,
      segmentDuration: 0.1,
    };
    const frames: CapturedFrame[] = [
      {
        timestamp: 1010,
        data: Buffer.from("j").toString("base64"),
        format: "jpeg",
      },
      { timestamp: 1050, data: Buffer.from("p").toString("base64") },
    ];
    try {
      await renderTimeline({
        timeline: [entry],
        frames,
        outputDir,
        speech,
        exec,
        keepIntermediates: true,
        ffmpegPath: "/fake/ffmpeg",
      });
      const list = readFileSync(
        join(outputDir, "segment-0-frames", "frames.txt"),
        "utf8",
      );
      expect(list).toMatch(/frame-000\.jpg/);
      expect(list).toMatch(/frame-001\.png/);
      expect(
        existsSync(join(outputDir, "segment-0-frames", "frame-000.jpg")),
      ).toBe(true);
      expect(
        existsSync(join(outputDir, "segment-0-frames", "frame-001.png")),
      ).toBe(true);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
