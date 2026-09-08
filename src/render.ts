import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import ffmpegPath from "ffmpeg-static";

import type { CapturedFrame, TimelineEntry } from "./timeline.js";
import { synthesize, type SpeechOptions } from "./speech.js";

/**
 * Result returned by the exec test seam (and by the default `spawnSync`-based
 * runner). Mirrors the spawn-result shape so a test can decide what to do based
 * on stdout, stderr, and exit status — same way the real implementation does.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

/**
 * Test seam for invoking ffmpeg. The default runs `spawnSync(bin, args)` with
 * no shell. Tests can pass a stub that records arguments and returns canned
 * output. Note: arguments are passed as an array — never a shell command
 * string — so user-supplied paths (outputDir, audio paths, etc.) cannot be
 * interpreted as shell metacharacters.
 */
export type ExecRunner = (
  bin: string,
  args: ReadonlyArray<string>,
) => ExecResult;

export interface RenderTimelineOptions {
  timeline: TimelineEntry[];
  frames: CapturedFrame[];
  /** Directory the final mp4 (and intermediates) are written to. Created if missing. */
  outputDir?: string;
  /**
   * Narration: an AI SDK speech model plus its options. Omit for a silent
   * track sized to each step's narration text.
   */
  speech?: SpeechOptions;
  /** Cancels in-flight speech synthesis. */
  signal?: AbortSignal;
  /**
   * If false (default), narration audio + per-segment mp4s + frame PNGs are deleted
   * after the final video is concatenated. Set true to inspect intermediates.
   */
  keepIntermediates?: boolean;
  /**
   * Path to an ffmpeg binary. Defaults to the one bundled by `ffmpeg-static`
   * (or `$FFMPEG_BIN`, which ffmpeg-static honours). Needs libx264 + aac.
   */
  ffmpegPath?: string;
  /** Test seam: override the runner used to invoke ffmpeg. */
  exec?: ExecRunner;
}

export interface RenderedSegment {
  /** The originating timeline entry. */
  entry: TimelineEntry;
  /** Path to the segment mp4 (relative to outputDir). */
  segmentVideoPath?: string;
  /** Path to the segment audio (relative to outputDir). */
  audioPath?: string;
  /** Number of frames actually included in the segment. */
  frameCount: number;
  /** Length of the rendered segment in seconds (video and padded audio alike). */
  renderedSeconds: number;
  /** Length of the narration audio before padding, in seconds. */
  narrationSeconds: number;
}

export interface RenderTimelineResult {
  videoPath: string;
  outputDir: string;
  segments: RenderedSegment[];
}

/**
 * Floor for the gap between two captured frames. Guards against zero-length
 * entries (two frames stamped in the same millisecond) without slowing real
 * motion: the stream is change-driven and can exceed 25 fps on animated pages,
 * so a floor anywhere near 100 ms would stretch a 30 fps second into three.
 */
const MIN_FRAME_DURATION = 0.02;
/** Ceiling for the gap between two captured frames (a long repaint-free wait). */
const MAX_FRAME_DURATION = 10;
/**
 * How long (s) the last frame is held past the end of the narration. Keeps the
 * final page state on screen briefly instead of cutting on the last syllable.
 */
const LAST_FRAME_TAIL = 0.25;

const defaultExec: ExecRunner = (bin, args) => {
  const r = spawnSync(bin, [...args], { encoding: "utf8" });
  if (r.error) throw r.error;
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status,
  };
};

/**
 * Run the per-segment + concat pipeline. Returns the path to the final mp4.
 *
 * Throws on any failure with the partial state attached as `error.partial`
 * so callers can inspect what was captured before the error.
 */
export async function renderTimeline(
  options: RenderTimelineOptions,
): Promise<RenderTimelineResult> {
  const ffmpeg = options.ffmpegPath ?? ffmpegPath;
  if (!ffmpeg) {
    throw new Error(
      "ffmpeg-static binary not found — install scripts may have been skipped. Run `pnpm approve-builds` (or equivalent) to allow ffmpeg-static to download its binary, or pass `ffmpegPath`.",
    );
  }

  if (options.timeline.length === 0) {
    throw new Error("renderTimeline: timeline is empty — nothing to render");
  }

  const outputDir = resolve(
    options.outputDir ??
      join(tmpdir(), "browser-automation-demos", randomUUID()),
  );
  mkdirSync(outputDir, { recursive: true });

  const exec: ExecRunner = options.exec ?? defaultExec;

  const partial: { segments: RenderedSegment[] } = { segments: [] };

  try {
    // Phase 1: parallel TTS + per-segment encoding.
    const segments = await Promise.all(
      options.timeline.map((entry, i) =>
        renderSegment({
          entry,
          index: i,
          frames: options.frames,
          outputDir,
          speech: options.speech,
          signal: options.signal,
          ffmpeg,
          exec,
        }),
      ),
    );

    partial.segments = segments;

    // Phase 2: concat — stream copy, no re-encode.
    //
    // The concat-demuxer file format wraps each path in single quotes and
    // resolves them as literal filenames (no shell). To handle paths that
    // legitimately contain a single quote, ffmpeg's documented escape is
    // closing the quote, inserting a backslashed quote, and reopening the
    // quote: 'foo'\''bar'. Apply that escape so the concat list is robust
    // even if the caller supplies an outputDir with quotes in it.
    const segmentListPath = join(outputDir, "segments.txt");
    writeFileSync(
      segmentListPath,
      segments
        .map((s) => `file '${escapeConcatPath(s.segmentVideoPath ?? "")}'`)
        .join("\n"),
    );

    const finalPath = join(outputDir, "final.mp4");
    runChecked(exec, ffmpeg, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      segmentListPath,
      "-c",
      "copy",
      finalPath,
    ]);

    if (!options.keepIntermediates) {
      cleanupIntermediates(outputDir, segments);
      // After cleanup, segment paths are gone — null them out in the result.
      for (const s of segments) {
        s.segmentVideoPath = undefined;
        s.audioPath = undefined;
      }
    }

    return {
      videoPath: finalPath,
      outputDir,
      segments,
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    (error as Error & { partial?: typeof partial }).partial = partial;
    throw error;
  }
}

interface SegmentInput {
  entry: TimelineEntry;
  index: number;
  frames: CapturedFrame[];
  outputDir: string;
  speech?: SpeechOptions;
  signal?: AbortSignal;
  ffmpeg: string;
  exec: ExecRunner;
}

async function renderSegment(input: SegmentInput): Promise<RenderedSegment> {
  const { entry, index, frames, outputDir, speech, signal, ffmpeg, exec } =
    input;

  // Filter frames to the entry's [startTime, endTime] window.
  let segmentFrames = frames.filter(
    (f) => f.timestamp >= entry.startTime && f.timestamp <= entry.endTime,
  );

  // Fallback: if the action caused no visible change, CDP emits no frames in
  // the segment's window. Hold the most recent frame captured before this
  // segment started — narration plays over a freeze of the current page state.
  if (segmentFrames.length === 0) {
    const prior = frames.filter((f) => f.timestamp < entry.startTime);
    if (prior.length > 0) {
      segmentFrames = [prior[prior.length - 1]];
    }
  }

  // Last resort: if there are no frames anywhere in the buffer, we can't
  // fabricate pixels — fail loudly so the caller knows the screencast never
  // produced anything.
  if (segmentFrames.length === 0) {
    throw new Error(
      `renderTimeline: no frames available for segment ${index} (${entry.instruction}). Buffer is empty before endTime ${entry.endTime}.`,
    );
  }

  // 1. Narrate (speech model, or silence sized to the text).
  const narration = await synthesize(
    entry.narrative,
    speech && entry.speech ? { ...speech, ...entry.speech } : speech,
    { signal },
  );
  const audioPath = join(outputDir, `audio-${index}.${narration.format}`);
  writeFileSync(audioPath, Buffer.from(narration.audio));

  // 2. Write frames as images into a per-segment subdir (extension follows
  //    the frame's encoding so ffmpeg's image2 demuxer picks the right decoder).
  const framesDir = join(outputDir, `segment-${index}-frames`);
  mkdirSync(framesDir, { recursive: true });
  const framePaths: string[] = [];
  for (let j = 0; j < segmentFrames.length; j++) {
    const ext = segmentFrames[j].format === "jpeg" ? "jpg" : "png";
    const framePath = join(
      framesDir,
      `frame-${j.toString().padStart(3, "0")}.${ext}`,
    );
    writeFileSync(framePath, Buffer.from(segmentFrames[j].data, "base64"));
    framePaths.push(framePath);
  }

  // 3. Probe the narration's duration.
  const audioSeconds = probeDurationSeconds(exec, ffmpeg, audioPath, index);

  // 4. Build the concat demuxer file with per-frame durations.
  //
  //    Frames are held until the next frame's timestamp; the last frame is
  //    held until the narration ends (plus a short tail), so the video is
  //    never shorter than the audio. Segment length is then max(video, audio):
  //    the encode below pads the audio with silence and stops at the video's
  //    end, so an action that outlasts its narration is shown to completion
  //    and a narration that outlasts its action plays over the final frame.
  //
  //    Quirk: the last frame must be repeated as a trailing `file` line for
  //    its duration to be honored. Gaps between captured frames are clamped;
  //    the last frame's hold is not (the narration can be as long as it
  //    likes) and is computed from the clamped video time actually laid down,
  //    so audio and video stay aligned however the clamps moved things.
  //
  //    Don't reach for `-t <audio duration>` here: ffmpeg 6 applies it against
  //    the concat input's timestamps before frames are duplicated to fill the
  //    holds, so it drops the trailing frame and the video ends early.
  const concatLines: string[] = [];
  let laidDown = 0; // seconds of video written so far, after clamping
  for (let j = 0; j < segmentFrames.length; j++) {
    let duration: number;
    if (j < segmentFrames.length - 1) {
      const gap =
        (segmentFrames[j + 1].timestamp - segmentFrames[j].timestamp) / 1000;
      duration = Math.max(
        MIN_FRAME_DURATION,
        Math.min(gap, MAX_FRAME_DURATION),
      );
    } else {
      duration = Math.max(
        LAST_FRAME_TAIL,
        audioSeconds - laidDown + LAST_FRAME_TAIL,
      );
    }
    laidDown += duration;
    concatLines.push(`file '${escapeConcatPath(framePaths[j])}'`);
    concatLines.push(`duration ${duration.toFixed(3)}`);
  }
  concatLines.push(
    `file '${escapeConcatPath(framePaths[framePaths.length - 1])}'`,
  );

  const concatFilePath = join(framesDir, "frames.txt");
  writeFileSync(concatFilePath, concatLines.join("\n"));

  // 5a. Encode the video track on its own from the concat list.
  //
  //     Two passes on purpose. The obvious single pass — video + narration in
  //     one encode with `apad` and `-shortest` to stop the padding at the
  //     video's end — depends on ffmpeg's "shortest" bookkeeping, which
  //     differs by build: ffmpeg-static's 6.0 (macOS) wrote zero audio
  //     packets and shipped a video-only mp4 with exit 0; its 7.0.2 (Linux)
  //     let the padded audio run seconds past the video. And the video's
  //     real length isn't `laidDown` either: the concat demuxer's trailing
  //     entry adds a fraction of a second that varies with the frame spacing.
  //     So: make the video, measure it, pad the audio to exactly that.
  const videoOnlyPath = join(framesDir, "video.mp4");
  runChecked(exec, ffmpeg, [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFilePath,
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-an",
    videoOnlyPath,
  ]);

  // 5b. Measure what ffmpeg actually produced.
  const videoSeconds = probeDurationSeconds(exec, ffmpeg, videoOnlyPath, index);

  // 5c. Mux: copy the video, pad the narration with silence to its length.
  //     `apad=whole_dur` is deterministic on every build; the streams end
  //     together without any "shortest" logic involved.
  const segmentPath = join(outputDir, `segment-${index}.mp4`);
  runChecked(exec, ffmpeg, [
    "-y",
    "-i",
    videoOnlyPath,
    "-i",
    audioPath,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    "-af",
    `apad=whole_dur=${videoSeconds.toFixed(3)}`,
    "-c:a",
    "aac",
    segmentPath,
  ]);

  return {
    entry,
    segmentVideoPath: segmentPath,
    audioPath: audioPath,
    frameCount: segmentFrames.length,
    renderedSeconds: videoSeconds,
    narrationSeconds: audioSeconds,
  };
}

/**
 * Duration of a media file in seconds. ffmpeg-static ships no ffprobe, so run
 * `ffmpeg -i <file>` (no output — exits non-zero by design) and parse the
 * `Duration: HH:MM:SS.ms` line from stderr in Node. No shell pipe: a
 * user-supplied path must never reach a shell.
 */
function probeDurationSeconds(
  exec: ExecRunner,
  ffmpeg: string,
  file: string,
  index: number,
): number {
  const probe = exec(ffmpeg, ["-i", file]);
  const m = probe.stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
  if (!m) {
    throw new Error(
      `renderTimeline: could not parse duration of ${file} from ffmpeg output for segment ${index}. stderr was: ${probe.stderr.slice(0, 500)}`,
    );
  }
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function runChecked(
  exec: ExecRunner,
  bin: string,
  args: ReadonlyArray<string>,
): ExecResult {
  const r = exec(bin, args);
  if (r.status !== 0 && r.status !== null) {
    throw new Error(
      `renderTimeline: ffmpeg exited with status ${r.status}. stderr was: ${r.stderr.slice(0, 1000)}`,
    );
  }
  return r;
}

function cleanupIntermediates(
  outputDir: string,
  segments: RenderedSegment[],
): void {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.segmentVideoPath && existsSync(s.segmentVideoPath)) {
      rmSync(s.segmentVideoPath, { force: true });
    }
    if (s.audioPath && existsSync(s.audioPath)) {
      rmSync(s.audioPath, { force: true });
    }
    const framesDir = join(outputDir, `segment-${i}-frames`);
    if (existsSync(framesDir)) {
      rmSync(framesDir, { recursive: true, force: true });
    }
  }
  const segmentsList = join(outputDir, "segments.txt");
  if (existsSync(segmentsList)) rmSync(segmentsList, { force: true });
}

/**
 * Escape a single path for use inside a single-quoted ffmpeg concat-demuxer
 * `file '<path>'` line. The concat parser only needs to handle the literal `'`
 * character — all other shell metacharacters are inert because the file is
 * read by ffmpeg directly, never by a shell.
 */
function escapeConcatPath(p: string): string {
  return p.replace(/'/g, "'\\''");
}
