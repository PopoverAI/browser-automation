import { z } from "zod";
import type { Tool, ToolSchema, ToolResult } from "./tool.js";
import type { Context } from "../context.js";
import type { ToolActionResult } from "../types/types.js";
import { parseScenario, buildInstruction, buildOutputSchema } from "../scenario.js";

const ScenarioInputSchema = z.object({
  scenario: z.string().describe(
    `A JSON string describing a multi-step test scenario with baseUrl and steps (arrange/act/assert).
    Example: {"baseUrl":"https://example.com","steps":[{"step":"arrange","description":"Log in"},{"step":"assert","key":"logged-in","description":"Dashboard is shown"}]}`,
  ),
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
      const scenario = parseScenario(params.scenario);
      const instruction = buildInstruction(scenario);
      const outputSchema = buildOutputSchema(scenario);

      const stagehand = await context.getStagehand();
      const page = stagehand.context.pages()[0];
      await page.goto(scenario.baseUrl);

      const agent = stagehand.agent({
        mode: "hybrid",
        model: "google/gemini-3-flash-preview",
      });

      const result = await agent.execute({
        instruction,
        maxSteps: params.maxSteps ?? 30,
        output: outputSchema,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.output, null, 2),
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
