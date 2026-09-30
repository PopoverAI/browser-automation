import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SpeechModel } from "ai";
import { MockSpeechModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecResult, ExecRunner } from "../src/render.js";
import { renderTimeline } from "../src/render.js";

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

/** The header of a PNG of the given size — all the renderer reads of a frame. */
function png(width: number, height: number): string {
	const b = Buffer.alloc(24);
	b.writeUInt32BE(0x89504e47, 0);
	b.writeUInt32BE(0x0d0a1a0a, 4);
	b.writeUInt32BE(13, 8);
	b.write("IHDR", 12, "latin1");
	b.writeUInt32BE(width, 16);
	b.writeUInt32BE(height, 20);
	return b.toString("base64");
}

/** The start of a baseline JPEG of the given size: SOI, an APP0 segment, then SOF0. */
function jpeg(width: number, height: number): string {
	const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
	const sof0 = Buffer.alloc(19);
	sof0.writeUInt16BE(0xffc0, 0);
	sof0.writeUInt16BE(17, 2);
	sof0[4] = 8; // precision
	sof0.writeUInt16BE(height, 5);
	sof0.writeUInt16BE(width, 7);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]).toString(
		"base64",
	);
}

const PROBE_STDERR =
	"ffmpeg version blah\n  Duration: 00:00:02.50, start: 0.000000, bitrate: 32 kb/s\n  Stream #0:0\n";

/** Video packets the framecrc stub gives segment `i`: 3, 5, 7, … */
const packetsIn = (i: number) => 3 + 2 * i;
/** One frame at 25 fps, in the 1/12800 time base ffmpeg's mp4 muxer uses. */
const FRAME_TICKS = 512;
/**
 * How far the stub's final video starts its first frame from zero: 538
 * ticks, the 42 ms a real join adds for 24 kHz AAC priming.
 */
const FINAL_SHIFT_TICKS = 538;

/**
 * `ffmpeg … -f framecrc -` over a file's video stream, as real ffmpeg prints
 * it: a `#tb` header, then one `stream, dts, pts, duration, size, crc` line
 * per packet in decode order. Pts run out of order, as B-frames make them.
 * `segment-<i>.mp4` has `packetsIn(i)` packets from zero; `final.mp4` has
 * every segment's in the order its `segments.txt` lists them, shifted by
 * `FINAL_SHIFT_TICKS`. Undefined for any other call.
 */
function framecrc(
	args: ReadonlyArray<string>,
	finalShift = FINAL_SHIFT_TICKS,
): ExecResult | undefined {
	if (!args.includes("framecrc")) return undefined;
	const input = args[args.indexOf("-i") + 1];
	const segments = input.endsWith("final.mp4")
		? readFileSync(join(dirname(input), "segments.txt"), "utf8")
				.split("\n")
				.map((line) => Number(line.match(/segment-(\d+)\.mp4/)?.[1]))
		: [Number(input.match(/segment-(\d+)\.mp4$/)?.[1])];
	const shift = input.endsWith("final.mp4") ? finalShift : 0;
	const lines = ["#software: Lavf60.3.100", "#tb 0: 1/12800"];
	let first = shift;
	for (const i of segments) {
		const n = packetsIn(i);
		// Decode order: frame 0, then each later pair with its second shown first.
		const order = [0];
		for (let k = 1; k < n; k += 2)
			order.push(...(k + 1 < n ? [k + 1, k] : [k]));
		for (const k of order) {
			const pts = first + k * FRAME_TICKS;
			lines.push(`0, ${pts - FRAME_TICKS}, ${pts}, ${FRAME_TICKS}, 13, 0x0`);
		}
		first += n * FRAME_TICKS;
	}
	return { stdout: `${lines.join("\n")}\n`, stderr: "", status: 0 };
}

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
		const listing = framecrc(args);
		if (listing) return listing;
		const isProbe = args.length === 2 && args[0] === "-i";
		if (isProbe) {
			return { stdout: "", stderr: PROBE_STDERR, status: 1 };
		}
		// For encode/concat: pretend ffmpeg succeeded and create the output file
		// (concat-list lookups depend on it existing).
		const last = args[args.length - 1];
		if (last?.endsWith(".mp4")) {
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
		const muxCalls = calls.filter(
			([, args]) => args.includes("copy") && args.includes("aac"),
		);
		const concatCalls = calls.filter(
			([, args]) =>
				args.includes("concat") &&
				args.includes("copy") &&
				!args.includes("libx264"),
		);

		// Per segment: probe the narration, encode video, probe the video, mux;
		// then the final video is probed once for its length.
		expect(probeCalls).toHaveLength(5);
		expect(probeCalls.at(-1)?.[1][1]).toBe(join(outputDir, "final.mp4"));
		expect(encodeCalls).toHaveLength(2);
		expect(muxCalls).toHaveLength(2);
		expect(concatCalls).toHaveLength(1);
		// Then the video packets of each segment and of the final are listed.
		const listed = calls
			.filter(([, args]) => args.includes("framecrc"))
			.map(([, args]) => args[args.indexOf("-i") + 1]);
		expect(listed).toEqual([
			join(outputDir, "final.mp4"),
			join(outputDir, "segment-0.mp4"),
			join(outputDir, "segment-1.mp4"),
		]);
	});

	it("reports the final video's length as ffmpeg reads it", async () => {
		const { timeline, frames } = makeTimeline();
		const { exec } = makeDefaultExec();

		const result = await renderTimeline({
			timeline,
			frames,
			outputDir,
			speech,
			exec,
		});

		expect(result.durationSeconds).toBe(2.5);
	});

	it("reports where each segment starts in the final video, as its first frame there", async () => {
		const { timeline, frames } = makeTimeline();
		const { exec } = makeDefaultExec();

		const result = await renderTimeline({
			timeline,
			frames,
			outputDir,
			speech,
			exec,
		});

		// Segment 0 begins at the final's first frame, 538 ticks of 1/12800 s
		// (0.04203 s); segment 1 after segment 0's 3 frames of 512 ticks
		// (0.16203 s). Both rounded up to the millisecond. Adding up the
		// segments' 2.5 s probed lengths would say 0 and 2.5.
		expect(result.segments.map((s) => s.startSeconds)).toEqual([0.043, 0.163]);
	});

	it("leaves a start that falls on a whole millisecond as it is", async () => {
		const { timeline, frames } = makeTimeline();
		const exec: ExecRunner = (bin, args) =>
			framecrc(args, 0) ?? makeDefaultExec().exec(bin, args);

		const result = await renderTimeline({
			timeline,
			frames,
			outputDir,
			speech,
			exec,
		});

		// 3 × 512 ticks of 1/12800 s is 0.12 s exactly.
		expect(result.segments.map((s) => s.startSeconds)).toEqual([0, 0.12]);
	});

	it("throws when the final video's packets do not add up to its segments'", async () => {
		const { timeline, frames } = makeTimeline();
		const exec: ExecRunner = (bin, args) => {
			const listing = framecrc(args);
			if (listing && args.some((a) => a.endsWith("final.mp4"))) {
				// Drop the last packet, as if the join had lost a frame.
				const lines = listing.stdout.trimEnd().split("\n");
				return { ...listing, stdout: `${lines.slice(0, -1).join("\n")}\n` };
			}
			return makeDefaultExec().exec(bin, args);
		};

		await expect(
			renderTimeline({ timeline, frames, outputDir, speech, exec }),
		).rejects.toThrow(
			/final video has 7 video packets but its segments have 8/,
		);
	});

	it("uses narration synthesised in advance instead of synthesising it again", async () => {
		const { timeline, frames } = makeTimeline();
		const { exec } = makeDefaultExec();

		await renderTimeline({
			timeline,
			frames,
			outputDir,
			speech,
			narration: [{ audio: new Uint8Array([1, 2, 3]), format: "wav" }],
			exec,
			keepIntermediates: true,
		});

		expect(doGenerate.mock.calls.map((c) => c[0].text)).toEqual([
			"submitting the form",
		]);
		expect(readFileSync(join(outputDir, "audio-0.wav"))).toEqual(
			Buffer.from([1, 2, 3]),
		);
	});

	it("encodes every segment at one size when the viewport changes mid-recording", async () => {
		// A desktop step, then the same flow at a phone viewport. Segments
		// encoded at their own sizes were joined into one stream that
		// QuickTime and Safari cannot decode past the change: they held the
		// last desktop frame, frozen, over the phone steps.
		const timeline: TimelineEntry[] = [
			{
				instruction: "click #go",
				narrative: "On a desktop.",
				startTime: 1000,
				endTime: 1100,
				frameCount: 1,
				segmentDuration: 0.1,
			},
			{
				instruction: "set viewport 375 667 && reload",
				narrative: "On a phone.",
				startTime: 1200,
				endTime: 1300,
				frameCount: 1,
				segmentDuration: 0.1,
			},
		];
		const frames: CapturedFrame[] = [
			{ timestamp: 1050, data: jpeg(1280, 800), format: "jpeg" },
			{ timestamp: 1250, data: jpeg(375, 667), format: "jpeg" },
		];
		const { exec } = makeDefaultExec();

		await renderTimeline({ timeline, frames, outputDir, speech, exec });

		const filters = exec.mock.calls
			.filter(([, args]) => args.includes("libx264"))
			.map(([, args]) => args[args.indexOf("-vf") + 1]);
		expect(filters).toHaveLength(2);
		// Both segments: scaled to fit 1280x800, centred, square pixels.
		for (const vf of filters) {
			expect(vf).toBe(
				"scale=1280:800:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1",
			);
		}
	});

	it("sizes the video to the widest and tallest frame, rounded up to even numbers", async () => {
		const timeline: TimelineEntry[] = [
			{
				instruction: "x",
				narrative: "n",
				startTime: 1000,
				endTime: 1100,
				frameCount: 2,
				segmentDuration: 0.1,
			},
		];
		const frames: CapturedFrame[] = [
			{ timestamp: 1010, data: png(801, 400) },
			{ timestamp: 1020, data: png(375, 667) },
		];
		const { exec } = makeDefaultExec();

		await renderTimeline({ timeline, frames, outputDir, speech, exec });

		const encode = exec.mock.calls.find(([, args]) =>
			args.includes("libx264"),
		)![1];
		expect(encode[encode.indexOf("-vf") + 1]).toMatch(
			/^scale=802:668:.*pad=802:668:/,
		);
	});

	it("encodes each frame at its own even size when frame sizes can't be read", async () => {
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
		// Video is encoded alone (no audio, no -t, no -shortest) …
		expect(encodeArgs).toContain("-an");
		expect(encodeArgs).not.toContain("-shortest");
		expect(encodeArgs).not.toContain("-t");
		// … then muxed with narration padded to exactly the measured video
		// length. Never `-shortest`: ffmpeg-static 6.0 dropped the whole audio
		// stream under it, and 7.0.2 let the padding overrun.
		const muxCall = exec.mock.calls.find(
			([, args]) => args.includes("copy") && args.includes("aac"),
		);
		expect(muxCall).toBeDefined();
		const muxArgs = muxCall![1] as ReadonlyArray<string>;
		expect(muxArgs.some((a) => /^apad=whole_dur=\d+\.\d{3}$/.test(a))).toBe(
			true,
		);
		expect(muxArgs).not.toContain("-shortest");
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
			// Frames at 1010/1050/1090: two real 0.04s gaps (above the 20ms floor),
			// then the last frame runs to the 2.5s narration end: 2.5 - 0.08 + 0.25.
			expect(durations).toHaveLength(3);
			expect(durations[0]).toBeCloseTo(0.04, 3);
			expect(durations[1]).toBeCloseTo(0.04, 3);
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
		).rejects.toThrow(/could not parse duration/);
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

describe("renderTimeline segment length = max(video, audio)", () => {
	const PROBE_15S =
		"ffmpeg version blah\n  Duration: 00:00:15.00, start: 0.000000, bitrate: 32 kb/s\n";

	function execWithAudio(stderr: string): ExecRunner {
		return (_bin, args) => {
			const listing = framecrc(args);
			if (listing) return listing;
			if (args.length === 2 && args[0] === "-i") {
				return { stdout: "", stderr, status: 1 };
			}
			const out = args[args.length - 1];
			writeFileSync(out, "fake");
			return { stdout: "", stderr: "", status: 0 };
		};
	}

	const speech: SpeechOptions = {
		model: new MockSpeechModelV4({
			doGenerate: async () => ({
				audio: new Uint8Array([1]),
				warnings: [],
				response: { timestamp: new Date(), modelId: "mock" },
			}),
		}),
	};

	async function durationsFor(
		frames: CapturedFrame[],
		entry: TimelineEntry,
		probe: string,
	): Promise<number[]> {
		const outputDir = mkdtempSync(join(tmpdir(), "demo-render-len-"));
		try {
			await renderTimeline({
				timeline: [entry],
				frames,
				outputDir,
				speech,
				exec: execWithAudio(probe),
				keepIntermediates: true,
				ffmpegPath: "/fake/ffmpeg",
			});
			const list = readFileSync(
				join(outputDir, "segment-0-frames", "frames.txt"),
				"utf8",
			);
			return [...list.matchAll(/duration ([\d.]+)/g)].map((m) => Number(m[1]));
		} finally {
			rmSync(outputDir, { recursive: true, force: true });
		}
	}

	const f = (t: number): CapturedFrame => ({
		timestamp: t,
		data: Buffer.from(`f${t}`).toString("base64"),
	});
	const entry = (start: number, end: number): TimelineEntry => ({
		instruction: "x",
		narrative: "y",
		startTime: start,
		endTime: end,
		frameCount: 0,
		segmentDuration: (end - start) / 1000,
	});

	it("does not clamp the last frame's hold — a 15s narration over one frame is held 15.25s", async () => {
		const d = await durationsFor([f(1000)], entry(1000, 1100), PROBE_15S);
		expect(d).toEqual([15.25]);
	});

	it("derives the last hold from clamped video time so 30 fps capture is not slowed", async () => {
		// 91 frames 33ms apart = 3.0s of real time; gaps stay 0.033 (above the
		// 20ms floor), and the last hold tops the total up to audio + tail.
		const frames = Array.from({ length: 91 }, (_, i) => f(1000 + i * 33));
		const d = await durationsFor(frames, entry(1000, 4100), PROBE_STDERR); // 2.5s audio
		const gaps = d.slice(0, -1);
		expect(gaps.every((g) => Math.abs(g - 0.033) < 1e-9)).toBe(true);
		const total = d.reduce((a, b) => a + b, 0);
		// Video already exceeds the 2.5s narration, so the last frame gets only the tail.
		expect(d.at(-1)).toBeCloseTo(0.25, 3);
		expect(total).toBeCloseTo(90 * 0.033 + 0.25, 3);
	});

	it("accounts for a clamped long gap when sizing the last hold", async () => {
		// A 30s repaint-free gap is clamped to 10s; the last hold must be computed
		// from the 10s actually laid down, not the 30s raw offset (which would go
		// negative and truncate a 15s narration).
		const d = await durationsFor(
			[f(1000), f(31000)],
			entry(1000, 31100),
			PROBE_15S,
		);
		expect(d[0]).toBe(10);
		expect(d[1]).toBeCloseTo(15 - 10 + 0.25, 3);
	});
});

describe("renderTimeline frame encodings", () => {
	it("writes jpeg frames with a .jpg extension and png frames with .png", async () => {
		const outputDir = mkdtempSync(join(tmpdir(), "demo-render-fmt-"));
		const seen: string[][] = [];
		const exec: ExecRunner = (_bin, args) => {
			seen.push([...args]);
			const listing = framecrc(args);
			if (listing) return listing;
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
