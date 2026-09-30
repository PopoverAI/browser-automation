import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type WebSocket,
	WebSocket as WebSocketClient,
	WebSocketServer,
} from "ws";

import {
	AgentBrowserClient,
	type AgentBrowserExec,
	type AgentBrowserExecResult,
	type BatchCommandResult,
} from "../src/agentBrowserClient.js";
import {
	attachAgentBrowserDemoRecorder,
	DemoStepError,
	formatCommands,
	stepFailureHints,
} from "../src/agentBrowserRecorder.js";

/**
 * A fake agent-browser daemon stream: a WebSocket server that pushes `frame`
 * messages to whoever is connected, numbered with `seq` as agent-browser
 * numbers them. Like the daemon, it greets each new client with the newest
 * frame it already has (same `seq`), and when a client arrives with no one
 * else watching it restarts its capture, which sends a new frame of the page
 * as it is ("start" if nothing has been drawn yet). The first connection's
 * start frame is left out: tests send the frames they need.
 */
class FakeStream {
	private wss!: WebSocketServer;
	private clients = new Set<WebSocket>();
	private seq = 0;
	private newest?: { label: string; message: string };
	private connections = 0;
	url = "";
	/** While false the stream has stopped: the socket stays open, frames don't come. */
	live = true;

	async start(): Promise<void> {
		this.wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
		await new Promise<void>((r) => this.wss.once("listening", r));
		const addr = this.wss.address();
		if (typeof addr === "string" || !addr) throw new Error("no address");
		this.url = `ws://127.0.0.1:${addr.port}/`;
		this.wss.on("connection", (ws) => {
			this.connections++;
			const alone = this.clients.size === 0;
			this.clients.add(ws);
			ws.send(
				JSON.stringify({
					type: "status",
					connected: true,
					screencasting: true,
				}),
			);
			if (this.newest) ws.send(this.newest.message);
			if (alone && this.connections > 1) {
				this.frame(this.newest?.label ?? "start");
			}
			ws.on("close", () => this.clients.delete(ws));
		});
	}

	get clientCount(): number {
		return this.clients.size;
	}

	frame(label: string, timestamp = 0): void {
		if (!this.live) return;
		const message = JSON.stringify({
			type: "frame",
			seq: ++this.seq,
			data: Buffer.from(`jpeg-${label}`).toString("base64"),
			metadata: { deviceWidth: 1280, deviceHeight: 720, timestamp },
		});
		this.newest = { label, message };
		for (const c of this.clients) c.send(message);
	}

	async stop(): Promise<void> {
		for (const c of this.clients) c.terminate();
		await new Promise<void>((r) => this.wss.close(() => r()));
	}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until `pred` holds, polling — keeps the tests free of fixed sleeps. */
async function until(pred: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error("until: timed out");
		await sleep(5);
	}
}

interface FakeExecOptions {
	/** Called for each batch; return the per-command results. */
	onBatch?: (
		commands: string[][],
	) => BatchCommandResult[] | Promise<BatchCommandResult[]>;
}

function makeFakeExec(stream: FakeStream, opts: FakeExecOptions = {}) {
	const calls: string[][] = [];
	const exec = vi.fn<AgentBrowserExec>(
		async (args, execOpts): Promise<AgentBrowserExecResult> => {
			calls.push([...args]);
			if (args[0] === "batch") {
				const commands = JSON.parse(execOpts?.stdin ?? "[]") as string[][];
				const results =
					(await opts.onBatch?.(commands)) ??
					commands.map((c) => ({
						command: c,
						success: true,
						result: null,
						error: null,
					}));
				return { stdout: JSON.stringify(results), stderr: "", status: 0 };
			}
			if (args[0] === "stream" && args[1] === "status") {
				const port = Number(new URL(stream.url).port);
				return {
					stdout: JSON.stringify({
						success: true,
						data: { enabled: true, port },
						error: null,
					}),
					stderr: "",
					status: 0,
				};
			}
			if (args[0] === "stream" && args[1] === "disable") {
				return { stdout: "", stderr: "", status: 0 };
			}
			throw new Error(`fake exec: unexpected ${args.join(" ")}`);
		},
	);
	return { exec, calls };
}

describe("formatCommands", () => {
	it("joins commands with && and quotes args containing whitespace", () => {
		expect(
			formatCommands([
				["click", "@e3"],
				["fill", "#name", "Ada Lovelace"],
			]),
		).toBe('click @e3 && fill #name "Ada Lovelace"');
	});
});

describe("attachAgentBrowserDemoRecorder", () => {
	let stream: FakeStream;

	beforeEach(async () => {
		stream = new FakeStream();
		await stream.start();
	});

	afterEach(async () => {
		await stream.stop();
	});

	it("discovers the stream via the client and stamps frames on receipt as jpeg", async () => {
		const { exec, calls } = makeFakeExec(stream);
		const client = new AgentBrowserClient({ exec });
		const demo = await attachAgentBrowserDemoRecorder({
			client,
			trailingDelay: 0,
		});

		expect(calls[0]).toEqual(["stream", "status", "--json"]);
		await until(() => stream.clientCount === 1);

		const before = Date.now();
		stream.frame("a");
		await until(() => demo.timeline().frames.length === 1);
		const after = Date.now();

		const [f] = demo.timeline().frames;
		expect(f.format).toBe("jpeg");
		expect(Buffer.from(f.data, "base64").toString()).toBe("jpeg-a");
		// 0.36 sends timestamp 0 — must be replaced with receipt time.
		expect(f.timestamp).toBeGreaterThanOrEqual(before);
		expect(f.timestamp).toBeLessThanOrEqual(after);

		await demo.stop();
	});

	it("honours a real epoch-ms metadata timestamp if the daemon sends one", async () => {
		const { exec } = makeFakeExec(stream);
		const demo = await attachAgentBrowserDemoRecorder({
			client: new AgentBrowserClient({ exec }),
			trailingDelay: 0,
		});
		await until(() => stream.clientCount === 1);
		stream.frame("ts", 1_788_800_000_000);
		await until(() => demo.timeline().frames.length === 1);
		expect(demo.timeline().frames[0].timestamp).toBe(1_788_800_000_000);
		await demo.stop();
	});

	it("step runs one --bail batch and records a timeline entry spanning its frames", async () => {
		const { exec, calls } = makeFakeExec(stream, {
			onBatch: async (commands) => {
				// Simulate the page repainting while the batch runs.
				stream.frame("during-1");
				await sleep(10);
				stream.frame("during-2");
				return commands.map((c) => ({
					command: c,
					success: true,
					result: { ok: 1 },
					error: null,
				}));
			},
		});
		const demo = await attachAgentBrowserDemoRecorder({
			client: new AgentBrowserClient({ exec }),
			trailingDelay: 20,
		});
		await until(() => stream.clientCount === 1);

		const results = await demo.step(
			[
				["click", "@e1"],
				["wait", "100"],
			],
			"Click the thing.",
		);
		expect(results).toHaveLength(2);

		const batchCall = calls.find((c) => c[0] === "batch");
		expect(batchCall).toEqual(["batch", "--bail", "--json"]);

		const { entries, frames } = demo.timeline();
		expect(entries).toHaveLength(1);
		const [e] = entries;
		expect(e.instruction).toBe("click @e1 && wait 100");
		expect(e.narrative).toBe("Click the thing.");
		expect(e.endTime - e.startTime).toBeGreaterThanOrEqual(20);
		expect(e.segmentDuration).toBeCloseTo((e.endTime - e.startTime) / 1000, 6);
		// The step's own two frames, then the new one the closing reconnect
		// brought (the repeat of the cached frame is not kept). It proves the
		// stream live but stays out of a step that has frames.
		expect(frames).toHaveLength(3);
		expect(Buffer.from(frames[2].data, "base64").toString()).toBe(
			"jpeg-during-2",
		);
		expect(e.frameCount).toBe(2);
		expect(frames[2].timestamp).toBeGreaterThanOrEqual(e.endTime);
		await demo.stop();
	});

	it("step throws DemoStepError naming the failing command", async () => {
		const { exec } = makeFakeExec(stream, {
			onBatch: (commands) => [
				{ command: commands[0], success: true, result: null, error: null },
				{
					command: commands[1],
					success: false,
					result: null,
					error: "Element not found",
				},
			],
		});
		const demo = await attachAgentBrowserDemoRecorder({
			client: new AgentBrowserClient({ exec }),
			trailingDelay: 0,
		});
		const err = await demo
			.step(
				[
					["wait", "1"],
					["click", "#nope"],
					["wait", "1"],
				],
				"n",
			)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(DemoStepError);
		expect((err as Error).message).toMatch(/click #nope/);
		expect((err as Error).message).toMatch(/Element not found/);
		expect((err as DemoStepError).results).toHaveLength(2);
		// A failed step must not leave a half-described segment behind.
		expect(demo.timeline().entries).toHaveLength(0);
		await demo.stop();
	});

	it("step throws DemoStepError when the batch stops short without a failure", async () => {
		const { exec } = makeFakeExec(stream, {
			onBatch: (commands) => [
				{ command: commands[0], success: true, result: null, error: null },
			],
		});
		const demo = await attachAgentBrowserDemoRecorder({
			client: new AgentBrowserClient({ exec }),
			trailingDelay: 0,
		});
		await expect(
			demo.step(
				[
					["wait", "1"],
					["wait", "1"],
				],
				"n",
			),
		).rejects.toThrow(/ran 1 of 2 commands/);
		await demo.stop();
	});

	it("step wraps a batch that fails to run at all", async () => {
		const { exec } = makeFakeExec(stream, {
			onBatch: () => {
				throw new Error("daemon went away");
			},
		});
		const demo = await attachAgentBrowserDemoRecorder({
			client: new AgentBrowserClient({ exec }),
			trailingDelay: 0,
		});
		const err = await demo.step([["wait", "1"]], "n").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(DemoStepError);
		expect((err as Error).message).toMatch(/daemon went away/);
		expect((err as Error).cause).toBeInstanceOf(Error);
		await demo.stop();
	});

	it("rejects empty steps and steps after stop", async () => {
		const { exec } = makeFakeExec(stream);
		const demo = await attachAgentBrowserDemoRecorder({
			client: new AgentBrowserClient({ exec }),
			trailingDelay: 0,
		});
		await expect(demo.step([], "n")).rejects.toThrow(/must not be empty/);
		await demo.stop();
		await expect(demo.step([["wait", "1"]], "n")).rejects.toThrow(/stopped/);
	});

	it("stop closes the socket, is idempotent, and only disables a stream it enabled", async () => {
		// Stream already enabled: no `stream disable` on stop.
		const { exec, calls } = makeFakeExec(stream);
		const demo = await attachAgentBrowserDemoRecorder({
			client: new AgentBrowserClient({ exec }),
			trailingDelay: 0,
		});
		await until(() => stream.clientCount === 1);
		await demo.stop();
		await demo.stop();
		await until(() => stream.clientCount === 0);
		expect(calls.some((c) => c[0] === "stream" && c[1] === "disable")).toBe(
			false,
		);

		// Stream off at attach time: recorder enables it and disables it on stop.
		let enabled = false;
		const port = Number(new URL(stream.url).port);
		const calls2: string[][] = [];
		const exec2 = vi.fn<AgentBrowserExec>(async (args) => {
			calls2.push([...args]);
			if (args[0] === "stream" && args[1] === "status") {
				return {
					stdout: JSON.stringify({
						success: true,
						data: enabled ? { enabled: true, port } : { enabled: false },
						error: null,
					}),
					stderr: "",
					status: 0,
				};
			}
			if (args[0] === "stream" && args[1] === "enable") {
				enabled = true;
				return { stdout: "", stderr: "", status: 0 };
			}
			if (args[0] === "stream" && args[1] === "disable") {
				enabled = false;
				return { stdout: "", stderr: "", status: 0 };
			}
			throw new Error(`unexpected ${args.join(" ")}`);
		});
		const demo2 = await attachAgentBrowserDemoRecorder({
			client: new AgentBrowserClient({ exec: exec2 }),
			trailingDelay: 0,
		});
		await demo2.stop();
		expect(calls2.map((c) => c.slice(0, 2))).toEqual([
			["stream", "status"],
			["stream", "enable"],
			["stream", "status"],
			["stream", "disable"],
		]);
	});

	it("disables a stream it enabled if the socket never opens", async () => {
		let enabled = false;
		const calls: string[][] = [];
		const exec = vi.fn<AgentBrowserExec>(async (args) => {
			calls.push([...args]);
			if (args[0] === "stream" && args[1] === "status") {
				return {
					stdout: JSON.stringify({
						success: true,
						// Port 1: nothing listens there, so the connect fails.
						data: enabled ? { enabled: true, port: 1 } : { enabled: false },
						error: null,
					}),
					stderr: "",
					status: 0,
				};
			}
			if (
				args[0] === "stream" &&
				(args[1] === "enable" || args[1] === "disable")
			) {
				enabled = args[1] === "enable";
				return { stdout: "", stderr: "", status: 0 };
			}
			throw new Error(`unexpected ${args.join(" ")}`);
		});
		await expect(
			attachAgentBrowserDemoRecorder({
				client: new AgentBrowserClient({ exec }),
				connectTimeoutMs: 500,
			}),
		).rejects.toThrow(/could not connect|did not open/);
		expect(calls.some((c) => c[0] === "stream" && c[1] === "disable")).toBe(
			true,
		);
	});

	it("fails the next step when the stream drops mid-run instead of recording nothing", async () => {
		const { exec } = makeFakeExec(stream);
		const demo = await attachAgentBrowserDemoRecorder({
			client: new AgentBrowserClient({ exec }),
			trailingDelay: 0,
		});
		await until(() => stream.clientCount === 1);
		await demo.step([["wait", "1"]], "first");
		await stream.stop(); // daemon goes away
		await until(() => stream.clientCount === 0);
		await new Promise((r) => setTimeout(r, 20));
		await expect(demo.step([["wait", "1"]], "second")).rejects.toThrow(
			/stream closed mid-run/,
		);
		expect(demo.timeline().entries).toHaveLength(1);
		await demo.stop();
		// afterEach stops the stream again; make that a no-op.
		stream = new FakeStream();
		await stream.start();
	});

	it("refuses to render after the stream dropped following the final step", async () => {
		const { exec } = makeFakeExec(stream);
		const demo = await attachAgentBrowserDemoRecorder({
			client: new AgentBrowserClient({ exec }),
			trailingDelay: 0,
		});
		await until(() => stream.clientCount === 1);
		stream.frame("a");
		await until(() => demo.timeline().frames.length === 1);
		await demo.step([["wait", "1"]], "only step");
		await stream.stop(); // daemon dies after the last step, before render()
		await until(() => stream.clientCount === 0);
		await new Promise((r) => setTimeout(r, 20));
		await expect(demo.render()).rejects.toThrow(/stream closed mid-run/);
		stream = new FakeStream();
		await stream.start();
	});

	it("renders normally when the caller stopped the recorder before render()", async () => {
		// stop() closes the socket deliberately; that close must not be mistaken
		// for a mid-run drop.
		const { exec } = makeFakeExec(stream);
		const demo = await attachAgentBrowserDemoRecorder({
			client: new AgentBrowserClient({ exec }),
			trailingDelay: 0,
		});
		await until(() => stream.clientCount === 1);
		await demo.step([["wait", "1"]], "n");
		await demo.stop();
		await until(() => stream.clientCount === 0);
		await new Promise((r) => setTimeout(r, 20));
		// Render gets past the stream check to ffmpeg, which is stubbed to stop it there.
		await expect(
			demo.render({
				ffmpegPath: "ffmpeg",
				exec: () => {
					throw new Error("reached ffmpeg");
				},
			}),
		).rejects.toThrow(/reached ffmpeg/);
	});

	it("records a step that changes nothing on screen, with the page as the step left it", async () => {
		const { exec, calls } = makeFakeExec(stream);
		const demo = await attachAgentBrowserDemoRecorder({
			client: new AgentBrowserClient({ exec }),
			trailingDelay: 0,
		});
		await until(() => stream.clientCount === 1);
		stream.frame("page");
		await until(() => demo.timeline().frames.length === 1);

		// The page doesn't repaint, so the stream sends nothing during the step.
		await demo.step([["wait", "1"]], "Nothing moves.");

		// Reconnecting proved the stream live, and the frame its restart sent is
		// the step's picture. No extra agent-browser command ran.
		expect(calls.filter((c) => c[0] === "batch")).toHaveLength(1);
		const [entry] = demo.timeline().entries;
		expect(entry.frameCount).toBe(1);
		const inStep = demo
			.timeline()
			.frames.filter(
				(f) => f.timestamp >= entry.startTime && f.timestamp <= entry.endTime,
			);
		expect(Buffer.from(inStep[0].data, "base64").toString()).toBe("jpeg-page");
		await demo.stop();
	});

	it("fails a step that brings no frames once the stream has stopped, naming the step", async () => {
		// Before the check existed, the second step recorded with no frames and the
		// render held step 1's frame over it: a frozen video, and no error.
		const { exec } = makeFakeExec(stream, {
			onBatch: (commands) => {
				stream.frame(`step-${commands[0][1]}`);
				return commands.map((c) => ({
					command: c,
					success: true,
					result: null,
					error: null,
				}));
			},
		});
		const demo = await attachAgentBrowserDemoRecorder({
			client: new AgentBrowserClient({ exec }),
			trailingDelay: 0,
			frameCheckTimeoutMs: 1000,
		});
		await until(() => stream.clientCount === 1);
		await demo.step([["click", "#desktop"]], "On a desktop.");

		stream.live = false; // the socket stays open; frames just stop
		const err = await demo
			.step([["set", "viewport", "375", "667"], ["reload"]], "On a phone.")
			.catch((e: unknown) => e);

		expect(err).toBeInstanceOf(Error);
		const message = (err as Error).message;
		expect(message).toMatch(
			/^step 2 \(set viewport 375 667 && reload\): agent-browser's stream has stopped sending frames/,
		);
		expect(message).toMatch(/The last frame arrived during step 1\./);
		expect(demo.timeline().entries).toHaveLength(1);
		await demo.stop();
	});

	it("fails a step whose frames stop partway, before a later command changes the page", async () => {
		// The step's first command repaints and its frame arrives; then the
		// stream stops, and the second command's change is never sent. Before,
		// the step's one frame counted as proof and the recording went on with
		// the video frozen on the page before `click #submit`.
		const { exec } = makeFakeExec(stream, {
			onBatch: async (commands) => {
				stream.frame("form-filled");
				await until(() => demo.timeline().frames.length === 1);
				stream.live = false; // the socket stays open; frames just stop
				stream.frame("submitted"); // the click's repaint, never sent
				return commands.map((c) => ({
					command: c,
					success: true,
					result: null,
					error: null,
				}));
			},
		});
		const demo = await attachAgentBrowserDemoRecorder({
			client: new AgentBrowserClient({ exec }),
			trailingDelay: 0,
			frameCheckTimeoutMs: 200,
		});
		await until(() => stream.clientCount === 1);

		const err = await demo
			.step(
				[
					["fill", "#name", "Grace"],
					["click", "#submit"],
				],
				"Submit the form.",
			)
			.catch((e: unknown) => e);

		expect(err).toBeInstanceOf(Error);
		const message = (err as Error).message;
		expect(message).toMatch(
			/^step 1 \(fill #name Grace && click #submit\): agent-browser's stream has stopped sending frames/,
		);
		expect(message).toMatch(/The last frame arrived earlier in step 1\./);
		expect(demo.timeline().entries).toHaveLength(0);
		await demo.stop();
	});

	it("names another watcher of the stream as a cause when the check brings no new frame", async () => {
		// With a second client connected, the daemon never restarts its capture,
		// so a reconnect brings only the cached frame.
		const { exec } = makeFakeExec(stream);
		const demo = await attachAgentBrowserDemoRecorder({
			client: new AgentBrowserClient({ exec }),
			trailingDelay: 0,
			frameCheckTimeoutMs: 200,
		});
		await until(() => stream.clientCount === 1);
		stream.frame("page");
		await until(() => demo.timeline().frames.length === 1);
		const dashboard = new WebSocketClient(stream.url);
		await until(() => stream.clientCount === 2);

		await expect(demo.step([["wait", "1"]], "n")).rejects.toThrow(
			/If something else is watching agent-browser's stream, such as its dashboard, close it/,
		);
		// The cached frame the reconnect repeated was not taken as new.
		expect(demo.timeline().frames).toHaveLength(1);
		dashboard.close();
		await demo.stop();
	});

	it("appends maxFps to the stream URL when set", async () => {
		const seen: string[] = [];
		const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
		await new Promise<void>((r) => wss.once("listening", r));
		wss.on("connection", (_ws, req) => seen.push(req.url ?? ""));
		const addr = wss.address() as { port: number };
		const demo = await attachAgentBrowserDemoRecorder({
			streamUrl: `ws://127.0.0.1:${addr.port}/`,
			maxFps: 15,
			trailingDelay: 0,
		});
		await until(() => seen.length === 1);
		expect(seen[0]).toBe("/?maxFps=15");
		await demo.stop();
		await new Promise<void>((r) => wss.close(() => r()));
	});

	it("fails to attach when the stream socket is unreachable", async () => {
		await expect(
			attachAgentBrowserDemoRecorder({
				streamUrl: "ws://127.0.0.1:1/",
				connectTimeoutMs: 500,
			}),
		).rejects.toThrow(/could not connect|did not open/);
	});

	it("render refuses an empty timeline", async () => {
		const { exec } = makeFakeExec(stream);
		const demo = await attachAgentBrowserDemoRecorder({
			client: new AgentBrowserClient({ exec }),
			trailingDelay: 0,
		});
		await expect(demo.render()).rejects.toThrow(/no steps were recorded/);
	});
});

describe("stepFailureHints", () => {
	const err = (command: string[], error: string) =>
		new DemoStepError(
			`demo step failed at \`${command.join(" ")}\`: ${error}`,
			[command],
			[{ command, success: false, result: null, error }],
		);

	it("calls out the text= selector mistake and points at snapshot -i", () => {
		const hints = stepFailureHints(
			err(["click", "text=Sign in"], "Element not found"),
		);
		expect(hints.join("\n")).toMatch(/find", "text"/);
		expect(hints.join("\n")).toMatch(/snapshot -i/);
		expect(hints.at(-1)).toMatch(/off-script/);
	});

	it("always explains that later steps did not run", () => {
		const hints = stepFailureHints(err(["wait", "--text", "x"], "timeout"));
		expect(hints).toHaveLength(1);
		expect(hints[0]).toMatch(/did not run/);
	});
});
