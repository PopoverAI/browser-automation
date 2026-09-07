import WebSocket from "ws";

import {
  AgentBrowserClient,
  type BatchCommandResult,
} from "./agentBrowserClient.js";
import { renderTimeline, type RenderTimelineOptions } from "./render.js";
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
  timeline: TimelineEntry[];
  /** Raw frame buffer — exposed primarily for testing/inspection. */
  frames: CapturedFrame[];
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
  data: string;
  metadata?: { timestamp?: number };
}

const DEFAULT_STEP_TIMEOUT_MS = 120_000;

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

  let streamUrl = options.streamUrl;
  let enabledByUs = false;
  if (!streamUrl) {
    const s = await client.ensureStream();
    streamUrl = s.url;
    enabledByUs = s.enabledByUs;
  }
  if (maxFps > 0) {
    const u = new URL(streamUrl);
    u.searchParams.set("maxFps", String(maxFps));
    streamUrl = u.toString();
  }

  const frames: CapturedFrame[] = [];
  const entries: TimelineEntry[] = [];
  let stopped = false;

  const ws = await openSocket(streamUrl, connectTimeoutMs);

  ws.on("message", (raw) => {
    let msg: { type?: string };
    try {
      msg = JSON.parse(raw.toString()) as { type?: string };
    } catch {
      return;
    }
    if (msg.type !== "frame") return;
    const frame = msg as StreamFrameMessage;
    if (typeof frame.data !== "string") return;
    // Prefer a real epoch-ms timestamp if a future agent-browser sends one;
    // 0.36 sends `metadata.timestamp: 0`, so fall back to receipt time.
    const meta = frame.metadata?.timestamp;
    const ts =
      typeof meta === "number" && Number.isFinite(meta) && meta > 1e12
        ? meta
        : Date.now();
    frames.push({ timestamp: ts, data: frame.data, format: "jpeg" });
  });

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
      if (commands.length === 0) {
        throw new Error(
          "AgentBrowserDemoRecorder.step: commands must not be empty",
        );
      }
      const instruction = formatCommands(commands);
      const startTime = Date.now();

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
      const endTime = Date.now();
      let frameCount = 0;
      for (const f of frames) {
        if (f.timestamp >= startTime && f.timestamp <= endTime) frameCount++;
      }
      entries.push({
        instruction,
        narrative,
        startTime,
        endTime,
        frameCount,
        segmentDuration: (endTime - startTime) / 1000,
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
        timeline: [...entries],
        frames: [...frames],
      };
    },
  };
}

function openSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
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
