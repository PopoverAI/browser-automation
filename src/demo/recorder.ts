import type { Stagehand } from "@browserbasehq/stagehand";

import { renderTimeline, type RenderTimelineOptions } from "./render.js";

export interface CapturedFrame {
  /** Wall-clock timestamp (ms since epoch) when Node received the frame. */
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
  render(opts?: DemoRenderOptions): Promise<RenderResult>;
}

interface ScreencastFrameEvent {
  data: string;
  sessionId: string;
  metadata?: { timestamp?: number };
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

  const page = stagehand.context.activePage();
  if (!page) {
    throw new Error(
      "attachDemoRecorder: no active page on the Stagehand context",
    );
  }

  const frameId = page.mainFrameId();
  const cdp = page.getSessionForFrame(frameId);

  const frames: CapturedFrame[] = [];
  const entries: TimelineEntry[] = [];
  let stopped = false;

  const onFrame = (event: ScreencastFrameEvent) => {
    frames.push({ timestamp: Date.now(), data: event.data });
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
        `DemoRecorder.${methodLabel}: recorder has been stopped (render() was called)`,
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
