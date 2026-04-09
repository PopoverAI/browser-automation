import { z } from "zod";
import { execSync } from "child_process";
import { Browserbase } from "@browserbasehq/sdk";
import type { Tool, ToolSchema, ToolResult } from "./tool.js";
import type { Context } from "../context.js";
import type { ToolActionResult } from "../types/types.js";

// Track whether the agent-browser daemon is connected to the current session
let connectedSessionId: string | null = null;

/**
 * Connect the agent-browser daemon to the current session's browser via CDP.
 * Local sessions use stagehand.connectURL(), cloud sessions use Browserbase debug wsUrl.
 */
async function ensureConnected(context: Context): Promise<void> {
  const activeSessionId = context.currentSessionId;

  if (connectedSessionId === activeSessionId) {
    return;
  }

  const sessionManager = context.getSessionManager();
  const session = await sessionManager.getSession(
    activeSessionId,
    context.config,
    false,
  );

  if (!session) {
    throw new Error(
      "No active browser session. Call stagehand_session_create first.",
    );
  }

  const isCloud = !!session.stagehand.browserbaseSessionId;
  let cdpUrl: string;

  if (isCloud) {
    const browserbaseSessionId = session.stagehand.browserbaseSessionId!;
    const bb = new Browserbase({ apiKey: context.config.browserbaseApiKey! });
    const debugInfo = await bb.sessions.debug(browserbaseSessionId);
    cdpUrl = debugInfo.wsUrl;
    if (!cdpUrl) {
      throw new Error("Browserbase sessions.debug() returned empty wsUrl");
    }
  } else {
    cdpUrl = session.stagehand.connectURL();
    if (!cdpUrl) {
      throw new Error("No CDP URL available from local session");
    }
  }

  process.stderr.write(
    `[agent-browser] Connecting daemon to ${isCloud ? "cloud" : "local"} session via CDP\n`,
  );

  try {
    execSync(`npx agent-browser close --all`, { stdio: "pipe" });
  } catch {
    // Ignore — no existing session to close
  }

  execSync(`npx agent-browser connect "${cdpUrl}"`, {
    stdio: "pipe",
    timeout: 10000,
  });

  connectedSessionId = activeSessionId;
  process.stderr.write(`[agent-browser] Connected to session ${activeSessionId}\n`);
}

/**
 * Disconnect the agent-browser daemon (called on session close/change).
 */
export function disconnectAgentBrowser(): void {
  if (connectedSessionId) {
    try {
      execSync(`npx agent-browser close --all`, { stdio: "pipe" });
    } catch {
      // Best effort
    }
    connectedSessionId = null;
  }
}

// --- Tool: Help ---

const HelpInputSchema = z.object({});

const helpSchema: ToolSchema<typeof HelpInputSchema> = {
  name: "agent_browser_help",
  description:
    "Show help for agent-browser, a low-level browser automation CLI for precise, deterministic control. Call this to see available commands.",
  inputSchema: HelpInputSchema,
};

const SESSION_GUIDANCE = `## Session Notes

agent-browser shares the browser session managed by Stagehand via CDP.
Both tools see the same page, cookies, and DOM.

**Avoid these commands** (they break the shared session):
- close, close --all — kills the browser Stagehand is using
- connect — reconnects daemon to a different browser
- session — agent-browser's own session management, bypasses Stagehand
- tab new, tab close, tab <n> — Stagehand loses track of the active page

**For localhost URLs in cloud sessions**, use stagehand_navigate (has ngrok tunneling).

---

`;

async function handleHelp(): Promise<ToolResult> {
  const action = async (): Promise<ToolActionResult> => {
    const output = execSync("npx agent-browser --help", {
      encoding: "utf-8",
      timeout: 10000,
    });

    return {
      content: [{ type: "text", text: SESSION_GUIDANCE + output }],
    };
  };

  return { action, waitForNetwork: false };
}

const helpTool: Tool<typeof HelpInputSchema> = {
  capability: "core",
  schema: helpSchema,
  handle: handleHelp,
};

// --- Tool: Run ---

const RunInputSchema = z.object({
  args: z
    .string()
    .describe(
      "Arguments to pass to agent-browser CLI (e.g. 'snapshot -i', 'click @e2', 'open https://example.com')",
    ),
});

type RunInput = z.infer<typeof RunInputSchema>;

const runSchema: ToolSchema<typeof RunInputSchema> = {
  name: "agent_browser_run",
  description:
    "Run a low-level browser command. Use over Stagehand when you need precise, deterministic control — element-by-ref interactions, DOM inspection, network debugging, JS evaluation. Shares the same browser session as Stagehand.",
  inputSchema: RunInputSchema,
};

async function handleRun(
  context: Context,
  params: RunInput,
): Promise<ToolResult> {
  const action = async (): Promise<ToolActionResult> => {
    await ensureConnected(context);

    const output = execSync(`npx agent-browser ${params.args}`, {
      encoding: "utf-8",
      timeout: 30000,
    });

    return {
      content: [{ type: "text", text: output }],
    };
  };

  return { action, waitForNetwork: false };
}

const runTool: Tool<typeof RunInputSchema> = {
  capability: "core",
  schema: runSchema,
  handle: handleRun,
};

export default [helpTool, runTool];
