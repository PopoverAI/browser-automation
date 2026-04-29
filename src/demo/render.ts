import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import ffmpegPath from "ffmpeg-static";

import type { CapturedFrame, TimelineEntry } from "./recorder.js";
import { createOpenAITTS, type TTSProvider } from "./tts.js";

export interface RenderTimelineOptions {
  timeline: TimelineEntry[];
  frames: CapturedFrame[];
  /** Directory the final mp4 (and intermediates) are written to. Created if missing. */
  outputDir?: string;
  /** TTS voice id (default `"alloy"`). Forwarded to the TTS provider verbatim. */
  voice?: string;
  /** TTS provider. Defaults to OpenAI gpt-4o-mini-tts via `OPENAI_API_KEY`. */
  tts?: TTSProvider;
  /**
   * If false (default), TTS audio + per-segment mp4s + frame PNGs are deleted
   * after the final video is concatenated. Set true to inspect intermediates.
   */
  keepIntermediates?: boolean;
  /** Test seam: override the exec runner used to invoke ffmpeg. */
  exec?: (cmd: string) => string;
}

export interface RenderedSegment {
  /** The originating timeline entry. */
  entry: TimelineEntry;
  /** Path to the segment mp4 (relative to outputDir). */
  segmentVideoPath?: string;
  /** Path to the segment audio (relative to outputDir). */
  ttsAudioPath?: string;
  /** Number of frames actually included in the segment. */
  frameCount: number;
}

export interface RenderTimelineResult {
  videoPath: string;
  outputDir: string;
  segments: RenderedSegment[];
}

const DEFAULT_VOICE = "alloy";
const MIN_FRAME_DURATION = 0.1;
const MAX_FRAME_DURATION = 10;
const FALLBACK_LAST_FRAME_DURATION = 5;

/**
 * Run the per-segment + concat pipeline. Returns the path to the final mp4.
 *
 * Throws on any failure with the partial state attached as `error.partial`
 * so callers can inspect what was captured before the error.
 */
export async function renderTimeline(
  options: RenderTimelineOptions,
): Promise<RenderTimelineResult> {
  if (!ffmpegPath) {
    throw new Error(
      "ffmpeg-static binary not found — install scripts may have been skipped. Run `pnpm approve-builds` (or equivalent) to allow ffmpeg-static to download its binary.",
    );
  }
  const ffmpeg = ffmpegPath;

  if (options.timeline.length === 0) {
    throw new Error("renderTimeline: timeline is empty — nothing to render");
  }

  const outputDir = resolve(
    options.outputDir ??
      join(tmpdir(), "browser-automation-demos", randomUUID()),
  );
  mkdirSync(outputDir, { recursive: true });

  const voice = options.voice ?? DEFAULT_VOICE;
  const tts = options.tts ?? createOpenAITTS();
  const exec = options.exec ?? ((cmd: string) =>
    execSync(cmd, { encoding: "utf8" }));

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
          voice,
          tts,
          ffmpeg,
          exec,
        }),
      ),
    );

    partial.segments = segments;

    // Phase 2: concat — stream copy, no re-encode.
    const segmentListPath = join(outputDir, "segments.txt");
    writeFileSync(
      segmentListPath,
      segments.map((s) => `file '${s.segmentVideoPath}'`).join("\n"),
    );

    const finalPath = join(outputDir, "final.mp4");
    exec(
      `${quote(ffmpeg)} -y -f concat -safe 0 -i ${quote(segmentListPath)} -c copy ${quote(finalPath)}`,
    );

    if (!options.keepIntermediates) {
      cleanupIntermediates(outputDir, segments);
      // After cleanup, segment paths are gone — null them out in the result.
      for (const s of segments) {
        s.segmentVideoPath = undefined;
        s.ttsAudioPath = undefined;
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
  voice: string;
  tts: TTSProvider;
  ffmpeg: string;
  exec: (cmd: string) => string;
}

async function renderSegment(input: SegmentInput): Promise<RenderedSegment> {
  const { entry, index, frames, outputDir, voice, tts, ffmpeg, exec } = input;

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

  // 1. Generate TTS.
  const speech = await tts.speak(entry.narrative, voice);
  const audioPath = join(outputDir, `audio-${index}.${speech.extension}`);
  writeFileSync(audioPath, Buffer.from(speech.audio));

  // 2. Write frames as PNGs into a per-segment subdir.
  const framesDir = join(outputDir, `segment-${index}-frames`);
  mkdirSync(framesDir, { recursive: true });
  const framePaths: string[] = [];
  for (let j = 0; j < segmentFrames.length; j++) {
    const framePath = join(
      framesDir,
      `frame-${j.toString().padStart(3, "0")}.png`,
    );
    writeFileSync(framePath, Buffer.from(segmentFrames[j].data, "base64"));
    framePaths.push(framePath);
  }

  // 3. Build the concat demuxer file with per-frame durations.
  //    Quirk: the last frame must be repeated as a trailing `file` line for
  //    its duration to be honored. Per-frame durations are clamped.
  const concatLines: string[] = [];
  for (let j = 0; j < segmentFrames.length; j++) {
    let duration: number;
    if (j < segmentFrames.length - 1) {
      duration =
        (segmentFrames[j + 1].timestamp - segmentFrames[j].timestamp) / 1000;
    } else {
      duration = FALLBACK_LAST_FRAME_DURATION;
    }
    duration = Math.max(MIN_FRAME_DURATION, Math.min(duration, MAX_FRAME_DURATION));
    concatLines.push(`file '${framePaths[j]}'`);
    concatLines.push(`duration ${duration.toFixed(3)}`);
  }
  concatLines.push(`file '${framePaths[framePaths.length - 1]}'`);

  const concatFilePath = join(framesDir, "frames.txt");
  writeFileSync(concatFilePath, concatLines.join("\n"));

  // 4. Probe audio duration. ffmpeg-static doesn't ship ffprobe, so we use
  //    the same shell-pipe approach the spike validated.
  const durationStr = exec(
    `${quote(ffmpeg)} -i ${quote(audioPath)} 2>&1 | grep Duration | cut -d ' ' -f 4 | cut -d ',' -f 1`,
  ).trim();
  if (!/^\d{2}:\d{2}:\d{2}/.test(durationStr)) {
    throw new Error(
      `renderTimeline: could not parse audio duration from ffmpeg output for segment ${index}: "${durationStr}"`,
    );
  }

  // 5. Encode the segment.
  const segmentPath = join(outputDir, `segment-${index}.mp4`);
  const cmd = [
    quote(ffmpeg),
    "-y",
    "-f concat",
    "-safe 0",
    `-i ${quote(concatFilePath)}`,
    `-i ${quote(audioPath)}`,
    "-map 0:v",
    "-map 1:a",
    `-vf "scale=trunc(iw/2)*2:trunc(ih/2)*2"`,
    "-c:v libx264",
    "-pix_fmt yuv420p",
    "-c:a aac",
    `-t ${durationStr}`,
    quote(segmentPath),
  ].join(" ");
  exec(cmd);

  return {
    entry,
    segmentVideoPath: segmentPath,
    ttsAudioPath: audioPath,
    frameCount: segmentFrames.length,
  };
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
    if (s.ttsAudioPath && existsSync(s.ttsAudioPath)) {
      rmSync(s.ttsAudioPath, { force: true });
    }
    const framesDir = join(outputDir, `segment-${i}-frames`);
    if (existsSync(framesDir)) {
      rmSync(framesDir, { recursive: true, force: true });
    }
  }
  const segmentsList = join(outputDir, "segments.txt");
  if (existsSync(segmentsList)) rmSync(segmentsList, { force: true });
}

function quote(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`;
}
