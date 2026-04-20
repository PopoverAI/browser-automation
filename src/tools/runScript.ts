import { z } from "zod";
import { resolve as resolvePath, isAbsolute } from "path";
import type { Tool, ToolSchema, ToolResult } from "./tool.js";
import type { Context } from "../context.js";
import type { ToolActionResult } from "../types/types.js";
import {
  loadScriptModule,
  resolveScriptFn,
  rewriteStack,
  type LoadInputs,
  type ScriptModule,
} from "../scriptLoader.js";

/**
 * Stagehand Run Script
 *
 * Loads a TypeScript or JavaScript file (or inline source) whose default
 * export is a function produced by `defineScript(...)` (from
 * `@popoverai/browser-automation/script`) and invokes it against the
 * current browser session.
 *
 * Scripts are the cheap, deterministic counterpart to agentic exploration:
 * a developer walks through a flow using stagehand_act/observe/extract once,
 * then commits a script that calls the same primitives directly. Replaying
 * the script costs one LLM call per step — no planning, no screenshot
 * recaps — while keeping Stagehand's resilience to UI drift.
 *
 * This tool uses the MCP's existing Stagehand session, so a single walk-and-
 * validate cycle happens in-process without spawning a fresh browser.
 */

// NB: Cross-field validation (exactly one of `path` / `source`) lives in the
// handler below, not here. `.refine()` on a ZodObject produces a ZodEffects,
// and the MCP SDK only registers tools whose input schema is a raw ZodObject
// — wrapping the schema silently drops the tool from `tools/list`.
const RunScriptInputSchema = z.object({
  path: z.string().min(1).optional().describe(
    `Path to a .ts or .js file whose default export was produced by
      defineScript(...). Relative paths resolve against the MCP process's
      current working directory. Bare imports from the script resolve
      against the script's own node_modules tree, so the script's project
      must have the needed deps installed (including
      @popoverai/browser-automation for defineScript). Mutually exclusive
      with \`source\`.`,
  ),
  source: z.string().min(1).optional().describe(
    `Inline script source as an alternative to \`path\`. Useful when the
      caller has no filesystem access, or when the script is ephemeral.
      The script is run from a temp location inside the MCP's own package,
      so bare imports (defineScript, zod, etc.) resolve against the MCP's
      node_modules — no install required anywhere else. Mutually exclusive
      with \`path\`.`,
  ),
  ctx: z.record(z.unknown()).optional().describe(
    `Optional context object forwarded to the script as \`ctx\`. The default
      Ctx shape accepts baseUrl, username, password, and any other string
      fields without schema declaration. Scripts that declare a custom Ctx
      generic are responsible for their own runtime validation.`,
  ),
});

type RunScriptInput = z.infer<typeof RunScriptInputSchema>;

const runScriptSchema: ToolSchema<typeof RunScriptInputSchema> = {
  name: "stagehand_run_script",
  description:
    `Run a Stagehand script (default export from defineScript) against the
      current browser session. Accepts either a file \`path\` or inline
      \`source\` — exactly one. Returns {status: "passed"|"failed", durationMs}.
      On failure also returns error and stack. Use after authoring a script
      to validate it; the MCP's live session is reused, so no separate setup
      is required. Inline \`source\` mode resolves bare imports against the
      MCP's own node_modules (no install needed); \`path\` mode resolves
      from the script's project.`,
  inputSchema: RunScriptInputSchema,
};

async function handleRunScript(
  context: Context,
  params: RunScriptInput,
): Promise<ToolResult> {
  const action = async (): Promise<ToolActionResult> => {
    // XOR validation: the input schema can't enforce this (see note on
    // RunScriptInputSchema), so do it here before any work.
    const hasPath = Boolean(params.path);
    const hasSource = Boolean(params.source);
    if (hasPath === hasSource) {
      throw new Error(
        "Exactly one of 'path' or 'source' must be provided.",
      );
    }

    // Build the load inputs + a displayLocation used in error messages and
    // stack rewriting. For path mode we show the user's original path;
    // for source mode we use a sentinel (the real location is an
    // MCP-internal temp file that we delete).
    let loadInputs: LoadInputs;
    let displayLabel: string;
    let displayLocation: { path: string } | { sentinel: string };

    if (params.path) {
      const absPath = isAbsolute(params.path)
        ? params.path
        : resolvePath(process.cwd(), params.path);
      loadInputs = { mode: "path", absPath };
      displayLabel = absPath;
      displayLocation = { path: absPath };
    } else {
      loadInputs = { mode: "source", source: params.source! };
      displayLabel = "<inline source>";
      displayLocation = { sentinel: "<inline source>" };
    }

    let mod: ScriptModule;
    let tempPath: string;
    try {
      const loaded = await loadScriptModule(loadInputs);
      mod = loaded.mod;
      tempPath = loaded.tempPath;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load script (${displayLabel}): ${errorMsg}`);
    }

    const script = resolveScriptFn(mod);
    if (!script) {
      throw new Error(
        `Script (${displayLabel}) must export a function as its default export. ` +
          `Use \`export default defineScript(async ({ stagehand, page, ctx }) => { ... });\`.`,
      );
    }

    const stagehand = await context.getStagehand();
    const page = stagehand.context.pages()[0];
    if (!page) {
      throw new Error("No active page in the current session");
    }

    const ctx = (params.ctx ?? {}) as Record<string, unknown>;
    const start = Date.now();

    try {
      await script({ stagehand, page, ctx });
      const durationMs = Date.now() - start;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "passed", durationMs }, null, 2),
          },
        ],
      };
    } catch (error) {
      const durationMs = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      const rawStack = error instanceof Error ? error.stack : undefined;
      const stack = rewriteStack(rawStack, tempPath, displayLocation);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { status: "failed", durationMs, error: message, stack },
              null,
              2,
            ),
          },
        ],
      };
    }
  };

  return {
    action,
    waitForNetwork: false,
  };
}

const runScriptTool: Tool<typeof RunScriptInputSchema> = {
  capability: "core",
  schema: runScriptSchema,
  handle: handleRunScript,
};

export default runScriptTool;
