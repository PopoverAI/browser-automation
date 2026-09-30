import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import ffmpegPath from "ffmpeg-static";
import {
	type SpeechOptions,
	type SynthesizedAudio,
	stepSpeech,
	synthesize,
} from "./speech.js";
import type { CapturedFrame, TimelineEntry } from "./timeline.js";

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
	/**
	 * Narration already synthesised, by timeline index; the rest is
	 * synthesised here. Lets a caller narrate a line before recording (to
	 * find out early that the voice works) without paying for it twice.
	 */
	narration?: ReadonlyArray<SynthesizedAudio | undefined>;
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
	/**
	 * Where this segment begins in the final video, in seconds: the time of
	 * its first frame there, rounded up to the millisecond so that seeking to
	 * it shows that frame rather than the previous segment's last one.
	 * Measured from the final file; see `segmentStarts`.
	 */
	startSeconds: number;
}

/** A segment as `renderSegment` leaves it, before the join places it in the final video. */
type EncodedSegment = Omit<RenderedSegment, "startSeconds">;

export interface RenderTimelineResult {
	videoPath: string;
	outputDir: string;
	/** Length of the final video in seconds, as ffmpeg reads the file. */
	durationSeconds: number;
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
	// The buffer is sized for `videoPackets`, which prints a line (~60 bytes)
	// per frame: spawnSync's 1 MB default would stop at about ten minutes.
	const r = spawnSync(bin, [...args], {
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
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

	const partial: { segments: EncodedSegment[] } = { segments: [] };

	try {
		// Every segment is encoded at one frame size, so the stream-copy concat
		// below joins like with like. See `videoCanvas`.
		const segmentFrames = options.timeline.map((entry, i) =>
			selectSegmentFrames(entry, i, options.frames),
		);
		const canvas = videoCanvas(segmentFrames.flat());

		// Phase 1: parallel TTS + per-segment encoding.
		const encoded = await Promise.all(
			options.timeline.map((entry, i) =>
				renderSegment({
					entry,
					index: i,
					segmentFrames: segmentFrames[i],
					canvas,
					outputDir,
					speech: options.speech,
					narration: options.narration?.[i],
					signal: options.signal,
					ffmpeg,
					exec,
				}),
			),
		);

		partial.segments = encoded;

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
			encoded
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
		const durationSeconds = probeDurationSeconds(exec, ffmpeg, finalPath);
		const starts = segmentStarts(
			exec,
			ffmpeg,
			encoded.map((s) => s.segmentVideoPath ?? ""),
			finalPath,
		);
		const segments: RenderedSegment[] = encoded.map((s, i) => ({
			...s,
			startSeconds: starts[i],
		}));

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
			durationSeconds,
			segments,
		};
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		(error as Error & { partial?: typeof partial }).partial = partial;
		throw error;
	}
}

/**
 * The frames shown for one timeline entry: those stamped inside its
 * [startTime, endTime] window.
 *
 * An entry with none holds the most recent frame captured before it, so its
 * narration plays over the page as it last looked. The agent-browser
 * recorder never produces such an entry — for a step that brought no frames
 * it checks the stream is still live and fails the recording if it is not —
 * so this serves callers that build their own timeline.
 */
function selectSegmentFrames(
	entry: TimelineEntry,
	index: number,
	frames: CapturedFrame[],
): CapturedFrame[] {
	const inWindow = frames.filter(
		(f) => f.timestamp >= entry.startTime && f.timestamp <= entry.endTime,
	);
	if (inWindow.length > 0) return inWindow;
	const prior = frames.filter((f) => f.timestamp < entry.startTime);
	if (prior.length > 0) return [prior[prior.length - 1]];
	// No frames anywhere before this entry: we can't fabricate pixels.
	throw new Error(
		`renderTimeline: no frames available for segment ${index} (${entry.instruction}). Buffer is empty before endTime ${entry.endTime}.`,
	);
}

/** Width × height, in pixels. */
interface Size {
	width: number;
	height: number;
}

/**
 * The one frame size every segment is encoded at: the widest and the tallest
 * frame shown, rounded up to even numbers for yuv420p.
 *
 * Frames change size when the viewport does (`set viewport` mid-recording, a
 * desktop flow followed by a phone one). Segments encoded at their own frames'
 * sizes then differ, and the final concat copies them into one stream without
 * re-encoding. QuickTime, Safari and anything else built on AVFoundation
 * cannot decode past the size change, so the player holds the last frame
 * before it for the rest of the video. Frames smaller than the canvas are
 * scaled to fit and centred on black.
 *
 * Undefined when no frame's size can be read (image data this module does not
 * recognise); each frame is then encoded at its own size.
 */
function videoCanvas(frames: CapturedFrame[]): Size | undefined {
	let width = 0;
	let height = 0;
	for (const f of frames) {
		const size = imageSize(Buffer.from(f.data, "base64"));
		if (!size) continue;
		width = Math.max(width, size.width);
		height = Math.max(height, size.height);
	}
	if (width === 0 || height === 0) return undefined;
	return { width: width + (width % 2), height: height + (height % 2) };
}

/** Pixel size of a PNG or JPEG, read from its header; undefined for anything else. */
function imageSize(buf: Buffer): Size | undefined {
	// PNG: an 8-byte signature, then the IHDR chunk's width and height.
	if (
		buf.length >= 24 &&
		buf.readUInt32BE(0) === 0x89504e47 &&
		buf.toString("latin1", 12, 16) === "IHDR"
	) {
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	}
	// JPEG: walk the marker segments to the first start-of-frame.
	if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
	let i = 2;
	while (i + 3 < buf.length) {
		if (buf[i] !== 0xff) return undefined;
		const marker = buf[i + 1];
		if (marker === 0xff) {
			i++; // fill byte
			continue;
		}
		// SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
		const isStartOfFrame =
			marker >= 0xc0 &&
			marker <= 0xcf &&
			marker !== 0xc4 &&
			marker !== 0xc8 &&
			marker !== 0xcc;
		if (isStartOfFrame) {
			if (i + 8 >= buf.length) return undefined;
			return {
				width: buf.readUInt16BE(i + 7),
				height: buf.readUInt16BE(i + 5),
			};
		}
		// Markers that carry no length field.
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			i += 2;
			continue;
		}
		i += 2 + buf.readUInt16BE(i + 2);
	}
	return undefined;
}

/** The ffmpeg video filter that puts a frame of any size onto the canvas. */
function canvasFilter(canvas: Size | undefined): string {
	if (!canvas) return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
	const { width: w, height: h } = canvas;
	return [
		`scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
		`pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
		"setsar=1",
	].join(",");
}

interface SegmentInput {
	entry: TimelineEntry;
	index: number;
	segmentFrames: CapturedFrame[];
	canvas: Size | undefined;
	outputDir: string;
	speech?: SpeechOptions;
	narration?: SynthesizedAudio;
	signal?: AbortSignal;
	ffmpeg: string;
	exec: ExecRunner;
}

async function renderSegment(input: SegmentInput): Promise<EncodedSegment> {
	const {
		entry,
		index,
		segmentFrames,
		canvas,
		outputDir,
		speech,
		narration: premade,
		signal,
		ffmpeg,
		exec,
	} = input;

	// 1. Narrate (speech model, or silence sized to the text).
	const narration =
		premade ??
		(await synthesize(entry.narrative, stepSpeech(speech, entry.speech), {
			signal,
		}));
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
	const audioSeconds = probeDurationSeconds(
		exec,
		ffmpeg,
		audioPath,
		`segment ${index}`,
	);

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
		canvasFilter(canvas),
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-an",
		videoOnlyPath,
	]);

	// 5b. Measure what ffmpeg actually produced.
	const videoSeconds = probeDurationSeconds(
		exec,
		ffmpeg,
		videoOnlyPath,
		`segment ${index}`,
	);

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
	/** What the file is, for the error message. */
	label = "the final video",
): number {
	const probe = exec(ffmpeg, ["-i", file]);
	const m = probe.stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
	if (!m) {
		throw new Error(
			`renderTimeline: could not parse duration of ${file} from ffmpeg output for ${label}. stderr was: ${probe.stderr.slice(0, 500)}`,
		);
	}
	return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Where each segment begins in the final video, in seconds, rounded up to the
 * millisecond.
 *
 * Measured from the final file, because the join does not lay the segments
 * end to end at zero. Each segment's AAC narration opens with encoder priming
 * stamped before zero, and the mp4 muxer shifts the whole joined file later
 * to keep its timestamps non-negative: with 24 kHz narration every segment's
 * first frame lands 42 ms after the lengths of the segments before it add up
 * to, and the final video is 42 ms longer than their sum. Seeking to the sum
 * would show the previous step's last frame.
 *
 * The final video stream is a packet-for-packet copy of the segments' video
 * streams, in order. So segment i owns the final's packets that follow the
 * ones the segments before it contributed, and it begins at the earliest
 * presentation time among them.
 */
function segmentStarts(
	exec: ExecRunner,
	ffmpeg: string,
	segmentPaths: ReadonlyArray<string>,
	finalPath: string,
): number[] {
	const final = videoPackets(exec, ffmpeg, finalPath);
	const counts = segmentPaths.map((p) => videoPackets(exec, ffmpeg, p).length);
	const total = counts.reduce((a, b) => a + b, 0);
	if (total !== final.length) {
		throw new Error(
			`renderTimeline: the final video has ${final.length} video packets but its segments have ${total}, so where each segment starts cannot be measured.`,
		);
	}
	const starts: number[] = [];
	let first = 0;
	for (const count of counts) {
		// A loop, not Math.min(...slice): spreading a long step's packets
		// would pass the engine's argument limit.
		let pts = Number.POSITIVE_INFINITY;
		for (let i = first; i < first + count; i++) pts = Math.min(pts, final[i]);
		// Up to the next millisecond; the epsilon keeps an exact millisecond
		// from rounding past itself through floating-point error, and max()
		// turns the -0 that rounding a zero start gives into 0.
		starts.push(Math.max(0, Math.ceil(pts * 1000 - 1e-6) / 1000));
		first += count;
	}
	return starts;
}

/**
 * Presentation times (s) of a file's video packets, in decode order. Lists
 * the packets with the `framecrc` muxer over a stream copy, so nothing is
 * decoded: one line per packet, `stream, dts, pts, duration, size, crc`, in
 * the time base its `#tb` header gives.
 */
function videoPackets(
	exec: ExecRunner,
	ffmpeg: string,
	file: string,
): number[] {
	const r = runChecked(exec, ffmpeg, [
		"-v",
		"error",
		"-i",
		file,
		"-map",
		"0:v:0",
		"-c",
		"copy",
		"-f",
		"framecrc",
		"-",
	]);
	const tb = r.stdout.match(/^#tb 0: (\d+)\/(\d+)\s*$/m);
	if (!tb) {
		throw new Error(
			`renderTimeline: could not list the video packets of ${file}: no time base in ffmpeg's framecrc output. stdout was: ${r.stdout.slice(0, 500)}`,
		);
	}
	const seconds = Number(tb[1]) / Number(tb[2]);
	const pts: number[] = [];
	for (const line of r.stdout.split("\n")) {
		if (line.startsWith("#") || line.trim() === "") continue;
		pts.push(Number(line.split(",")[2]) * seconds);
	}
	return pts;
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
