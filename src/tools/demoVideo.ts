import { z } from "zod";
import type { Tool, ToolSchema, ToolResult } from "./tool.js";
import type { Context } from "../context.js";
import type { ToolActionResult } from "../types/types.js";

import { attachDemoRecorder } from "../demo/recorder.js";

const ActionSchema = z.object({
  instruction: z
    .string()
    .describe(
      "The Stagehand action instruction to perform (e.g. 'click the sign in button', 'type %email% into the email field').",
    ),
  narrate: z
    .string()
    .describe(
      "The narration spoken over this action's video segment. Decide narration at planning time, not by inferring intent later.",
    ),
});

const DemoVideoInputSchema = z.object({
  actions: z
    .array(ActionSchema)
    .min(1)
    .describe(
      "Ordered list of {instruction, narrate} pairs. Each action runs through stagehand.act and becomes one narrated segment of the final video.",
    ),
  outputDir: z
    .string()
    .optional()
    .describe(
      "Absolute directory to write the mp4 (and any intermediates). Defaults to a unique subdir under the OS temp dir.",
    ),
  voice: z
    .string()
    .optional()
    .describe("OpenAI TTS voice id. Default: 'alloy'."),
  keepIntermediates: z
    .boolean()
    .optional()
    .describe(
      "If true, keep the per-segment audio + mp4 + frame PNGs alongside final.mp4. Default: false (cleaned up).",
    ),
  trailingDelay: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Milliseconds to wait after each action before recording its end timestamp. Default: 1000ms. Lets in-flight CDP frames arrive.",
    ),
  maxWidth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Screencast capture max width. Default: 1280."),
  maxHeight: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Screencast capture max height. Default: 720."),
});

type DemoVideoInput = z.infer<typeof DemoVideoInputSchema>;

const demoVideoSchema: ToolSchema<typeof DemoVideoInputSchema> = {
  name: "stagehand_demo_video",
  description:
    "Record a narrated demo video of a known-good Stagehand script. Each action runs through stagehand.act with a CDP screencast attached; per-action narration is generated via OpenAI TTS; per-segment mp4s are concatenated into a single final.mp4. Uses the active Stagehand session — make sure the page is at the desired starting state before calling. Requires OPENAI_API_KEY.",
  inputSchema: DemoVideoInputSchema,
};

async function handleDemoVideo(
  context: Context,
  params: DemoVideoInput,
): Promise<ToolResult> {
  const action = async (): Promise<ToolActionResult> => {
    const stagehand = await context.getStagehand();

    const demo = await attachDemoRecorder(stagehand, {
      maxWidth: params.maxWidth,
      maxHeight: params.maxHeight,
      trailingDelay: params.trailingDelay,
    });

    try {
      for (const a of params.actions) {
        await demo.act(a.instruction, a.narrate);
      }
    } catch (err) {
      // Best-effort detach so the screencast doesn't keep running.
      await demo.render().catch(() => undefined);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`stagehand_demo_video: action failed — ${msg}`);
    }

    const result = await demo.render({
      outputDir: params.outputDir,
      voice: params.voice,
      keepIntermediates: params.keepIntermediates,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              videoPath: result.videoPath,
              outputDir: result.outputDir,
              segments: result.timeline.map((entry, i) => ({
                index: i,
                instruction: entry.instruction,
                narrative: entry.narrative,
                segmentDuration: entry.segmentDuration,
                frameCount: entry.frameCount,
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  };

  return {
    action,
    waitForNetwork: false,
  };
}

const demoVideoTool: Tool<typeof DemoVideoInputSchema> = {
  capability: "core",
  schema: demoVideoSchema,
  handle: handleDemoVideo,
};

export default demoVideoTool;
