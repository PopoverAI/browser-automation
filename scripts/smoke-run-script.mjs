// Smoke test for the script subpath + stagehand_run_script loader behavior.
// Does NOT boot a browser — exercises the plumbing:
//   1. defineScript is importable from the subpath and is runtime-identity
//   2. tsx-based dynamic loading works for .ts (ESM and CJS-wrapped) and .js
//   3. Edits to the script are picked up on re-run (cache miss via temp copy)
//
// Run: node scripts/smoke-run-script.mjs
import { pathToFileURL } from "url";
import { resolve, extname } from "path";
import { copyFileSync, mkdtempSync, unlinkSync, writeFileSync, rmSync } from "fs";
import { randomBytes } from "crypto";
import { tmpdir } from "os";
import { join } from "path";

// 1. Subpath export resolves.
const { defineScript } = await import("../dist/script.js");
if (typeof defineScript !== "function") {
  throw new Error("defineScript is not a function");
}

// 2. Identity semantics — defineScript returns the same function.
const inner = async () => {};
if (defineScript(inner) !== inner) {
  throw new Error("defineScript must be identity at runtime");
}

// Mirror the tool's loader: copy to a unique sibling path, tsImport it, delete.
// This is the only reliable way to get a fresh module between runs (tsx
// normalizes URLs before Node's ESM graph cache sees them, so neither
// ?t= query strings nor fresh namespaces force a reload).
const { tsImport } = await import("tsx/esm/api");

async function loadScriptModule(absPath) {
  const ext = extname(absPath);
  const suffix = `.stagehand-smoke-${Date.now()}-${randomBytes(4).toString("hex")}.tmp${ext}`;
  const tempPath = absPath + suffix;
  copyFileSync(absPath, tempPath);
  try {
    return await tsImport(tempPath, { parentURL: import.meta.url });
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup; a leftover temp file shouldn't fail the test.
    }
  }
}

function resolveScriptFn(mod) {
  const direct = mod.default;
  if (typeof direct === "function") return direct;
  if (direct && typeof direct === "object" && typeof direct.default === "function") {
    return direct.default;
  }
  return undefined;
}

async function exerciseFixture(label, { ext, withTypeModule }) {
  const dir = mkdtempSync(join(tmpdir(), `stagehand-smoke-${label}-`));
  if (withTypeModule) {
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  }
  const scriptPath = join(dir, `fixture${ext}`);
  const defineScriptUrl = pathToFileURL(resolve("dist/script.js")).href;

  const writeVersion = (marker) =>
    writeFileSync(
      scriptPath,
      `import { defineScript } from "${defineScriptUrl}";
export default defineScript(async ({ ctx }) => {
  if (ctx.shouldFail === "yes") throw new Error("deliberate failure ${marker}");
});
`,
    );

  try {
    writeVersion("v1");
    const mod1 = await loadScriptModule(scriptPath);
    const fn1 = resolveScriptFn(mod1);
    if (typeof fn1 !== "function") {
      throw new Error(`[${label}] resolver returned non-function (keys: ${JSON.stringify(Object.keys(mod1))})`);
    }

    // Pass path
    await fn1({ stagehand: null, page: null, ctx: {} });

    // Fail path with v1 marker
    let err1;
    try {
      await fn1({ stagehand: null, page: null, ctx: { shouldFail: "yes" } });
    } catch (e) {
      err1 = e;
    }
    if (!err1) throw new Error(`[${label}] fail-path did not throw for v1`);
    if (!/deliberate failure v1/.test(err1.message)) {
      throw new Error(`[${label}] v1 error message wrong: ${err1.message}`);
    }

    // Edit the file, reload, confirm the new marker comes through — this is
    // the cache-miss guarantee. Without the temp-copy approach this would
    // return the v1 module from Node's ESM graph cache.
    writeVersion("v2");
    const mod2 = await loadScriptModule(scriptPath);
    const fn2 = resolveScriptFn(mod2);
    let err2;
    try {
      await fn2({ stagehand: null, page: null, ctx: { shouldFail: "yes" } });
    } catch (e) {
      err2 = e;
    }
    if (!err2) throw new Error(`[${label}] fail-path did not throw for v2`);
    if (!/deliberate failure v2/.test(err2.message)) {
      throw new Error(`[${label}] v2 edit not picked up (got: ${err2.message}) — cache miss failed`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await exerciseFixture("ts-esm", { ext: ".ts", withTypeModule: true });
await exerciseFixture("ts-cjs-wrapped", { ext: ".ts", withTypeModule: false });
// .js fixture locks in that the tool's loader (which unconditionally routes
// through tsImport now, with no .ts-gating) still handles plain JavaScript.
await exerciseFixture("js-esm", { ext: ".js", withTypeModule: true });

console.log("OK: defineScript identity + dynamic load (.ts ESM, .ts CJS-wrapped, .js) + edit-between-runs cache miss");
