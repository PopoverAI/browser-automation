import { Stagehand } from "@browserbasehq/stagehand";
import {
  type Scenario,
  buildInstruction,
  buildOutputSchema,
  getAssertCount,
} from "./scenario.js";
import { mergeVariables, type Variables } from "./variables.js";

export const DEFAULT_MODEL_NAME = "google/gemini-3-flash-preview";
export const DEFAULT_MAX_STEPS = 30;

export interface RunScenarioOptions {
  scenario: Scenario;
  modelName?: string;
  modelApiKey?: string;
  env?: "LOCAL" | "BROWSERBASE";
  variables?: Variables;
  includeUsage?: boolean;
  maxSteps?: number;
}

export interface ScenarioResultItem {
  status: "passed" | "failed" | "blocked";
  notes: string;
  key?: string;
}

export interface RunScenarioResult {
  results: ScenarioResultItem[];
  allPassed: boolean;
  structured: boolean;
  usage?: Record<string, unknown>;
}

export async function runScenario(
  opts: RunScenarioOptions,
): Promise<RunScenarioResult> {
  const {
    scenario,
    modelName = DEFAULT_MODEL_NAME,
    modelApiKey,
    env = "LOCAL",
    variables,
    includeUsage,
    maxSteps = DEFAULT_MAX_STEPS,
  } = opts;

  const instruction = buildInstruction(scenario);
  const outputSchema = buildOutputSchema(scenario);
  const assertCount = getAssertCount(scenario);

  const stagehand = new Stagehand({
    env,
    model: modelApiKey ? { apiKey: modelApiKey, modelName } : modelName,
    experimental: true,
  });

  const buildBlocked = (notes: string): ScenarioResultItem[] =>
    Array.from({ length: assertCount }, () => ({
      status: "blocked" as const,
      notes,
    }));

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0];
    await page.goto(scenario.baseUrl);

    const agent = stagehand.agent({
      mode: "hybrid",
      model: modelName,
    });

    const mergedVariables = mergeVariables(variables, scenario.variables);

    const result = await agent.execute({
      instruction,
      maxSteps,
      output: outputSchema,
      variables: mergedVariables,
    });

    const output = result.output as
      | { results: ScenarioResultItem[] }
      | undefined;

    if (output?.results) {
      const allPassed = output.results.every((r) => r.status === "passed");
      const ret: RunScenarioResult = {
        results: output.results,
        allPassed,
        structured: true,
      };
      if (includeUsage) {
        ret.usage = { model: modelName, ...(result.usage ?? {}) };
      }
      return ret;
    }

    return {
      results: buildBlocked("No structured output returned from agent"),
      allPassed: false,
      structured: false,
    };
  } catch (error) {
    const errorMsg = `Error: ${error instanceof Error ? error.message : String(error)}`;
    return {
      results: buildBlocked(errorMsg),
      allPassed: false,
      structured: false,
    };
  } finally {
    await stagehand.close();
  }
}
