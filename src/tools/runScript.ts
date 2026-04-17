import { z } from "zod";
import { pathToFileURL } from "url";
import { resolve as resolvePath, isAbsolute } from "path";
import type { Tool, ToolSchema, ToolResult } from "./tool.js";
import type { Context } from "../context.js";
import type { ToolActionResult } from "../types/types.js";

/**
 * Stagehand Run Script
 *
 * Loads a TypeScript or JavaScript file whose default export is a function
 * produced by `defineScript(...)` (from `@popoverai/browser-automation/script`)
 * and invokes it against the current browser session.
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

const RunScriptInputSchema = z.object({
  path: z.string().describe(
    `Path to a .ts or .js file whose default export was produced by
      defineScript(...). Relative paths resolve against the MCP process's
      current working directory (typically the agent's project root).`,
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
    `Run a Stagehand script file (default export from defineScript) against
      the current browser session. Returns {status: "passed"|"failed", durationMs}.
      On failure also returns error and stack. Use after authoring a script to
      validate it; the MCP's live session is reused, so no separate setup is
      required.`,
  inputSchema: RunScriptInputSchema,
};

// tsx's ESM loader hook is registered lazily on first .ts import. Registering
// it is a no-op on subsequent calls and keeps the MCP startup lean for
// sessions that never run a script.
let tsxRegistered = false;
async function ensureTsxLoader(): Promise<void> {
  if (tsxRegistered) return;
  try {
    const api = (await import("tsx/esm/api")) as {
      register?: () => unknown;
    };
    if (typeof api.register === "function") {
      api.register();
    }
    tsxRegistered = true;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to register tsx loader for TypeScript scripts: ${errorMsg}. ` +
        `Ensure tsx is installed alongside @popoverai/browser-automation.`,
    );
  }
}

type ScriptFn = (args: {
  stagehand: unknown;
  page: unknown;
  ctx: Record<string, unknown>;
}) => Promise<void>;

type ScriptModule = {
  default?: ScriptFn | { default?: ScriptFn; __esModule?: boolean };
};

/**
 * Resolve the script function from a dynamically imported module.
 *
 * For ESM sources (repos with "type": "module" or .mts files), the function
 * lives at `mod.default`. For TS files compiled to CJS by tsx (repos without
 * "type": "module"), Node's ESM loader wraps the CJS module so that the
 * original `export default fn` ends up at `mod.default.default` alongside an
 * `__esModule: true` marker. We accept both shapes so users don't have to
 * think about their repo's module mode.
 */
function resolveScriptFn(mod: ScriptModule): ScriptFn | undefined {
  const direct = mod.default;
  if (typeof direct === "function") return direct;
  if (direct && typeof direct === "object" && typeof direct.default === "function") {
    return direct.default;
  }
  return undefined;
}

async function handleRunScript(
  context: Context,
  params: RunScriptInput,
): Promise<ToolResult> {
  const action = async (): Promise<ToolActionResult> => {
    const absPath = isAbsolute(params.path)
      ? params.path
      : resolvePath(process.cwd(), params.path);

    const isTs = absPath.endsWith(".ts") || absPath.endsWith(".tsx")
      || absPath.endsWith(".mts") || absPath.endsWith(".cts");

    if (isTs) {
      await ensureTsxLoader();
    }

    // Cache-bust so edits made between runs within a single MCP session are
    // picked up. Without this query suffix Node's module cache would serve
    // the stale version.
    const fileUrl = `${pathToFileURL(absPath).href}?t=${Date.now()}`;

    let mod: ScriptModule;
    try {
      mod = (await import(fileUrl)) as ScriptModule;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load script at ${params.path}: ${errorMsg}`,
      );
    }

    const script = resolveScriptFn(mod);
    if (!script) {
      throw new Error(
        `Script at ${params.path} must export a function as its default export. ` +
          `Use \`export default defineScript(async ({ page, ctx }) => { ... });\`.`,
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
      const stack = error instanceof Error ? error.stack : undefined;
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
