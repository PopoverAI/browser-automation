import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStaticPath from "ffmpeg-static";
import { afterAll, describe, expect, it } from "vitest";

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

/** Every "Video: …, WxH" size ffmpeg reports for a file. */
function videoSizes(bin: string, file: string): string[] {
	let stderr = "";
	try {
		execFileSync(bin, ["-i", file], { stdio: ["ignore", "ignore", "pipe"] });
	} catch (e) {
		stderr = String((e as { stderr?: Buffer }).stderr ?? "");
	}
	return [...stderr.matchAll(/Video: .*?, (\d+x\d+)/g)].map((m) => m[1]);
}

describe.skipIf(!ffmpeg)("renderTimeline with a real ffmpeg", () => {
	const outputDir = mkdtempSync(join(tmpdir(), "demo-render-real-"));
	afterAll(() => rmSync(outputDir, { recursive: true, force: true }));

	/** A one-colour image of the given size, as a captured frame. */
	const solidFrame = (
		color: string,
		size: string,
		timestamp: number,
	): CapturedFrame => {
		const p = join(outputDir, `solid-${color}-${size}.jpg`);
		execFileSync(ffmpeg!, [
			"-v",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			`color=c=${color}:s=${size}`,
			"-frames:v",
			"1",
			p,
		]);
		return {
			timestamp,
			data: readFileSync(p).toString("base64"),
			format: "jpeg",
		};
	};

	it("keeps one frame size across a viewport change, so the video plays past it", async () => {
		const bin = ffmpeg!;
		// A wide "desktop" step, then a narrow, tall "phone" step.
		const frames = [
			solidFrame("red", "128x80", 1000),
			solidFrame("blue", "38x67", 2000),
		];
		const timeline: TimelineEntry[] = [
			{
				instruction: "desktop",
				narrative: "d",
				startTime: 1000,
				endTime: 1500,
				frameCount: 1,
				segmentDuration: 0.5,
			},
			{
				instruction: "set viewport 375 667",
				narrative: "p",
				startTime: 2000,
				endTime: 2500,
				frameCount: 1,
				segmentDuration: 0.5,
			},
		];

		const r = await renderTimeline({
			timeline,
			frames,
			outputDir: join(outputDir, "viewport-change"),
			ffmpegPath: bin,
			keepIntermediates: true,
		});

		// Before, the segments came out 128x80 and 38x66 and were copied into
		// one stream that AVFoundation stops decoding at the change.
		for (const file of [
			r.segments[0].segmentVideoPath!,
			r.segments[1].segmentVideoPath!,
			r.videoPath,
		]) {
			expect(videoSizes(bin, file)).toEqual(["128x80"]);
		}
	});

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
