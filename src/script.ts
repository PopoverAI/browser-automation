import type { Stagehand, Page } from "@browserbasehq/stagehand";

/**
 * Default context shape for scripts. Covers the common fields a caller might
 * want to inject (base URL, credentials) without requiring the script author
 * to declare a custom interface. Unknown string-valued fields are also
 * accessible via the index signature, so `ctx.myField` works without a cast.
 *
 * Scripts that need non-string fields should pass their own generic:
 *
 *   interface Ctx { productId: string; quantity: number }
 *   export default defineScript<Ctx>(async ({ page, ctx }) => { ... });
 */
export interface BaseCtx {
  baseUrl?: string;
  username?: string;
  password?: string;
  [key: string]: string | undefined;
}

export interface ScriptArgs<Ctx extends object = BaseCtx> {
  stagehand: Stagehand;
  page: Page;
  ctx: Ctx;
}

export type Script<Ctx extends object = BaseCtx> = (
  args: ScriptArgs<Ctx>,
) => Promise<void>;

/**
 * Identity helper that gives scripts a typed `ctx` without requiring the
 * author to repeat the full destructuring signature. The runtime cost is
 * zero — the returned value is the function you passed in.
 *
 * Scripts are invoked by the `stagehand_run_script` MCP tool (or by your own
 * caller) which passes `{ stagehand, page, ctx }`. Throw to signal failure;
 * return to signal success.
 *
 * @example
 * import { defineScript } from "@popoverai/browser-automation/script";
 * import { z } from "zod";
 * import assert from "node:assert/strict";
 *
 * export default defineScript(async ({ page, ctx }) => {
 *   await page.goto(ctx.baseUrl ?? "https://example.com");
 *   const { heading } = await page.extract(
 *     "the main heading",
 *     z.object({ heading: z.string() }),
 *   );
 *   assert.match(heading, /welcome/i);
 * });
 */
export function defineScript<Ctx extends object = BaseCtx>(
  fn: Script<Ctx>,
): Script<Ctx> {
  return fn;
}
