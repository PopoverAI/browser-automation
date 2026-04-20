import { z } from "zod";
import { copyFileSync, unlinkSync } from "fs";
import { randomBytes } from "crypto";
import { extname, resolve as resolvePath, isAbsolute } from "path";
import { pathToFileURL } from "url";
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

/**
 * Load the script via tsx's programmatic `tsImport` API.
 *
 * Node's ESM module graph is keyed on the resolved filesystem path and
 * `tsx`'s loader normalizes URLs before caching, so query-string cache-
 * busting (`?t=...`) and fresh-namespace registers don't force a re-read.
 * The only reliable way to pick up edits between runs in the same MCP
 * session is to import from a unique path.
 *
 * We copy the script to a sibling temp path with a unique suffix, import
 * that copy, and clean it up afterwards. Placing the copy next to the
 * original preserves relative-import resolution (not used in typical
 * scripts today, but avoids a latent footgun) and keeps bare-specifier
 * resolution (`@popoverai/browser-automation/script`, `zod`) pointing at
 * the same `node_modules` tree the original would have hit.
 *
 * We return both the module and the temp path so the caller can rewrite
 * temp-path mentions out of any stack trace the script throws — by the
 * time the caller reads `error.stack`, the file has been deleted, and
 * frames like `...stagehand-run-<ts>-<rand>.tmp.ts:12:5` would point at
 * a path the user can't open.
 *
 * NB: `tsImport` handles its own ESM loader registration internally (it
 * runs `module.register()` with a fresh namespace per call), so we don't
 * need to call `register()` ourselves.
 */
async function loadScriptModule(
  absPath: string,
): Promise<{ mod: ScriptModule; tempPath: string }> {
  const ext = extname(absPath);
  const suffix = `.stagehand-run-${Date.now()}-${randomBytes(4).toString("hex")}.tmp${ext}`;
  const tempPath = absPath + suffix;

  copyFileSync(absPath, tempPath);
  try {
    const { tsImport } = await import("tsx/esm/api");
    const mod = (await tsImport(tempPath, {
      parentURL: import.meta.url,
    })) as ScriptModule;
    return { mod, tempPath };
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup. A leftover temp file is preferable to failing
      // the run over a cleanup error. (A hard crash — SIGKILL, process
      // exit mid-run — can also leave a `*.stagehand-run-*.tmp.*` file
      // next to the original; safe to delete.)
    }
  }
}

async function handleRunScript(
  context: Context,
  params: RunScriptInput,
): Promise<ToolResult> {
  const action = async (): Promise<ToolActionResult> => {
    const absPath = isAbsolute(params.path)
      ? params.path
      : resolvePath(process.cwd(), params.path);

    let mod: ScriptModule;
    let tempPath: string;
    try {
      const loaded = await loadScriptModule(absPath);
      mod = loaded.mod;
      tempPath = loaded.tempPath;
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
      // The thrown stack references the temp copy that we've already
      // unlinked. Rewrite temp-path mentions back to the original so the
      // caller can actually open the file at the reported line. Node's
      // stack formatter uses either filesystem paths or file:// URLs
      // depending on how the module was loaded — rewrite both forms.
      const rawStack = error instanceof Error ? error.stack : undefined;
      const tempFileUrl = pathToFileURL(tempPath).href;
      const absFileUrl = pathToFileURL(absPath).href;
      const stack = rawStack
        ?.split(tempFileUrl).join(absFileUrl)
        .split(tempPath).join(absPath);
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
