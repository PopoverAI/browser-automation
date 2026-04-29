/**
 * End-to-end exercise of the stagehand_demo_video MCP tool.
 *
 * Drives the same Context.run path the MCP server uses, so this validates
 * schema parsing, context wiring, error handling, and the tool's JSON return
 * shape — not just the underlying recorder API (which scripts/exercise-demo-video.ts covers).
 *
 * Required env:
 *   - GEMINI_API_KEY (or MODEL_API_KEY)  for stagehand.act
 *   - OPENAI_API_KEY                     for TTS
 *
 * Run from the worktree root:
 *   OPENAI_API_KEY=$(secret openai-api-key) GEMINI_API_KEY=$(secret gemini-api-key) \
 *     npx tsx scripts/exercise-demo-video-mcp.ts
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { randomUUID } from "node:crypto";

import { Context } from "../src/context.js";
import demoVideoTool from "../src/tools/demoVideo.js";
import type { Config } from "../config.d.ts";

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set — TTS will fail.");
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY && !process.env.MODEL_API_KEY) {
    console.error(
      "Neither GEMINI_API_KEY nor MODEL_API_KEY is set — Stagehand act calls will fail.",
    );
    process.exit(1);
  }

  // Mimic the config the smithery entry would pass, minus cloud-only fields.
  const config: Config = {
    cloud: false,
    modelName: "google/gemini-3-flash-preview",
    modelApiKey: process.env.MODEL_API_KEY ?? process.env.GEMINI_API_KEY,
    experimental: true,
  } as Config;

  // Context expects an MCP Server but only uses it for resource subscriptions,
  // not for the run() codepath we're exercising. A minimal stub is enough.
  const stubServer = {
    setRequestHandler: () => undefined,
    registerCapabilities: () => undefined,
  } as unknown as Server;

  const context = new Context(stubServer, config, randomUUID());

  console.log("[exercise-mcp] Pre-warming the default session…");
  // Warm up the default session and pre-navigate so the demo starts at a
  // known state. The MCP tool reuses the active session — same contract a
  // real agent would observe after calling stagehand_session_create.
  const stagehand = await context.getStagehand();
  const page = stagehand.context.pages()[0];
  if (!page) throw new Error("No active page in Stagehand context");
  await page.goto("https://en.wikipedia.org/wiki/Main_Page");

  console.log("[exercise-mcp] Invoking stagehand_demo_video via Context.run…");
  const t0 = Date.now();
  const result = await context.run(demoVideoTool, {
    actions: [
      {
        instruction: "type 'browser automation' into the search box at the top of the page",
        narrate: "Searching Wikipedia for browser automation.",
      },
      {
        instruction: "press Enter to submit the search",
        narrate: "Submitting the search.",
      },
    ],
  });
  const totalMs = Date.now() - t0;

  console.log("[exercise-mcp] Tool returned in", totalMs, "ms");
  console.log("[exercise-mcp] isError:", result.isError);
  console.log(
    "[exercise-mcp] content:",
    JSON.stringify(result.content, null, 2),
  );

  if (result.isError) {
    process.exit(1);
  }

  // Validate the JSON shape the tool promises.
  const text =
    result.content?.[0]?.type === "text" ? result.content[0].text : "";
  let parsed: {
    videoPath?: string;
    outputDir?: string;
    segments?: Array<{ index: number; instruction: string; narrative: string }>;
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error("[exercise-mcp] Tool response is not valid JSON:", text);
    process.exit(1);
  }
  if (!parsed.videoPath || !parsed.segments) {
    console.error(
      "[exercise-mcp] Tool response is missing videoPath/segments:",
      parsed,
    );
    process.exit(1);
  }
  console.log("[exercise-mcp] OK. Video at:", parsed.videoPath);

  // Cleanup.
  await context.getSessionManager().closeAllSessions();
}

main().catch((err) => {
  console.error("[exercise-mcp] FAILED:", err);
  process.exit(1);
});
