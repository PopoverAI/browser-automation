import { z } from "zod";
import type { Tool, ToolSchema, ToolResult } from "./tool.js";
import type { Context } from "../context.js";
import type { ToolActionResult } from "../types/types.js";
import { VariablesSchema, mergeVariables, toActVariables } from "../variables.js";

/**
 * Stagehand Act
 * Docs: https://docs.stagehand.dev/basics/act
 *
 * This tool is used to perform actions on a web page.
 */

const ActInputSchema = z.object({
  action: z.string().describe(
    `The action to perform. Should be as atomic and specific as possible,
      i.e. 'Click the sign in button' or 'Type 'hello' into the search input'.`,
  ),
  variables: VariablesSchema.optional().describe(
    `Variables used in the action template for sensitive data. Reference them
      in the action as %varName%. Shape: {varName: {value: "...", description?: "..."}}.
      Example: {"action": "type %password% into the password field", "variables": {"password": {"value": "hunter2"}}}.
      Globally-configured variables (from STAGEHAND_VARIABLES) are automatically merged;
      per-call variables override globals on key conflict.`,
  ),
});

type ActInput = z.infer<typeof ActInputSchema>;

const actSchema: ToolSchema<typeof ActInputSchema> = {
  name: "stagehand_act",
  description: `Perform a single action on the page (e.g., click, type).`,
  inputSchema: ActInputSchema,
};

async function handleAct(
  context: Context,
  params: ActInput,
): Promise<ToolResult> {
  const action = async (): Promise<ToolActionResult> => {
    try {
      const stagehand = await context.getStagehand();

      const merged = mergeVariables(context.config.variables, params.variables);
      await stagehand.act(params.action, {
        variables: toActVariables(merged),
      });

      return {
        content: [
          {
            type: "text",
            text: `Action performed: ${params.action}`,
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to perform action: ${errorMsg}`);
    }
  };

  return {
    action,
    waitForNetwork: false,
  };
}

const actTool: Tool<typeof ActInputSchema> = {
  capability: "core",
  schema: actSchema,
  handle: handleAct,
};

export default actTool;
