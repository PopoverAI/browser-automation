// Smoke test for the script subpath + tsx-based dynamic loading used by
// stagehand_run_script. Does NOT boot a browser — just verifies the plumbing.
//
// Run: node scripts/smoke-run-script.mjs
import { pathToFileURL } from "url";
import { resolve } from "path";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
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

// 3. Dynamic .ts loading via tsx/esm/api. Mirror the resolver the tool uses
//    so we cover both ESM and CJS-wrapped shapes.
const api = await import("tsx/esm/api");
api.register();

function resolveScriptFn(mod) {
  const direct = mod.default;
  if (typeof direct === "function") return direct;
  if (direct && typeof direct === "object" && typeof direct.default === "function") {
    return direct.default;
  }
  return undefined;
}

async function exerciseFixture(label, withTypeModule) {
  const dir = mkdtempSync(join(tmpdir(), `stagehand-smoke-${label}-`));
  if (withTypeModule) {
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  }
  const scriptPath = join(dir, "fixture.ts");
  writeFileSync(
    scriptPath,
    `import { defineScript } from "${pathToFileURL(resolve("dist/script.js")).href}";
export default defineScript(async ({ ctx }) => {
  if (ctx.shouldFail === "yes") throw new Error("deliberate failure");
});
`,
  );

  try {
    const mod = await import(`${pathToFileURL(scriptPath).href}?t=${Date.now()}`);
    const fn = resolveScriptFn(mod);
    if (typeof fn !== "function") {
      throw new Error(`[${label}] resolver returned non-function (mod shape: ${JSON.stringify(Object.keys(mod))})`);
    }

    await fn({ stagehand: null, page: null, ctx: {} });

    let threw = false;
    try {
      await fn({ stagehand: null, page: null, ctx: { shouldFail: "yes" } });
    } catch (e) {
      threw = true;
      if (e.message !== "deliberate failure") {
        throw new Error(`[${label}] unexpected error message: ${e.message}`);
      }
    }
    if (!threw) throw new Error(`[${label}] fail-path did not throw`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await exerciseFixture("esm", true);
await exerciseFixture("cjs-wrapped", false);

console.log("OK: defineScript identity + tsx .ts import + resolver for both ESM and CJS-wrapped shapes");
