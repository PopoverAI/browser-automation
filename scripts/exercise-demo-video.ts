/**
 * End-to-end exercise of the demo-video pipeline.
 *
 * Spins up a local Playwright Stagehand session, attaches the demo recorder,
 * runs three narrated actions against Wikipedia, and renders the mp4.
 *
 * Required env:
 *   - GEMINI_API_KEY (or MODEL_API_KEY)  for stagehand.act
 *   - OPENAI_API_KEY                     for TTS
 *
 * Run from the worktree root:
 *   npx tsx scripts/exercise-demo-video.ts
 */

import { Stagehand } from "@browserbasehq/stagehand";
import { attachDemoRecorder } from "../src/demo/recorder.js";

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set — TTS will fail. Run with `OPENAI_API_KEY=$(secret openai-api-key) npx tsx scripts/exercise-demo-video.ts`.");
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY && !process.env.MODEL_API_KEY) {
    console.error("Neither GEMINI_API_KEY nor MODEL_API_KEY is set — Stagehand act calls will fail.");
    process.exit(1);
  }

  const modelApiKey = process.env.MODEL_API_KEY ?? process.env.GEMINI_API_KEY;

  console.log("[exercise] Initializing Stagehand (LOCAL mode)…");
  const stagehand = new Stagehand({
    env: "LOCAL",
    model: {
      apiKey: modelApiKey!,
      modelName: "google/gemini-3-flash-preview",
    },
    experimental: true,
    logger: (line) => {
      // Quiet by default — uncomment for full Stagehand logs.
      // console.error("stagehand:", line.message);
      void line;
    },
  });

  await stagehand.init();
  console.log("[exercise] Stagehand initialized.");

  try {
    const page = stagehand.context.pages()[0];
    if (!page) throw new Error("No active page in Stagehand context");
    await page.goto("https://en.wikipedia.org/wiki/Main_Page");

    console.log("[exercise] Attaching demo recorder…");
    const demo = await attachDemoRecorder(stagehand, { trailingDelay: 1500 });

    console.log("[exercise] Running 3 narrated actions…");
    await demo.act(
      "type 'browser automation' into the search box at the top of the page",
      "We start by searching Wikipedia for browser automation.",
    );
    await demo.act(
      "press Enter to submit the search",
      "Submitting the search to see the matching article.",
    );
    await demo.act(
      "scroll down so the article body is visible",
      "And here is the result.",
    );

    console.log("[exercise] Rendering video…");
    const t0 = Date.now();
    const result = await demo.render({ keepIntermediates: true });
    const renderMs = Date.now() - t0;

    console.log("[exercise] Done.");
    console.log("  videoPath:", result.videoPath);
    console.log("  outputDir:", result.outputDir);
    console.log("  renderMs: ", renderMs);
    console.log("  segments: ", result.timeline.length);
    for (const [i, e] of result.timeline.entries()) {
      console.log(
        `    ${i}: ${e.frameCount} frames over ${e.segmentDuration.toFixed(2)}s — "${e.narrative}"`,
      );
    }
  } finally {
    await stagehand.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("[exercise] FAILED:", err);
  if (err && typeof err === "object" && "partial" in err) {
    console.error("[exercise] partial state:", (err as { partial?: unknown }).partial);
  }
  process.exit(1);
});
