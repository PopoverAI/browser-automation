import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the recorder module so we can drive demoVideoTool without spinning up
// a real Stagehand session. We need to mock before importing the tool.
const recorderState = {
  actCalls: [] as Array<{ instruction: string; narrate: string }>,
  actErrorOnIndex: -1,
  stopCalled: 0,
  stopThrows: false,
  renderCalled: 0,
};

vi.mock("../src/demo/recorder.js", () => ({
  attachDemoRecorder: vi.fn(async () => ({
    act: vi.fn(async (instruction: string, narrate: string) => {
      const idx = recorderState.actCalls.length;
      recorderState.actCalls.push({ instruction, narrate });
      if (idx === recorderState.actErrorOnIndex) {
        throw new Error(`simulated act failure at index ${idx}`);
      }
      return { success: true };
    }),
    agent: vi.fn(),
    timeline: () => ({ entries: [], frames: [] }),
    stop: vi.fn(async () => {
      recorderState.stopCalled++;
      if (recorderState.stopThrows) throw new Error("stop blew up");
    }),
    render: vi.fn(async () => {
      recorderState.renderCalled++;
      return {
        videoPath: "/tmp/fake.mp4",
        outputDir: "/tmp",
        timeline: [
          {
            instruction: recorderState.actCalls[0]?.instruction ?? "",
            narrative: recorderState.actCalls[0]?.narrate ?? "",
            startTime: 1000,
            endTime: 1100,
            frameCount: 1,
            segmentDuration: 0.1,
          },
        ],
        frames: [],
      };
    }),
  })),
}));

import demoVideoTool from "../src/tools/demoVideo.js";
import type { Context } from "../src/context.js";

function makeContext() {
  return {
    getStagehand: async () => ({}),
  } as unknown as Context;
}

describe("stagehand_demo_video tool handler", () => {
  beforeEach(() => {
    recorderState.actCalls = [];
    recorderState.actErrorOnIndex = -1;
    recorderState.stopCalled = 0;
    recorderState.stopThrows = false;
    recorderState.renderCalled = 0;
  });

  it("loops over actions and calls render() in the happy path", async () => {
    const ctx = makeContext();
    const toolResult = await demoVideoTool.handle(ctx, {
      actions: [
        { instruction: "step 1", narrate: "narrating 1" },
        { instruction: "step 2", narrate: "narrating 2" },
      ],
    });
    const out = await toolResult.action!();
    expect(recorderState.actCalls).toHaveLength(2);
    expect(recorderState.renderCalled).toBe(1);
    expect(recorderState.stopCalled).toBe(0);

    const text = (out?.content?.[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.videoPath).toBe("/tmp/fake.mp4");
    expect(parsed.segments).toHaveLength(1);
  });

  it("calls demo.stop() and surfaces a wrapped error when an action fails", async () => {
    // Regression for the silent-error-swallow concern: if an act throws,
    // cleanup must run, and the original error must propagate (not be
    // swallowed or replaced by the cleanup failure).
    recorderState.actErrorOnIndex = 1;

    const ctx = makeContext();
    const toolResult = await demoVideoTool.handle(ctx, {
      actions: [
        { instruction: "step 1", narrate: "ok" },
        { instruction: "step 2", narrate: "boom" },
        { instruction: "step 3", narrate: "never reached" },
      ],
    });

    await expect(toolResult.action!()).rejects.toThrow(
      /action failed.*simulated act failure at index 1/,
    );

    expect(recorderState.actCalls).toHaveLength(2); // step 3 never ran
    expect(recorderState.stopCalled).toBe(1);
    expect(recorderState.renderCalled).toBe(0);
  });

  it("logs but does not silently swallow cleanup failures", async () => {
    recorderState.actErrorOnIndex = 0;
    recorderState.stopThrows = true;

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const ctx = makeContext();
    const toolResult = await demoVideoTool.handle(ctx, {
      actions: [{ instruction: "doomed", narrate: "doomed" }],
    });

    let thrown: unknown;
    try {
      await toolResult.action!();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    // The cleanup failure should appear in stderr — not silently dropped.
    expect(stderrSpy).toHaveBeenCalled();
    const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toMatch(/cleanup stop\(\) failed.*stop blew up/);

    stderrSpy.mockRestore();
  });
});
