import WebSocket from "ws";

import {
	AgentBrowserClient,
	type BatchCommandResult,
} from "./agentBrowserClient.js";
import {
	type RenderedSegment,
	type RenderTimelineOptions,
	renderTimeline,
} from "./render.js";
import type { SpeechOverrides } from "./speech.js";
import type { CapturedFrame, TimelineEntry } from "./timeline.js";

export type DemoRenderOptions = Omit<
	RenderTimelineOptions,
	"timeline" | "frames"
>;

export interface RenderResult {
	/** Absolute path to the rendered mp4. */
	videoPath: string;
	/** Directory the mp4 (and any kept intermediates) live in. */
	outputDir: string;
	/** Length of the final video in seconds. */
	durationSeconds: number;
	timeline: TimelineEntry[];
	/** Raw frame buffer — exposed primarily for testing/inspection. */
	frames: CapturedFrame[];
	/** One per timeline entry: rendered/narration lengths, kept intermediates. */
	segments: RenderedSegment[];
}

export interface AttachAgentBrowserDemoRecorderOptions {
	/** Client used to drive agent-browser. Default: `new AgentBrowserClient()`. */
	client?: AgentBrowserClient;
	/**
	 * Default trailing delay (ms) applied after every step so frames for the
	 * last visible change arrive before the step's endTime is recorded.
	 * Default 1000ms. Overridable per-step.
	 */
	trailingDelay?: number;
	/**
	 * Per-client frame-rate cap requested from the stream (1–120, 0 = uncapped).
	 * Default 0. The stream is change-driven, so this only matters for pages
	 * that repaint continuously (animations, video).
	 */
	maxFps?: number;
	/** Give up attaching if the stream socket hasn't opened after this (ms). Default 10000. */
	connectTimeoutMs?: number;
	/**
	 * How long (ms) to wait, at the end of each step, for the frame a
	 * screenshot makes a live stream send before calling the stream stopped.
	 * Default 2000, plus one frame interval when `maxFps` is set.
	 */
	frameCheckTimeoutMs?: number;
	/**
	 * Override the stream WebSocket URL instead of discovering it through
	 * `agent-browser stream status`. Primarily a test seam.
	 */
	streamUrl?: string;
}

export interface DemoStepOptions {
	/** Override the recorder's default trailingDelay for this single step. */
	trailingDelay?: number;
	/** Kill the batch and fail the step after this many ms. Default 120000. */
	timeoutMs?: number;
	/** Narration overrides for this step only (voice, instructions, speed, language). */
	speech?: SpeechOverrides;
}

export interface AgentBrowserDemoRecorder {
	/**
	 * Run `commands` as one `agent-browser batch --bail` and record it as one
	 * narrated segment. Throws {@link DemoStepError} if any command fails; the
	 * page is then in a state the following narration doesn't describe, so
	 * callers should abort the demo rather than continue.
	 */
	step(
		commands: ReadonlyArray<ReadonlyArray<string>>,
		narrative: string,
		opts?: DemoStepOptions,
	): Promise<BatchCommandResult[]>;
	timeline(): { entries: TimelineEntry[]; frames: CapturedFrame[] };
	/**
	 * Close the stream socket without rendering. Idempotent. If the recorder
	 * enabled the daemon's stream itself, it disables it again.
	 */
	stop(): Promise<void>;
	render(opts?: DemoRenderOptions): Promise<RenderResult>;
}

/** Thrown by `step()` when a batch command fails or the batch itself errors. */
export class DemoStepError extends Error {
	constructor(
		message: string,
		public readonly commands: ReadonlyArray<ReadonlyArray<string>>,
		public readonly results: BatchCommandResult[],
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "DemoStepError";
	}
}

interface StreamFrameMessage {
	type: "frame";
	/** Counts up across the daemon's frames; a repeat of a cached frame keeps its number. */
	seq?: number;
	data: string;
	metadata?: { timestamp?: number };
}

/** The daemon's `status` message, sent on connect and whenever the screencast restarts. */
interface StreamStatusMessage {
	type: "status";
	screencasting?: boolean;
	viewportWidth?: number;
	viewportHeight?: number;
}

const DEFAULT_STEP_TIMEOUT_MS = 120_000;
const DEFAULT_FRAME_CHECK_TIMEOUT_MS = 2000;

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Render a batch as a one-line instruction label for the timeline, e.g.
 * `click @e3 && fill @e4 "hello world"`.
 */
export function formatCommands(
	commands: ReadonlyArray<ReadonlyArray<string>>,
): string {
	return commands
		.map((c) => c.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" "))
		.join(" && ");
}

/**
 * Attach a demo recorder to the agent-browser daemon's viewport stream.
 *
 * Nothing here reaches into a browser library: the daemon owns the browser
 * (local, `--cdp`, or any `--provider`), and this recorder only consumes its
 * `stream` WebSocket and drives actions through `agent-browser batch`. Frames are stamped with
 * `Date.now()` on receipt — agent-browser's frame metadata carries no usable
 * timestamp as of 0.36 — and step boundaries are stamped from the same clock
 * around each batch, so segment bucketing is self-consistent.
 *
 * The daemon must already have a page open (`agent-browser open <url>`) so
 * the stream has something to capture.
 *
 * The stream sends a frame only when the page repaints, so a step that
 * changes nothing on screen brings none. So does a stream that has stopped,
 * partway through a step or before it, and holding the last frame would
 * freeze the video while the page moved on. To tell the two apart, every
 * step ends by reconnecting to the stream. When its last client leaves, the
 * daemon stops its capture, and it starts it again for the next; Chrome sends
 * a frame of the page as it is at every start, numbered after every frame
 * before it (seen on agent-browser 0.27 to 0.38.1). A live stream answers in
 * about 10 ms. For a step that changed nothing, that frame is the step's
 * picture; for any other step it only proves the stream live. If none
 * arrives, the step fails and names itself.
 *
 * A screenshot does not do this: it makes Chrome send a frame only sometimes
 * (on agent-browser 0.38.1, none after a `fill` and `click` at a phone
 * viewport, with the stream still live).
 */
export async function attachAgentBrowserDemoRecorder(
	options: AttachAgentBrowserDemoRecorderOptions = {},
): Promise<AgentBrowserDemoRecorder> {
	const {
		client = new AgentBrowserClient(),
		trailingDelay: defaultTrailingDelay = 1000,
		maxFps = 0,
		connectTimeoutMs = 10_000,
	} = options;
	// A frame-rate cap can hold a frame back for up to one interval.
	const frameCheckTimeoutMs =
		options.frameCheckTimeoutMs ??
		DEFAULT_FRAME_CHECK_TIMEOUT_MS + (maxFps > 0 ? 1000 / maxFps : 0);

	let streamUrl = options.streamUrl;
	let enabledByUs = false;
	if (!streamUrl) {
		const s = await client.ensureStream();
		streamUrl = s.url;
		enabledByUs = s.enabledByUs;
	}
	const frames: CapturedFrame[] = [];
	const entries: TimelineEntry[] = [];
	let stopped = false;
	/** Set when the stream dies mid-run; the next step() fails instead of recording nothing. */
	let streamFailure: Error | undefined;
	/** The daemon's latest `status` message, quoted when the stream stops. */
	let lastStatus: StreamStatusMessage | undefined;

	/** Highest frame `seq` seen; a frame at or below it is the daemon repeating its cached frame. */
	let lastSeq = 0;

	/** Sockets the recorder closed on purpose, to reconnect. */
	const retired = new WeakSet<WebSocket>();
	/** New frames each socket brought: the check counts only its own socket's. */
	const framesFrom = new WeakMap<WebSocket, number>();

	/** Frames, status and failures from `socket`, while it is the recorder's socket. */
	const listen = (socket: WebSocket) => {
		const current = () => socket === ws && !retired.has(socket) && !stopped;
		socket.on("close", (code) => {
			if (current()) {
				streamFailure = new Error(
					`agent-browser stream closed mid-run (code ${code}) — the daemon restarted or went away`,
				);
			}
		});
		socket.on("error", (err) => {
			if (current()) {
				streamFailure = new Error(`agent-browser stream error: ${err.message}`);
			}
		});
		socket.on("message", (raw) => {
			let msg: { type?: string };
			try {
				msg = JSON.parse(raw.toString()) as { type?: string };
			} catch {
				return;
			}
			if (msg.type === "status") {
				lastStatus = msg as StreamStatusMessage;
				return;
			}
			if (msg.type !== "frame") return;
			const frame = msg as StreamFrameMessage;
			if (typeof frame.data !== "string") return;
			// On connect the daemon first sends the newest frame it already has.
			// That is a copy of one we hold, or older: not a new picture.
			if (typeof frame.seq === "number") {
				if (frame.seq <= lastSeq) return;
				lastSeq = frame.seq;
			}
			// Prefer a real epoch-ms timestamp if a future agent-browser sends one;
			// 0.36 sends `metadata.timestamp: 0`, so fall back to receipt time.
			const meta = frame.metadata?.timestamp;
			const ts =
				typeof meta === "number" && Number.isFinite(meta) && meta > 1e12
					? meta
					: Date.now();
			frames.push({ timestamp: ts, data: frame.data, format: "jpeg" });
			framesFrom.set(socket, (framesFrom.get(socket) ?? 0) + 1);
		});
	};

	let ws: WebSocket;
	try {
		if (maxFps > 0) {
			const u = new URL(streamUrl);
			u.searchParams.set("maxFps", String(maxFps));
			streamUrl = u.toString();
		}
		ws = await openSocket(streamUrl, connectTimeoutMs, listen);
	} catch (err) {
		// We may have just enabled the daemon's stream; don't leave it
		// screencasting to nobody because the connect failed.
		if (enabledByUs) await client.disableStream();
		throw err;
	}
	const socketUrl = streamUrl;

	const countFrames = (from: number, to: number) =>
		frames.filter((f) => f.timestamp >= from && f.timestamp <= to).length;

	/**
	 * Close the socket and open a new one. With no one else watching, the
	 * daemon stops its capture when the last client leaves and starts it again
	 * for the next, and Chrome sends a frame of the page as it is at the start.
	 */
	const reconnect = async (settleMs: number) => {
		const old = ws;
		retired.add(old);
		await new Promise<void>((resolve) => {
			if (old.readyState === WebSocket.CLOSED) return resolve();
			old.once("close", () => resolve());
			old.close();
		});
		// Let the daemon count the old client out before the new one arrives;
		// otherwise it sees a client all along and does not restart the capture.
		await sleep(settleMs);
		ws = await openSocket(socketUrl, connectTimeoutMs, listen);
	};

	/**
	 * At the end of every step: reconnect to the stream, and wait for the new
	 * frame a live stream sends when its capture restarts. Returns a time that
	 * takes that frame in. Throws, naming the step, if none comes: the stream
	 * has stopped, and anything recorded from here on would show an earlier
	 * frame frozen.
	 */
	const checkStreamIsLive = async (
		instruction: string,
		/** How many frames the recorder held when the step began. */
		framesAtStepStart: number,
	): Promise<number> => {
		const stepNumber = entries.length + 1;
		const step = `step ${stepNumber} (${instruction})`;
		const before = frames.length;
		// A second try, after a longer pause, covers a daemon slow to see the
		// old socket go.
		let proved = false;
		for (const settleMs of [20, 250]) {
			try {
				await reconnect(settleMs);
			} catch (err) {
				throw new Error(
					`${step}: could not reconnect to agent-browser's stream to check it is still sending frames: ${err instanceof Error ? err.message : String(err)}`,
					{ cause: err },
				);
			}
			// Only a frame on the socket just opened proves the stream live now;
			// a late one from an earlier socket does not.
			const socket = ws;
			const deadline = Date.now() + frameCheckTimeoutMs / 2;
			while (
				!framesFrom.get(socket) &&
				!streamFailure &&
				Date.now() < deadline
			) {
				await sleep(10);
			}
			proved = (framesFrom.get(socket) ?? 0) > 0;
			if (proved || streamFailure) break;
		}
		if (streamFailure) {
			throw new Error(`${step}: cannot record — ${streamFailure.message}`, {
				cause: streamFailure,
			});
		}
		if (!proved) {
			throw new Error(
				[
					`${step}: agent-browser's stream has stopped sending frames.`,
					"Reconnecting to it at the end of the step, which makes a live stream send a new frame, brought none.",
					"Recording on would show an earlier frame, frozen, over this step and every step after it.",
					lastFrameNote(framesAtStepStart, stepNumber),
					statusNote(),
					"If something else is watching agent-browser's stream, such as its dashboard, close it: the stream restarts only when nothing else watches.",
					"Otherwise run the recording again; if it stops at this step again, record the steps from here on as their own video.",
				]
					.filter(Boolean)
					.join(" "),
			);
		}
		const arrived = frames.slice(before).map((f) => f.timestamp);
		return Math.max(Date.now(), ...arrived);
	};

	/** Which step the stream's last frame arrived in, for the stall message. */
	const lastFrameNote = (
		framesAtStepStart: number,
		stepNumber: number,
	): string => {
		const last = frames.at(-1);
		if (!last) return "No frame has arrived since the recording started.";
		if (frames.length > framesAtStepStart) {
			return `The last frame arrived earlier in step ${stepNumber}.`;
		}
		let i = entries.length - 1;
		while (i >= 0 && last.timestamp < entries[i].startTime) i--;
		return i >= 0
			? `The last frame arrived during step ${i + 1}.`
			: "The last frame arrived before step 1.";
	};

	const statusNote = (): string | undefined => {
		if (!lastStatus) return undefined;
		const size =
			lastStatus.viewportWidth && lastStatus.viewportHeight
				? ` at ${lastStatus.viewportWidth}x${lastStatus.viewportHeight}`
				: "";
		return `agent-browser last reported the stream as ${lastStatus.screencasting ? "capturing" : "not capturing"}${size}.`;
	};

	const stop = async () => {
		if (stopped) return;
		stopped = true;
		try {
			ws.close();
		} catch {
			// Socket may already be closed.
		}
		if (enabledByUs) {
			await client.disableStream();
		}
	};

	return {
		async step(commands, narrative, opts = {}) {
			if (stopped) {
				throw new Error(
					"AgentBrowserDemoRecorder.step: recorder has been stopped",
				);
			}
			if (streamFailure) {
				throw new Error(
					`AgentBrowserDemoRecorder.step: cannot record — ${streamFailure.message}`,
					{ cause: streamFailure },
				);
			}
			if (commands.length === 0) {
				throw new Error(
					"AgentBrowserDemoRecorder.step: commands must not be empty",
				);
			}
			const instruction = formatCommands(commands);
			const startTime = Date.now();
			const framesAtStart = frames.length;

			let results: BatchCommandResult[];
			try {
				results = await client.batch(commands, {
					bail: true,
					timeoutMs: opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
				});
			} catch (err) {
				throw new DemoStepError(
					`demo step failed to run (${instruction}): ${err instanceof Error ? err.message : String(err)}`,
					commands,
					[],
					{ cause: err },
				);
			}

			const failed = results.find((r) => !r.success);
			if (failed) {
				throw new DemoStepError(
					`demo step failed at \`${failed.command.join(" ")}\`: ${failed.error ?? "unknown error"}`,
					commands,
					results,
				);
			}
			if (results.length < commands.length) {
				throw new DemoStepError(
					`demo step ran ${results.length} of ${commands.length} commands (${instruction})`,
					commands,
					results,
				);
			}

			const trail = opts.trailingDelay ?? defaultTrailingDelay;
			if (trail > 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, trail));
			}
			let endTime = Date.now();
			let frameCount = countFrames(startTime, endTime);
			// Frames earlier in the step don't prove the stream still runs: it can
			// stop partway, after which a command changes the page unseen. So every
			// step is checked. The check's frame joins only a step that brought none;
			// a step with frames keeps its timing, and the frame just proves the
			// stream is live.
			const checkedAt = await checkStreamIsLive(instruction, framesAtStart);
			if (frameCount === 0) {
				endTime = checkedAt;
				frameCount = countFrames(startTime, endTime);
			}
			entries.push({
				instruction,
				narrative,
				startTime,
				endTime,
				frameCount,
				segmentDuration: (endTime - startTime) / 1000,
				...(opts.speech ? { speech: opts.speech } : {}),
			});
			return results;
		},
		timeline() {
			return { entries: [...entries], frames: [...frames] };
		},
		async stop() {
			await stop();
		},
		async render(opts = {}) {
			// A drop during or after the final step has no later step() to trip
			// the check — so check here too, before rendering a frozen video.
			if (streamFailure) {
				await stop();
				throw new Error(
					`AgentBrowserDemoRecorder.render: cannot render — ${streamFailure.message}`,
					{ cause: streamFailure },
				);
			}
			await stop();
			if (entries.length === 0) {
				throw new Error(
					"AgentBrowserDemoRecorder.render: no steps were recorded — nothing to render",
				);
			}
			const result = await renderTimeline({
				timeline: entries,
				frames,
				...opts,
			});
			return {
				videoPath: result.videoPath,
				outputDir: result.outputDir,
				durationSeconds: result.durationSeconds,
				timeline: [...entries],
				frames: [...frames],
				segments: result.segments,
			};
		},
	};
}

/**
 * Open the stream socket. `listen` is attached as the socket is created: the
 * daemon sends its status and newest frame the moment a client connects, and
 * they can arrive in the same read as the handshake.
 */
function openSocket(
	url: string,
	timeoutMs: number,
	listen: (ws: WebSocket) => void,
): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		listen(ws);
		const timer = setTimeout(() => {
			ws.terminate();
			reject(
				new Error(
					`attachAgentBrowserDemoRecorder: stream socket ${url} did not open within ${timeoutMs}ms`,
				),
			);
		}, timeoutMs);
		ws.once("open", () => {
			clearTimeout(timer);
			resolve(ws);
		});
		ws.once("error", (err) => {
			clearTimeout(timer);
			reject(
				new Error(
					`attachAgentBrowserDemoRecorder: could not connect to stream ${url}: ${err.message}`,
				),
			);
		});
	});
}

/** Hints an agent can act on, derived from how a step failed. */
export function stepFailureHints(err: DemoStepError): string[] {
	const hints: string[] = [];
	const failed = err.results.find((r) => !r.success);
	const selector = failed?.command[1] ?? "";
	if (/^text=/.test(selector)) {
		hints.push(
			'agent-browser has no `text=` selector syntax — use ["find", "text", "<label>", "click"].',
		);
	}
	if (/not found/i.test(err.message)) {
		hints.push(
			"Re-run `agent-browser snapshot -i` at this point in the flow and take the selector or @ref from there.",
		);
	}
	hints.push(
		"The page is now off-script: fix this step, then re-run the whole file (steps after it did not run).",
	);
	return hints;
}
