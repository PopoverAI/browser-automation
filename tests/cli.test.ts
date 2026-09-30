import { execFile, execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { silentWav } from "../src/speech.js";

/**
 * `agentic-demo record`, run as a person runs it: the built binary in its
 * own process, with stand-ins for agent-browser and ffmpeg. agent-browser is
 * a script that answers `stream status` with the port of a fake stream this
 * file serves, and succeeds at every `batch`. ffmpeg is a script that writes
 * each output file, reports a 2 s duration for every probe, and lists video
 * packets as real ffmpeg's framecrc muxer does: three per segment, the final
 * video's starting 42 ms late, as a real join with 24 kHz narration does.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");

const FAKE_AGENT_BROWSER = `
const args = process.argv.slice(2).filter((a) => a !== "--json");
if (args[0] === "stream" && args[1] === "status") {
	console.log(JSON.stringify({ success: true, data: { enabled: true, port: Number(process.env.FAKE_STREAM_PORT) }, error: null }));
} else if (args[0] === "batch") {
	let input = "";
	process.stdin.on("data", (d) => (input += d));
	process.stdin.on("end", () => {
		const commands = JSON.parse(input);
		console.log(JSON.stringify(commands.map((command) => ({ command, success: true, result: null, error: null }))));
	});
}
`;

const FAKE_FFMPEG = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const input = args[args.indexOf("-i") + 1];
if (args.includes("framecrc")) {
	const final = input.endsWith("final.mp4");
	const segments = final
		? readFileSync(join(dirname(input), "segments.txt"), "utf8").split("\\n").length
		: 1;
	const lines = ["#tb 0: 1/12800"];
	for (let k = 0; k < segments * 3; k++) {
		const pts = (final ? 538 : 0) + k * 512;
		lines.push(\`0, \${pts}, \${pts}, 512, 13, 0x0\`);
	}
	process.stdout.write(lines.join("\\n") + "\\n");
} else if (args.length === 2 && args[0] === "-i") {
	process.stderr.write("  Duration: 00:00:02.00, start: 0.000000, bitrate: 1 kb/s\\n");
	process.exit(1);
} else {
	writeFileSync(args[args.length - 1], "fake");
}
`;

const STEPS = {
	steps: [
		{ narrate: "Open the settings.", commands: [["click", "@e1"]] },
		{ narrate: "Turn on dark mode.", commands: [["click", "@e2"]] },
	],
};

let dir: string;
let stream: WebSocketServer;
let frames: NodeJS.Timeout;
let voice: Server;
let voiceUrl: string;

beforeAll(async () => {
	// The test runs dist/, so build it from the source under test.
	execFileSync(process.execPath, [
		join(ROOT, "node_modules", "typescript", "bin", "tsc"),
		"-p",
		join(ROOT, "tsconfig.json"),
	]);

	dir = mkdtempSync(join(tmpdir(), "agentic-demo-cli-"));
	writeFileSync(join(dir, "agent-browser.mjs"), FAKE_AGENT_BROWSER);
	writeFileSync(join(dir, "ffmpeg.mjs"), FAKE_FFMPEG);
	chmodSync(join(dir, "ffmpeg.mjs"), 0o755);
	writeFileSync(join(dir, "steps.json"), JSON.stringify(STEPS));

	// A stream that repaints every 20 ms, so every step brings frames.
	stream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise<void>((r) => stream.once("listening", r));
	let seq = 0;
	const frame = () =>
		JSON.stringify({
			type: "frame",
			seq: ++seq,
			data: Buffer.from(`jpeg-${seq}`).toString("base64"),
			metadata: { deviceWidth: 1280, deviceHeight: 720, timestamp: 0 },
		});
	stream.on("connection", (ws) => {
		ws.send(
			JSON.stringify({ type: "status", connected: true, screencasting: true }),
		);
		ws.send(frame());
	});
	frames = setInterval(() => {
		const message = frame();
		for (const c of stream.clients) c.send(message);
	}, 20);

	// A voice endpoint that narrates every line as a short silence.
	voice = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "audio/wav" });
			res.end(Buffer.from(silentWav(0.5)));
		});
	});
	await new Promise<void>((r) => voice.listen(0, "127.0.0.1", r));
	voiceUrl = `http://127.0.0.1:${(voice.address() as AddressInfo).port}/voice`;
}, 60_000);

afterAll(async () => {
	clearInterval(frames);
	for (const c of stream.clients) c.terminate();
	await new Promise<void>((r) => stream.close(() => r()));
	await new Promise<void>((r) => voice.close(() => r()));
	rmSync(dir, { recursive: true, force: true });
});

function record(
	out: string,
	...flags: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
	const port = (stream.address() as AddressInfo).port;
	return new Promise((done) => {
		execFile(
			process.execPath,
			[
				CLI,
				"record",
				join(dir, "steps.json"),
				"--out",
				join(dir, out),
				"--agent-browser",
				`${process.execPath} ${join(dir, "agent-browser.mjs")}`,
				"--ffmpeg",
				join(dir, "ffmpeg.mjs"),
				"--trailing-delay",
				"50",
				...flags,
			],
			{ env: { ...process.env, FAKE_STREAM_PORT: String(port) } },
			(err, stdout, stderr) =>
				done({
					code: err ? Number((err as { code?: number }).code ?? 1) : 0,
					stdout,
					stderr,
				}),
		);
	});
}

describe("agentic-demo record", () => {
	it("writes final.json beside final.mp4 on a silent run without --json", async () => {
		const r = await record("silent", "--silent");
		expect(r.code, r.stderr).toBe(0);
		expect(r.stdout.trim()).toBe(join(dir, "silent", "final.mp4"));

		const summary = JSON.parse(
			readFileSync(join(dir, "silent", "final.json"), "utf8"),
		);
		expect(summary.videoPath).toBe(join(dir, "silent", "final.mp4"));
		expect(summary.durationSeconds).toBe(2);
		expect(
			summary.segments.map((s: Record<string, unknown>) => Object.keys(s)),
		).toEqual(
			Array(2).fill([
				"index",
				"instruction",
				"narrative",
				"startSeconds",
				"captureSeconds",
				"narrationSeconds",
				"renderedSeconds",
				"frameCount",
			]),
		);
		// Where the fake ffmpeg's final video shows each segment's first frame:
		// 538 and 538 + 3 × 512 ticks of 1/12800 s, rounded up to the ms.
		expect(
			summary.segments.map((s: { startSeconds: number }) => s.startSeconds),
		).toEqual([0.043, 0.163]);
	}, 60_000);

	it("writes the summary --json prints on a narrated run", async () => {
		const r = await record("voiced", "--tts", voiceUrl, "--json");
		expect(r.code, r.stderr).toBe(0);

		const written = readFileSync(join(dir, "voiced", "final.json"), "utf8");
		expect(written).toBe(r.stdout);
		const summary = JSON.parse(written);
		expect(summary.segments[1]).toMatchObject({
			index: 1,
			narrative: "Turn on dark mode.",
			startSeconds: 0.163,
		});
	}, 60_000);
});
