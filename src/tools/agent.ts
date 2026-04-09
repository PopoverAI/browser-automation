import { z } from "zod";
import type { Tool, ToolSchema, ToolResult } from "./tool.js";
import type { Context } from "../context.js";
import type { ToolActionResult } from "../types/types.js";

/**
 * Stagehand Agent
 * Docs: https://docs.stagehand.dev/basics/agent
 *
 * This tool uses hybrid mode (DOM + coordinate-based actions) with Gemini 3 Flash
 * to autonomously complete web-based tasks. Hybrid mode combines the reliability of
 * DOM-based actions with the flexibility of coordinate-based actions.
 */

const AgentInputSchema = z.object({
  prompt: z.string().describe(
    `The task prompt describing what you want the sub-agent to accomplish.
    Be clear and specific about the goal. For example:
    'Go to Hacker News and find the most controversial post from today, then summarize the top 3 comments'.
    The agent will autonomously navigate and interact with web pages to complete this task.`,
  ),
  maxSteps: z.number().optional().describe(
    `Maximum number of steps the agent can take. Default: 20.`,
  ),
});

type AgentInput = z.infer<typeof AgentInputSchema>;

const agentSchema: ToolSchema<typeof AgentInputSchema> = {
  name: "stagehand_agent",
  description: `Execute a task autonomously using Stagehand agent in hybrid mode. The agent uses both DOM-based and coordinate-based actions for maximum reliability.`,
  inputSchema: AgentInputSchema,
};

async function handleAgent(
  context: Context,
  params: AgentInput,
): Promise<ToolResult> {
  const action = async (): Promise<ToolActionResult> => {
    try {
      const stagehand = await context.getStagehand();

      // Use hybrid mode with Gemini 3 Flash for best reliability
      // Hybrid mode combines DOM-based and coordinate-based actions
      const agent = stagehand.agent({
        mode: "hybrid",
        model: context.config.modelName,
      });

      // Execute the task
      const result = await agent.execute({
        instruction: params.prompt,
        maxSteps: params.maxSteps ?? 20,
      });

      // Build response with result details
      const responseLines = [result.message];
      if (result.actions && result.actions.length > 0) {
        responseLines.push(`\nActions taken: ${result.actions.length}`);
      }
      if (result.completed !== undefined) {
        responseLines.push(`Task completed: ${result.completed}`);
      }

      return {
        content: [
          {
            type: "text",
            text: responseLines.join('\n'),
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to execute agent task: ${errorMsg}`);
    }
  };

  return {
    action,
    waitForNetwork: false,
  };
}

const agentTool: Tool<typeof AgentInputSchema> = {
  capability: "core",
  schema: agentSchema,
  handle: handleAgent,
};

export default agentTool;
