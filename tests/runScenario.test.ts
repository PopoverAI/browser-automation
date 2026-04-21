import { describe, it, expect, beforeEach, vi } from "vitest";

type MockStagehandState = {
  sessionId?: string;
  sessionUrl?: string;
  agentResult: { output?: unknown };
  agentError?: Error;
};

const stagehandState: MockStagehandState = {
  agentResult: {
    output: {
      results: [{ status: "passed", notes: "ok", key: "a" }],
    },
  },
};

vi.mock("@browserbasehq/stagehand", () => {
  class MockStagehand {
    get browserbaseSessionID() {
      return stagehandState.sessionId;
    }
    get browserbaseSessionURL() {
      return stagehandState.sessionUrl;
    }
    get context() {
      return { pages: () => [{ goto: async () => undefined }] };
    }
    async init() {}
    async close() {}
    agent() {
      return {
        execute: async () => {
          if (stagehandState.agentError) throw stagehandState.agentError;
          return stagehandState.agentResult;
        },
      };
    }
  }
  return { Stagehand: MockStagehand };
});

import { runScenario } from "../src/runScenario.js";
import type { Scenario } from "../src/scenario.js";

const scenario: Scenario = {
  baseUrl: "https://example.com",
  steps: [
    { step: "arrange", description: "navigate" },
    { step: "act", description: "do something" },
    { step: "assert", description: "something is true", key: "a" },
  ],
};

describe("runScenario — browserbase session fields on result", () => {
  beforeEach(() => {
    stagehandState.sessionId = undefined;
    stagehandState.sessionUrl = undefined;
    stagehandState.agentError = undefined;
    stagehandState.agentResult = {
      output: {
        results: [{ status: "passed", notes: "ok", key: "a" }],
      },
    };
  });

  it("omits session fields when Stagehand exposes no session (LOCAL)", async () => {
    const result = await runScenario({ scenario, env: "LOCAL" });

    expect(result.structured).toBe(true);
    expect("browserbaseSessionId" in result).toBe(false);
    expect("browserbaseSessionUrl" in result).toBe(false);
  });

  it("propagates session id and url from Stagehand (BROWSERBASE)", async () => {
    stagehandState.sessionId = "sess_abc123";
    stagehandState.sessionUrl =
      "https://www.browserbase.com/sessions/sess_abc123";

    const result = await runScenario({ scenario, env: "BROWSERBASE" });

    expect(result.browserbaseSessionId).toBe("sess_abc123");
    expect(result.browserbaseSessionUrl).toBe(
      "https://www.browserbase.com/sessions/sess_abc123",
    );
  });

  it("still exposes session fields on the no-structured-output fallback branch", async () => {
    stagehandState.sessionId = "sess_xyz";
    stagehandState.sessionUrl = "https://www.browserbase.com/sessions/sess_xyz";
    stagehandState.agentResult = { output: undefined };

    const result = await runScenario({ scenario, env: "BROWSERBASE" });

    expect(result.structured).toBe(false);
    expect(result.browserbaseSessionId).toBe("sess_xyz");
    expect(result.browserbaseSessionUrl).toBe(
      "https://www.browserbase.com/sessions/sess_xyz",
    );
  });

  it("still exposes session fields when agent.execute throws after init", async () => {
    stagehandState.sessionId = "sess_err";
    stagehandState.sessionUrl = "https://www.browserbase.com/sessions/sess_err";
    stagehandState.agentError = new Error("boom");

    const result = await runScenario({ scenario, env: "BROWSERBASE" });

    expect(result.structured).toBe(false);
    expect(result.results.every((r) => r.status === "blocked")).toBe(true);
    expect(result.results[0].notes).toContain("boom");
    expect(result.browserbaseSessionId).toBe("sess_err");
    expect(result.browserbaseSessionUrl).toBe(
      "https://www.browserbase.com/sessions/sess_err",
    );
  });
});
