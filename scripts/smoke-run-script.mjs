// Smoke test for the script subpath + stagehand_run_script loader behavior.
// Does NOT boot a browser — exercises the plumbing:
//   1. defineScript is importable from the subpath and is runtime-identity
//   2. path mode: sibling copy, edit-between-runs cache miss, stack rewrite
//   3. source mode: inline string, bare imports resolve from MCP's deps,
//      stack rewrite with the <inline source> sentinel
//   4. Missing path surfaces a clean ENOENT-ish error
//
// Uses the real dist/scriptLoader.js — this tests the shipped code, not a
// re-implementation.
//
// Run: node scripts/smoke-run-script.mjs
import { pathToFileURL } from "url";
import { resolve } from "path";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { defineScript } = await import("../dist/script.js");
const { loadScriptModule, resolveScriptFn, rewriteStack } = await import(
  "../dist/scriptLoader.js"
);

// 1. Subpath export + identity.
if (typeof defineScript !== "function") {
  throw new Error("defineScript is not a function");
}
const inner = async () => {};
if (defineScript(inner) !== inner) {
  throw new Error("defineScript must be identity at runtime");
}

const defineScriptUrl = pathToFileURL(resolve("dist/script.js")).href;

// 2. path mode — sibling copy, edit-between-runs cache miss, stack rewrite.
// Uses an absolute file:// URL for defineScript so we don't depend on the
// tempdir having npm packages installed.
{
  const dir = mkdtempSync(join(tmpdir(), "smoke-path-"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  const scriptPath = join(dir, "fixture.ts");

  const writeVersion = (marker) =>
    writeFileSync(
      scriptPath,
      `import { defineScript } from "${defineScriptUrl}";
export default defineScript(async ({ ctx }) => {
  if (ctx.shouldFail === "yes") throw new Error("failure ${marker}");
});
`,
    );

  try {
    writeVersion("v1");
    const r1 = await loadScriptModule({ mode: "path", absPath: scriptPath });
    const fn1 = resolveScriptFn(r1.mod);
    await fn1({ stagehand: null, page: null, ctx: {} });
    let e1;
    try { await fn1({ stagehand: null, page: null, ctx: { shouldFail: "yes" } }); }
    catch (e) { e1 = e; }
    if (!/failure v1/.test(e1?.message ?? "")) {
      throw new Error(`[path] v1 failure path broken: ${e1?.message}`);
    }

    writeVersion("v2");
    const r2 = await loadScriptModule({ mode: "path", absPath: scriptPath });
    const fn2 = resolveScriptFn(r2.mod);
    let e2;
    try { await fn2({ stagehand: null, page: null, ctx: { shouldFail: "yes" } }); }
    catch (e) { e2 = e; }
    if (!/failure v2/.test(e2?.message ?? "")) {
      throw new Error(`[path] edit not picked up: got ${e2?.message}`);
    }

    // Stack rewrite: e2.stack should show the original path, not the temp copy.
    const rewritten = rewriteStack(e2.stack, r2.tempPath, { path: scriptPath });
    if (rewritten?.includes(r2.tempPath)) {
      throw new Error("[path] stack rewrite left temp path in output");
    }
    if (!rewritten?.includes(scriptPath)) {
      throw new Error("[path] stack rewrite didn't insert original path");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 3. source mode — inline string. Uses a BARE `zod` import to prove
// resolution walks the MCP's own node_modules (the temp file lives inside
// the MCP package). Plus sentinel-based stack rewrite.
{
  const source = `import { z } from "zod";
const schema = z.object({ ok: z.boolean() });
export default async ({ ctx }) => {
  schema.parse({ ok: true });
  if (ctx.shouldFail === "yes") throw new Error("source failure");
};
`;

  const r = await loadScriptModule({ mode: "source", source });
  const fn = resolveScriptFn(r.mod);
  await fn({ stagehand: null, page: null, ctx: {} });

  let err;
  try { await fn({ stagehand: null, page: null, ctx: { shouldFail: "yes" } }); }
  catch (e) { err = e; }
  if (!/source failure/.test(err?.message ?? "")) {
    throw new Error(`[source] failure path broken: ${err?.message}`);
  }

  const rewritten = rewriteStack(err.stack, r.tempPath, {
    sentinel: "<inline source>",
  });
  if (rewritten?.includes(r.tempPath)) {
    throw new Error("[source] stack rewrite left temp path in output");
  }
}

// 4. path mode, non-existent file — expect a clean error message.
{
  const bogus = join(tmpdir(), "definitely-does-not-exist-" + Date.now() + ".ts");
  let err;
  try {
    await loadScriptModule({ mode: "path", absPath: bogus });
  } catch (e) {
    err = e;
  }
  if (!err) {
    throw new Error("[enoent] expected load to throw for missing path");
  }
  if (!/ENOENT|no such file/i.test(err.message)) {
    throw new Error(`[enoent] expected ENOENT-ish error, got: ${err.message}`);
  }
}

console.log(
  "OK: defineScript identity + path mode (edit-cache-miss + stack rewrite) + source mode (bare zod resolves + sentinel stack rewrite) + ENOENT",
);
