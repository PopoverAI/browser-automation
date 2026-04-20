import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { extname, resolve as resolvePath } from "path";
import { fileURLToPath, pathToFileURL } from "url";

/**
 * Loader internals for the `stagehand_run_script` MCP tool. Split out from
 * `tools/runScript.ts` so the smoke test can exercise the exact shipped
 * code without duplicating the cache-miss / temp-copy logic.
 *
 * Not part of the public package surface — do not import from application
 * code. This lives in `src/` (not re-exported from any entry) so we're free
 * to change the signatures between releases.
 */

export type ScriptFn = (args: {
  stagehand: unknown;
  page: unknown;
  ctx: Record<string, unknown>;
}) => Promise<void>;

export type ScriptModule = {
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
export function resolveScriptFn(mod: ScriptModule): ScriptFn | undefined {
  const direct = mod.default;
  if (typeof direct === "function") return direct;
  if (direct && typeof direct === "object" && typeof direct.default === "function") {
    return direct.default;
  }
  return undefined;
}

/**
 * Directory inside the MCP's own package where temp copies for `source`
 * mode land. Placing them here lets `import { defineScript } from
 * "@popoverai/browser-automation/script"` and other bare imports resolve
 * against the MCP's own `node_modules` — no install required in the
 * caller's workspace.
 *
 * After `tsc` this file lives at `<pkg>/dist/scriptLoader.js`, so the
 * package root is one directory up.
 *
 * This assumes the MCP's install directory is writable. That holds for
 * every real distribution path today: npm install into the user's project,
 * npx cache under `~/.npm/_npx/`, and the `.mcpb` extension (which is a
 * thin npx shim — it delegates to `npx @popoverai/browser-automation@latest`
 * so the server always runs from the writable npx cache, not from the
 * Claude Desktop-managed extension dir). If we ever ship a bundled MCPB
 * that packs the server code directly into the extension dir, this path
 * will need to switch to a writable location like `os.tmpdir()` with a
 * symlinked `node_modules` back to the MCP's bundle.
 */
const MCP_TEMP_DIR = resolvePath(
  fileURLToPath(new URL("../", import.meta.url)),
  ".stagehand-tmp",
);

export type LoadInputs =
  | { mode: "path"; absPath: string }
  | { mode: "source"; source: string };

/**
 * Load a script via tsx's programmatic `tsImport` API.
 *
 * Node's ESM module graph is keyed on the resolved filesystem path and
 * `tsx`'s loader normalizes URLs before caching, so query-string cache-
 * busting (`?t=...`) and fresh-namespace registers don't force a re-read.
 * The only reliable way to pick up edits between runs in the same MCP
 * session is to import from a unique path.
 *
 * Where the temp copy lives determines how bare-specifier imports resolve:
 *
 *   - `mode: "path"` — copy as a sibling of the original. Relative imports
 *     in the script still resolve, and bare imports resolve from the
 *     script's own `node_modules` tree (so the script's project must have
 *     the needed deps installed, including `@popoverai/browser-automation`
 *     for `defineScript`).
 *
 *   - `mode: "source"` — write into `<mcp-pkg>/.stagehand-tmp/`. Bare
 *     imports resolve against the MCP's own `node_modules`, no install
 *     required anywhere else. Relative imports aren't meaningful (inline
 *     source has no original directory).
 *
 * We return both the module and the temp path so the caller can rewrite
 * temp-path mentions out of any stack trace the script throws — by the
 * time the caller reads `error.stack`, the file has been deleted.
 *
 * NB: `tsImport` handles its own ESM loader registration internally (it
 * runs `module.register()` with a fresh namespace per call), so we don't
 * need to call `register()` ourselves.
 */
export async function loadScriptModule(
  inputs: LoadInputs,
): Promise<{ mod: ScriptModule; tempPath: string }> {
  const unique = `stagehand-run-${Date.now()}-${randomBytes(4).toString("hex")}`;
  let tempPath: string;

  if (inputs.mode === "path") {
    const ext = extname(inputs.absPath);
    tempPath = `${inputs.absPath}.${unique}.tmp${ext}`;
    copyFileSync(inputs.absPath, tempPath);
  } else {
    mkdirSync(MCP_TEMP_DIR, { recursive: true });
    // Default to .ts; tsx handles JS passthrough when needed, but TS is the
    // expected shape and gives the transpiler a chance to strip annotations
    // without forcing the caller to specify an extension.
    tempPath = resolvePath(MCP_TEMP_DIR, `${unique}.ts`);
    writeFileSync(tempPath, inputs.source, "utf8");
  }

  try {
    const { tsImport } = await import("tsx/esm/api");
    const mod = (await tsImport(tempPath, {
      parentURL: import.meta.url,
    })) as ScriptModule;
    return { mod, tempPath };
  } finally {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup. A leftover `stagehand-run-*.tmp.*` next to the
      // user's script, or inside `<mcp-pkg>/.stagehand-tmp/`, is safe to
      // delete if a hard crash (SIGKILL, process exit mid-run) ever leaves
      // one behind.
    }
  }
}

/**
 * Rewrite temp-path mentions in a stack trace back to the location the
 * caller wants surfaced, so the user can click through to the file they
 * actually authored. The temp copy has been unlinked by the time
 * `error.stack` is read, so raw frames point at a file that no longer
 * exists.
 *
 * Node's stack formatter uses either filesystem paths or file:// URLs
 * depending on how the module was loaded, so both forms are rewritten.
 * Pass `{ path }` when there's a real file to point at, `{ sentinel }`
 * (e.g. "<inline source>") when the script came from an inline string.
 */
export function rewriteStack(
  rawStack: string | undefined,
  tempPath: string,
  displayLocation: { path: string } | { sentinel: string },
): string | undefined {
  if (!rawStack) return undefined;
  const tempFileUrl = pathToFileURL(tempPath).href;
  const replacementUrl = "path" in displayLocation
    ? pathToFileURL(displayLocation.path).href
    : displayLocation.sentinel;
  const replacementPath = "path" in displayLocation
    ? displayLocation.path
    : displayLocation.sentinel;
  return rawStack
    .replaceAll(tempFileUrl, replacementUrl)
    .replaceAll(tempPath, replacementPath);
}
