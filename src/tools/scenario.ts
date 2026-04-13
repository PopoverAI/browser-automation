import { z } from "zod";
import type { Tool, ToolSchema, ToolResult } from "./tool.js";
import type { Context } from "../context.js";
import type { ToolActionResult } from "../types/types.js";
import { validateScenario, buildInstruction, buildOutputSchema } from "../scenario.js";
import { VariablesSchema, mergeVariables } from "../variables.js";

const StepSchema = z.object({
  step: z.enum(["arrange", "act", "assert"]).describe(
    "The type of step: arrange (preconditions), act (action under test), or assert (verify outcome)",
  ),
  description: z.string().describe("What this step should do or verify"),
  url: z.string().optional().describe("URL to navigate to before executing this step (relative or absolute)"),
  key: z.string().optional().describe("Caller-defined label for assert steps, echoed back in results"),
});

const ScenarioInputSchema = z.object({
  scenario: z.object({
    baseUrl: z.string().describe("The base URL for the scenario. Relative step URLs are resolved against this."),
    steps: z.array(StepSchema).describe("Ordered list of arrange, act, and assert steps"),
    variables: VariablesSchema.optional().describe(
      `Scenario-scoped variables for sensitive data. Reference them in step descriptions
        as %varName%. Shape: {varName: {value: "...", description?: "..."}}. Globally-configured
        variables (from STAGEHAND_VARIABLES) are automatically merged; scenario variables
        override globals on key conflict.`,
    ),
  }).describe("A multi-step test scenario with arrange/act/assert steps"),
  maxSteps: z.number().optional().describe(
    `Maximum number of agent steps. Default: 30.`,
  ),
});

type ScenarioInput = z.infer<typeof ScenarioInputSchema>;

const scenarioSchema: ToolSchema<typeof ScenarioInputSchema> = {
  name: "stagehand_scenario",
  description: `Execute a multi-step test scenario (arrange/act/assert) using the Stagehand agent. Returns structured pass/fail/blocked results per assert step.`,
  inputSchema: ScenarioInputSchema,
};

async function handleScenario(
  context: Context,
  params: ScenarioInput,
): Promise<ToolResult> {
  const action = async (): Promise<ToolActionResult> => {
    try {
      validateScenario(params.scenario);
      const instruction = buildInstruction(params.scenario);
      const outputSchema = buildOutputSchema(params.scenario);

      const stagehand = await context.getStagehand();
      const page = stagehand.context.pages()[0];
      await page.goto(params.scenario.baseUrl);

      const agent = stagehand.agent({
        mode: "hybrid",
        model: context.config.modelName,
      });

      const merged = mergeVariables(context.config.variables, params.scenario.variables);
      const result = await agent.execute({
        instruction,
        maxSteps: params.maxSteps ?? 30,
        output: outputSchema,
        variables: merged,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.output, null, 2) ?? "No output returned from scenario agent.",
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to execute scenario: ${errorMsg}`);
    }
  };

  return {
    action,
    waitForNetwork: false,
  };
}

const scenarioTool: Tool<typeof ScenarioInputSchema> = {
  capability: "core",
  schema: scenarioSchema,
  handle: handleScenario,
};

export default scenarioTool;
