import * as fs from "fs";
import * as path from "path";
import { z } from "zod";

export interface Step {
  step: "arrange" | "act" | "assert";
  description: string;
  url?: string;
  key?: string;
}

export interface Scenario {
  baseUrl: string;
  steps: Step[];
}

const VALID_STEP_TYPES = new Set(["arrange", "act", "assert"]);

/**
 * Validate a scenario object. Throws on invalid input.
 * Used by both parseScenario (CLI string/file input) and the MCP tool (object input).
 */
export function validateScenario(scenario: Scenario): void {
  if (!scenario.baseUrl || typeof scenario.baseUrl !== "string") {
    throw new Error("Scenario must have a non-empty \"baseUrl\" string");
  }

  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    throw new Error("Scenario must have a non-empty \"steps\" array");
  }

  for (let i = 0; i < scenario.steps.length; i++) {
    const s = scenario.steps[i];
    if (!VALID_STEP_TYPES.has(s.step)) {
      throw new Error(`Step ${i + 1}: "step" must be "arrange", "act", or "assert" (got "${String(s.step)}")`);
    }
    if (!s.description) {
      throw new Error(`Step ${i + 1}: "description" must be a non-empty string`);
    }
  }

  // Validate at least one assert step
  const assertSteps = scenario.steps.filter(s => s.step === "assert");
  if (assertSteps.length === 0) {
    throw new Error("Scenario must have at least one assert step");
  }

  // Validate assert key uniqueness
  const keys = new Set<string>();
  for (const s of scenario.steps) {
    if (s.step === "assert" && s.key) {
      if (keys.has(s.key)) {
        throw new Error(`Duplicate assert key "${s.key}"`);
      }
      keys.add(s.key);
    }
  }
}

export function parseScenario(input: string): Scenario {
  let raw: unknown;
  if (input.trimStart().startsWith("{")) {
    try {
      raw = JSON.parse(input);
    } catch (e) {
      throw new Error(`Invalid JSON in --scenario: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    const filePath = path.resolve(input);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (e) {
      throw new Error(`Cannot read scenario file "${filePath}": ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      raw = JSON.parse(content);
    } catch (e) {
      throw new Error(`Invalid JSON in scenario file "${filePath}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const scenario = raw as Scenario;
  validateScenario(scenario);
  return scenario;
}

export function buildInstruction(scenario: Scenario): string {
  let assertIndex = 0;
  const stepLines = scenario.steps.map((s) => {
    const urlPart = s.url ? ` (URL: ${s.url})` : "";
    if (s.step === "assert") {
      assertIndex++;
      const keyPart = s.key ? ` (key: ${s.key})` : "";
      return `${assertIndex}. [assert]${keyPart}${urlPart} ${s.description}`;
    }
    return `- [${s.step}]${urlPart} ${s.description}`;
  });

  return `Execute this test scenario against ${scenario.baseUrl}:

${stepLines.join("\n")}

Execute the arrange and act steps first. Then evaluate each assert step.
If an arrange or act step fails, mark all remaining assert steps as "blocked".
Return one result per assert step only, in order.`;
}

export function buildOutputSchema(scenario: Scenario) {
  const hasKeys = scenario.steps.some(s => s.step === "assert" && s.key);

  const resultItem = hasKeys
    ? z.object({
        key: z.string().optional().describe("The key from the assert step, if provided"),
        status: z.enum(["passed", "failed", "blocked"]),
        notes: z.string().describe("Brief explanation of the result"),
      })
    : z.object({
        status: z.enum(["passed", "failed", "blocked"]),
        notes: z.string().describe("Brief explanation of the result"),
      });

  return z.object({
    results: z.array(resultItem),
  });
}

export function getAssertCount(scenario: Scenario): number {
  return scenario.steps.filter(s => s.step === "assert").length;
}
