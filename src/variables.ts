import { z } from "zod";

/**
 * Stagehand variables support.
 * Docs: https://docs.stagehand.dev/basics/act#variables
 *
 * Canonical shape in this codebase:
 *   Record<string, { value: string; description?: string }>
 *
 * Referenced in instructions as %varName%; Stagehand substitutes at runtime so
 * raw values never reach the LLM.
 */

export const VariableValueSchema = z.object({
  value: z.string(),
  description: z.string().optional(),
});

export const VariablesSchema = z.record(VariableValueSchema);

export type Variable = z.infer<typeof VariableValueSchema>;
export type Variables = z.infer<typeof VariablesSchema>;

/**
 * Merge variable maps. Later sources override earlier ones on key conflict.
 * Undefined sources are skipped. Returns undefined if no sources contribute
 * any keys, so callers can pass `undefined` straight through to Stagehand.
 */
export function mergeVariables(
  ...sources: (Variables | undefined)[]
): Variables | undefined {
  const merged: Variables = {};
  let hasAny = false;
  for (const source of sources) {
    if (!source) continue;
    for (const [key, val] of Object.entries(source)) {
      merged[key] = val;
      hasAny = true;
    }
  }
  return hasAny ? merged : undefined;
}

/**
 * Project rich variables to the string-only shape that stagehand.act() expects.
 */
export function toActVariables(
  variables: Variables | undefined,
): Record<string, string> | undefined {
  if (!variables) return undefined;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(variables)) {
    out[key] = val.value;
  }
  return out;
}

/**
 * Parse the STAGEHAND_VARIABLES env var into a Variables map.
 * Returns undefined if the env var is unset, empty, or malformed (with a warning).
 */
export function parseVariablesEnv(raw: string | undefined): Variables | undefined {
  if (!raw || raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(
      `Warning: STAGEHAND_VARIABLES is not valid JSON, ignoring: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
  const result = VariablesSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(
      `Warning: STAGEHAND_VARIABLES does not match expected shape {key: {value, description?}}, ignoring.`,
    );
    return undefined;
  }
  return result.data;
}
