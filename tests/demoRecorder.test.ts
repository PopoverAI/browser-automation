import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Stagehand } from "@browserbasehq/stagehand";

import { attachDemoRecorder } from "../src/demo/recorder.js";

type CdpHandler = (params: unknown) => void;

class FakeCdp {
  public readonly id = "fake-session";
  public sent: Array<{ method: string; params?: object }> = [];
  private handlers = new Map<string, Set<CdpHandler>>();

  send = vi.fn(async (method: string, params?: object) => {
    this.sent.push({ method, params });
    return undefined;
  });

  on(event: string, handler: CdpHandler) {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  off(event: string, handler: CdpHandler) {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, params: unknown) {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of set) h(params);
  }

  hasListener(event: string) {
    return (this.handlers.get(event)?.size ?? 0) > 0;
  }
}

interface FakeStagehandOptions {
  /** Frames to inject during each act call. */
  framesPerAct?: number;
  /** Optional async work performed inside act. */
  actDelayMs?: number;
}

function makeFakeStagehand(cdp: FakeCdp, opts: FakeStagehandOptions = {}) {
  const { framesPerAct = 2, actDelayMs = 5 } = opts;

  const page = {
    mainFrameId: () => "main-frame",
    getSessionForFrame: () => cdp,
  };

  const act = vi.fn(async (instruction: string) => {
    if (actDelayMs > 0) {
      await new Promise<void>((r) => setTimeout(r, actDelayMs));
    }
    for (let i = 0; i < framesPerAct; i++) {
      cdp.emit("Page.screencastFrame", {
        data: `frame-${instruction}-${i}`,
        sessionId: cdp.id,
        metadata: { timestamp: Date.now() / 1000 },
      });
    }
    return { success: true };
  });

  const agentExecute = vi.fn(async (goal: string) => {
    if (actDelayMs > 0) {
      await new Promise<void>((r) => setTimeout(r, actDelayMs));
    }
    // Agents typically run for longer than a single act and emit more frames.
    for (let i = 0; i < framesPerAct * 3; i++) {
      cdp.emit("Page.screencastFrame", {
        data: `agent-${goal}-${i}`,
        sessionId: cdp.id,
        metadata: { timestamp: Date.now() / 1000 },
      });
    }
    return { success: true, completed: true, message: "ok", actions: [] };
  });

  const agentFactory = vi.fn(() => ({ execute: agentExecute }));

  const stagehand = {
    context: { activePage: () => page },
    act,
    agent: agentFactory,
  } as unknown as Stagehand;

  return { stagehand, act, agentExecute, agentFactory };
}

describe("attachDemoRecorder", () => {
  let cdp: FakeCdp;
  beforeEach(() => {
    cdp = new FakeCdp();
  });

  it("starts the screencast on attach with sensible defaults", async () => {
    const { stagehand } = makeFakeStagehand(cdp);
    await attachDemoRecorder(stagehand);

    const start = cdp.sent.find((c) => c.method === "Page.startScreencast");
    expect(start).toBeDefined();
    expect(start?.params).toEqual({
      format: "png",
      everyNthFrame: 1,
      maxWidth: 1280,
      maxHeight: 720,
    });
  });

  it("forwards maxWidth/maxHeight overrides to startScreencast", async () => {
    const { stagehand } = makeFakeStagehand(cdp);
    await attachDemoRecorder(stagehand, { maxWidth: 800, maxHeight: 600 });

    const start = cdp.sent.find((c) => c.method === "Page.startScreencast");
    expect(start?.params).toMatchObject({ maxWidth: 800, maxHeight: 600 });
  });

  it("captures frames and records timeline entries with non-zero frame counts", async () => {
    const { stagehand, act } = makeFakeStagehand(cdp, {
      framesPerAct: 3,
      actDelayMs: 5,
    });

    const demo = await attachDemoRecorder(stagehand, { trailingDelay: 50 });

    await demo.act("go to login", "navigating to login");
    await demo.act("submit", "submitting the form");

    expect(act).toHaveBeenCalledTimes(2);

    const { entries, frames } = demo.timeline();
    expect(entries).toHaveLength(2);
    expect(frames.length).toBeGreaterThanOrEqual(6);

    expect(entries[0]).toMatchObject({
      instruction: "go to login",
      narrative: "navigating to login",
    });
    expect(entries[0].endTime).toBeGreaterThanOrEqual(entries[0].startTime);
    expect(entries[0].frameCount).toBeGreaterThan(0);
    expect(entries[0].segmentDuration).toBeGreaterThan(0);

    expect(entries[1].startTime).toBeGreaterThanOrEqual(entries[0].endTime);
  });

  it("acks every frame the listener receives", async () => {
    const { stagehand } = makeFakeStagehand(cdp, { framesPerAct: 4 });
    const demo = await attachDemoRecorder(stagehand, { trailingDelay: 10 });

    await demo.act("do thing", "doing the thing");
    // Drain microtasks so the fire-and-forget ack sends settle.
    await new Promise<void>((r) => setTimeout(r, 0));

    const acks = cdp.sent.filter(
      (c) => c.method === "Page.screencastFrameAck",
    );
    expect(acks.length).toBe(4);
    for (const ack of acks) {
      expect(ack.params).toEqual({ sessionId: cdp.id });
    }
  });

  it("excludes frames captured outside any act window from frameCount", async () => {
    const { stagehand } = makeFakeStagehand(cdp, {
      framesPerAct: 2,
      actDelayMs: 5,
    });
    const demo = await attachDemoRecorder(stagehand, { trailingDelay: 30 });

    await demo.act("first", "first narrative");

    // Simulate a bare stagehand.extract() between acts: emit untracked frames.
    await new Promise<void>((r) => setTimeout(r, 50));
    cdp.emit("Page.screencastFrame", {
      data: "between-1",
      sessionId: cdp.id,
      metadata: { timestamp: Date.now() / 1000 },
    });
    cdp.emit("Page.screencastFrame", {
      data: "between-2",
      sessionId: cdp.id,
      metadata: { timestamp: Date.now() / 1000 },
    });
    await new Promise<void>((r) => setTimeout(r, 50));

    await demo.act("second", "second narrative");

    const { entries, frames } = demo.timeline();
    const totalAccountedFor = entries.reduce(
      (sum, e) => sum + e.frameCount,
      0,
    );
    expect(frames.length).toBe(totalAccountedFor + 2);
  });

  it("render() stops the screencast and detaches the listener", async () => {
    const { stagehand } = makeFakeStagehand(cdp);
    const demo = await attachDemoRecorder(stagehand, { trailingDelay: 10 });

    // No acts recorded — render should throw, but we still want to verify
    // that the screencast got stopped before the throw.
    expect(cdp.hasListener("Page.screencastFrame")).toBe(true);

    await expect(demo.render()).rejects.toThrow(/no demo\.act calls/);

    expect(cdp.sent.some((c) => c.method === "Page.stopScreencast")).toBe(true);
    expect(cdp.hasListener("Page.screencastFrame")).toBe(false);
  });

  it("act() throws after render()", async () => {
    const { stagehand } = makeFakeStagehand(cdp);
    const demo = await attachDemoRecorder(stagehand);

    // render() throws (no acts), but it still detaches; subsequent act should
    // also throw with the recorder-stopped error.
    await expect(demo.render()).rejects.toThrow();
    await expect(
      demo.act("post-render", "should fail"),
    ).rejects.toThrow(/recorder has been stopped/);
  });

  it("agent() records a single timeline entry spanning the whole agent run", async () => {
    const { stagehand, agentFactory, agentExecute } = makeFakeStagehand(cdp, {
      framesPerAct: 2,
      actDelayMs: 5,
    });
    const demo = await attachDemoRecorder(stagehand, { trailingDelay: 30 });

    await demo.agent("complete the checkout flow", "the agent completes the checkout", {
      agentConfig: { mode: "hybrid" } as Parameters<Stagehand["agent"]>[0],
    });

    expect(agentFactory).toHaveBeenCalledTimes(1);
    expect(agentFactory.mock.calls[0][0]).toEqual({ mode: "hybrid" });
    expect(agentExecute).toHaveBeenCalledTimes(1);
    expect(agentExecute.mock.calls[0][0]).toBe("complete the checkout flow");

    const { entries } = demo.timeline();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      instruction: "complete the checkout flow",
      narrative: "the agent completes the checkout",
    });
    // Agent emits 6 frames (framesPerAct * 3); all should fall in the segment.
    expect(entries[0].frameCount).toBeGreaterThanOrEqual(6);
  });

  it("agent() throws after render()", async () => {
    const { stagehand } = makeFakeStagehand(cdp);
    const demo = await attachDemoRecorder(stagehand);
    await expect(demo.render()).rejects.toThrow();
    await expect(
      demo.agent("post-render", "should fail"),
    ).rejects.toThrow(/recorder has been stopped/);
  });

  it("throws if Stagehand has no active page", async () => {
    const stagehand = {
      context: { activePage: () => undefined },
      act: vi.fn(),
    } as unknown as Stagehand;

    await expect(attachDemoRecorder(stagehand)).rejects.toThrow(
      /no active page/,
    );
  });
});
