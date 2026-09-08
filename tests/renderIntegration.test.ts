import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ffmpegStaticPath from "ffmpeg-static";

import { renderTimeline } from "../src/render.js";
import { silentWav } from "../src/speech.js";
import type { CapturedFrame, TimelineEntry } from "../src/timeline.js";

/**
 * Real-ffmpeg encode. Runs wherever ffmpeg-static's binary is present (a dev
 * machine after `pnpm approve-builds`, or FFMPEG_BIN) and is skipped in CI,
 * which has no ffmpeg. It exists because the unit tests stub ffmpeg, and a
 * flag that ffmpeg accepted but that dropped the entire audio stream
 * (`-shortest` on ffmpeg-static 6.0) sailed through them.
 */
const ffmpeg =
  process.env.FFMPEG_BIN ??
  (ffmpegStaticPath && existsSync(ffmpegStaticPath)
    ? ffmpegStaticPath
    : undefined);

/** Probe with ffmpeg itself (ffmpeg-static ships no ffprobe): stream types + durations from `-i` stderr. */
function probe(
  bin: string,
  file: string,
): { streams: string[]; duration: number } {
  let stderr = "";
  try {
    execFileSync(bin, ["-i", file], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    stderr = String((e as { stderr?: Buffer }).stderr ?? "");
  }
  const streams = [
    ...stderr.matchAll(/Stream #\d+:\d+.*?: (Video|Audio):/g),
  ].map((m) => m[1]);
  const d = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
  const duration = d
    ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])
    : NaN;
  return { streams, duration };
}

/** Length of one stream, via a null decode of just that stream (ffmpeg reports progress on stderr). */
function streamSeconds(bin: string, file: string, map: "0:v" | "0:a"): number {
  let stderr = "";
  try {
    execFileSync(
      bin,
      ["-v", "info", "-i", file, "-map", map, "-f", "null", "-"],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
  } catch (e) {
    stderr = String((e as { stderr?: Buffer }).stderr ?? "");
  }
  if (!stderr) {
    // Success path: execFileSync only hands back stdout, so capture stderr explicitly.
    stderr = execFileSync("sh", [
      "-c",
      `"${bin}" -v info -i "${file}" -map ${map} -f null - 2>&1`,
    ]).toString();
  }
  const m = [...stderr.matchAll(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/g)].at(-1);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
}

describe.skipIf(!ffmpeg)("renderTimeline with a real ffmpeg", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "demo-render-real-"));
  afterAll(() => rmSync(outputDir, { recursive: true, force: true }));

  it("muxes an audio stream that ends where the video does", async () => {
    const bin = ffmpeg!;
    // Three distinct frames, 0.4 s apart, then a 3 s narration (silence, but
    // a real PCM stream — what matters is that it survives the mux).
    const framePaths = ["red", "green", "blue"].map((c, i) => {
      const p = join(outputDir, `src-${i}.png`);
      execFileSync(bin, [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=${c}:s=64x48`,
        "-frames:v",
        "1",
        p,
      ]);
      return p;
    });
    const frames: CapturedFrame[] = framePaths.map((p, i) => ({
      timestamp: 1000 + i * 400,
      data: readFileSync(p).toString("base64"),
    }));
    const entry: TimelineEntry = {
      instruction: "x",
      narrative: "three seconds of narration",
      startTime: 1000,
      endTime: 2200,
      frameCount: 3,
      segmentDuration: 1.2,
    };
    const narration = silentWav(3);
    const model = {
      specificationVersion: "v4" as const,
      provider: "test",
      modelId: "silence",
      doGenerate: async () => ({
        audio: narration,
        warnings: [],
        response: { timestamp: new Date(), modelId: "silence" },
      }),
    };

    const r = await renderTimeline({
      timeline: [entry],
      frames,
      outputDir,
      speech: { model },
      ffmpegPath: bin,
      keepIntermediates: true,
    });

    // Both streams present in the segment and in the final concat.
    for (const file of [r.segments[0].segmentVideoPath!, r.videoPath]) {
      const p = probe(bin, file);
      expect(p.streams.sort()).toEqual(["Audio", "Video"]);
    }
    // The video covers at least what was laid down (0.8 s of gaps + hold to
    // the 3 s narration + 0.25 s tail; the concat demuxer's trailing entry
    // may add a fraction), and the padded audio ends where the video does —
    // neither dropped nor overrun.
    const seg = r.segments[0];
    expect(seg.renderedSeconds).toBeGreaterThanOrEqual(3.25 - 0.05);
    expect(seg.narrationSeconds).toBeCloseTo(3, 1);
    const v = streamSeconds(bin, seg.segmentVideoPath!, "0:v");
    const a = streamSeconds(bin, seg.segmentVideoPath!, "0:a");
    expect(Math.abs(v - seg.renderedSeconds)).toBeLessThan(0.15);
    expect(Math.abs(a - v)).toBeLessThan(0.15);
  });
});
