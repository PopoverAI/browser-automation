import type { Stagehand } from "@browserbasehq/stagehand";

import { renderTimeline, type RenderTimelineOptions } from "./render.js";

export interface CapturedFrame {
  /**
   * Wall-clock timestamp (ms since epoch) the browser captured the frame.
   * Sourced from CDP's `Page.screencastFrame` `metadata.timestamp` (UTC
   * seconds since epoch, multiplied by 1000) — not Node's `Date.now()` —
   * to avoid event-loop jitter shifting frames across segment boundaries.
   * Falls back to `Date.now()` if the CDP event omits the timestamp.
   */
  timestamp: number;
  /** Base64-encoded PNG data. */
  data: string;
}

export interface TimelineEntry {
  instruction: string;
  narrative: string;
  /** Wall-clock ms since epoch — start of demo.act call. */
  startTime: number;
  /** Wall-clock ms since epoch — end of demo.act call (after trailingDelay). */
  endTime: number;
  /** Number of frames whose timestamp fell within [startTime, endTime]. */
  frameCount: number;
  /** (endTime - startTime) / 1000, in seconds. */
  segmentDuration: number;
}

export interface AttachDemoRecorderOptions {
  /** CDP screencast max width (default 1280). */
  maxWidth?: number;
  /** CDP screencast max height (default 720). */
  maxHeight?: number;
  /**
   * Default trailing delay (ms) applied after every demo.act call so in-flight
   * frames arrive before the action's endTime is recorded. Default 1000ms.
   * Overridable per-call.
   */
  trailingDelay?: number;
}

export interface DemoActOptions {
  /** Override the recorder's default trailingDelay for this single call. */
  trailingDelay?: number;
  /** Pass-through options forwarded to stagehand.act. */
  actOptions?: Parameters<Stagehand["act"]>[1];
}

type StagehandAgent = ReturnType<Stagehand["agent"]>;
type StagehandAgentConfig = Parameters<Stagehand["agent"]>[0];

export interface DemoAgentOptions {
  /** Override the recorder's default trailingDelay for this single call. */
  trailingDelay?: number;
  /** Pass-through agent configuration forwarded to stagehand.agent(). */
  agentConfig?: StagehandAgentConfig;
}

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

export interface DemoRecorder {
  act(
    instruction: string,
    narrative: string,
    opts?: DemoActOptions,
  ): Promise<Awaited<ReturnType<Stagehand["act"]>>>;
  agent(
    goal: string,
    narrative: string,
    opts?: DemoAgentOptions,
  ): Promise<Awaited<ReturnType<StagehandAgent["execute"]>>>;
  timeline(): { entries: TimelineEntry[]; frames: CapturedFrame[] };
  /**
   * Stop the screencast and detach the listener without rendering. Idempotent
   * — calling stop() multiple times, or before render(), is safe. Use when the
   * caller wants to abort cleanup in a `finally` without producing an mp4.
   */
  stop(): Promise<void>;
  render(opts?: DemoRenderOptions): Promise<RenderResult>;
}

interface ScreencastFrameEvent {
  data: string;
  sessionId: string;
  metadata?: { timestamp?: number };
}

/**
 * Acquire the CDP session backing the active page, going through Stagehand v3's
 * internal page surface. v3 does not expose a public Playwright `Page` (that
 * was the v2 surface), so this is the only path. We runtime-guard each step
 * with a clear error so a future Stagehand upgrade that moves these methods
 * fails loudly rather than producing cryptic NPEs.
 */
function acquireCdpForActivePage(stagehand: Stagehand) {
  const ctx = stagehand.context;
  if (!ctx || typeof ctx.activePage !== "function") {
    throw new Error(
      "attachDemoRecorder: stagehand.context.activePage is not a function — Stagehand v3 internal API may have changed.",
    );
  }
  const page = ctx.activePage();
  if (!page) {
    throw new Error(
      "attachDemoRecorder: no active page on the Stagehand context",
    );
  }
  const pageAny = page as unknown as {
    mainFrameId?: () => string;
    getSessionForFrame?: (id: string) => unknown;
  };
  if (typeof pageAny.mainFrameId !== "function") {
    throw new Error(
      "attachDemoRecorder: page.mainFrameId is not a function — Stagehand v3 internal API may have changed.",
    );
  }
  if (typeof pageAny.getSessionForFrame !== "function") {
    throw new Error(
      "attachDemoRecorder: page.getSessionForFrame is not a function — Stagehand v3 internal API may have changed.",
    );
  }
  return pageAny.getSessionForFrame(pageAny.mainFrameId()) as {
    on: (
      event: string,
      handler: (event: ScreencastFrameEvent) => void,
    ) => void;
    off: (
      event: string,
      handler: (event: ScreencastFrameEvent) => void,
    ) => void;
    send: (method: string, params?: unknown) => Promise<unknown>;
  };
}

/**
 * Attach a demo recorder to an already-initialized Stagehand instance.
 *
 * Starts a CDP screencast on the active page, accumulates frames into an
 * in-memory buffer, and exposes `demo.act` for narrated actions. The
 * underlying `stagehand` instance remains the canonical surface for everything
 * else (extract, observe, navigate, etc.); this recorder is purely additive.
 *
 * Frames captured during un-narrated time (between `demo.act` calls) live in
 * the buffer but are filtered out at render time by timestamp.
 */
export async function attachDemoRecorder(
  stagehand: Stagehand,
  options: AttachDemoRecorderOptions = {},
): Promise<DemoRecorder> {
  const {
    maxWidth = 1280,
    maxHeight = 720,
    trailingDelay: defaultTrailingDelay = 1000,
  } = options;

  const cdp = acquireCdpForActivePage(stagehand);

  const frames: CapturedFrame[] = [];
  const entries: TimelineEntry[] = [];
  let stopped = false;

  const onFrame = (event: ScreencastFrameEvent) => {
    // Prefer CDP's wall-clock timestamp (seconds since epoch) over
    // Date.now(): the latter records when JS got around to processing the
    // event, which can drift tens of ms under load and shift frames across
    // segment boundaries.
    const cdpTs = event.metadata?.timestamp;
    const ts =
      typeof cdpTs === "number" && Number.isFinite(cdpTs)
        ? cdpTs * 1000
        : Date.now();
    frames.push({ timestamp: ts, data: event.data });
    void cdp
      .send("Page.screencastFrameAck", { sessionId: event.sessionId })
      .catch(() => {
        // Session may already be closing — non-fatal.
      });
  };

  cdp.on("Page.screencastFrame", onFrame);

  await cdp.send("Page.startScreencast", {
    format: "png",
    everyNthFrame: 1,
    maxWidth,
    maxHeight,
  });

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await cdp.send("Page.stopScreencast");
    } catch {
      // Ignore — best-effort.
    }
    cdp.off("Page.screencastFrame", onFrame);
  };

  const recordSegment = async <R>(
    instruction: string,
    narrative: string,
    trailingDelay: number | undefined,
    methodLabel: "act" | "agent",
    run: () => Promise<R>,
  ): Promise<R> => {
    if (stopped) {
      throw new Error(
        `DemoRecorder.${methodLabel}: recorder has been stopped`,
      );
    }
    const startTime = Date.now();
    const result = await run();
    const trail = trailingDelay ?? defaultTrailingDelay;
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
    return result;
  };

  return {
    async act(instruction, narrative, opts = {}) {
      return recordSegment(instruction, narrative, opts.trailingDelay, "act", () =>
        stagehand.act(instruction, opts.actOptions),
      );
    },
    async agent(goal, narrative, opts = {}) {
      const agent = stagehand.agent(opts.agentConfig);
      return recordSegment(goal, narrative, opts.trailingDelay, "agent", () =>
        agent.execute(goal),
      );
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
          "DemoRecorder.render: no demo.act calls were recorded — nothing to render",
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
