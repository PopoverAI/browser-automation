import { z } from "zod";
import type { Tool, ToolSchema, ToolResult } from "./tool.js";
import type { Context } from "../context.js";
import type { ToolActionResult } from "../types/types.js";
import { Browserbase } from "@browserbasehq/sdk";
import { createUIResource } from "@mcp-ui/server";
import type { BrowserSession } from "../types/types.js";
import { TextContent } from "@modelcontextprotocol/sdk/types.js";

// --- Tool: Create Session ---
const CreateSessionInputSchema = z.object({
  // Keep sessionId optional
  sessionId: z
    .string()
    .optional()
    .describe(
      "Optional session ID to use/reuse. If not provided or invalid, a new session is created.",
    ),
  cloud: z
    .boolean()
    .optional()
    .describe(
      "Use Browserbase cloud browser instead of local Playwright. Default: false (local).",
    ),
});
type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

const createSessionSchema: ToolSchema<typeof CreateSessionInputSchema> = {
  name: "stagehand_session_create",
  description:
    "Create a browser session and set it as active. Uses local Playwright by default; set cloud=true for Browserbase cloud.",
  inputSchema: CreateSessionInputSchema,
};

// Handle function for CreateSession using SessionManager
async function handleCreateSession(
  context: Context,
  params: CreateSessionInput,
): Promise<ToolResult> {
  const action = async (): Promise<ToolActionResult> => {
    try {
      const sessionManager = context.getSessionManager();
      const config = context.config; // Get config from context
      const useCloud = params.cloud ?? false;
      let targetSessionId: string;

      // Session ID Strategy: Use raw sessionId for both internal tracking and Browserbase operations
      // Default session uses generated ID with timestamp/UUID, user sessions use provided ID as-is
      if (params.sessionId) {
        targetSessionId = params.sessionId;
        process.stderr.write(
          `[tool.createSession] Attempting to create/assign session with specified ID: ${targetSessionId}\n`,
        );
      } else {
        targetSessionId = sessionManager.getDefaultSessionId();
      }

      let session: BrowserSession;
      const defaultSessionId = sessionManager.getDefaultSessionId();
      if (targetSessionId === defaultSessionId && !useCloud) {
        // Default session uses ensureDefaultSessionInternal (always local)
        session = await sessionManager.ensureDefaultSessionInternal(config);
      } else {
        // When user provides a sessionId or requests cloud, create new session
        // Note: targetSessionId is used for internal tracking in SessionManager
        // while params.sessionId is the Browserbase session ID to resume (cloud only)
        session = await sessionManager.createNewBrowserSession(
          targetSessionId, // Internal session ID for tracking
          config,
          useCloud ? params.sessionId : undefined, // Browserbase session ID to resume (cloud only)
          useCloud, // Pass cloud flag
        );
      }

      if (
        !session ||
        !session.page ||
        !session.sessionId ||
        !session.stagehand
      ) {
        throw new Error(
          `SessionManager failed to return a valid session object with actualSessionId for ID: ${targetSessionId}`,
        );
      }

      // For cloud mode, return debug URLs
      if (useCloud) {
        const bb = new Browserbase({
          apiKey: config.browserbaseApiKey,
        });

        const browserbaseSessionId = session.stagehand.browserbaseSessionId;
        if (!browserbaseSessionId) {
          throw new Error(
            "Browserbase session ID not found in Stagehand instance",
          );
        }
        const debugUrl = (await bb.sessions.debug(browserbaseSessionId))
          .debuggerFullscreenUrl;

        return {
          content: [
            {
              type: "text",
              text: `Browserbase Live Session View URL: https://www.browserbase.com/sessions/${browserbaseSessionId}`,
            },
            {
              type: "text",
              text: `Browserbase Live Debugger URL: ${debugUrl}`,
            },
            createUIResource({
              uri: "ui://analytics-dashboard/main",
              content: { type: "externalUrl", iframeUrl: debugUrl },
              encoding: "text",
            }) as unknown as TextContent,
          ],
        };
      }

      // For local mode, return simple confirmation
      return {
        content: [
          {
            type: "text",
            text: `Local browser session created: ${targetSessionId}`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[tool.createSession] Action failed: ${errorMessage}\n`,
      );
      // Re-throw to be caught by Context.run's error handling for actions
      throw new Error(`Failed to create browser session: ${errorMessage}`);
    }
  };

  // Return the ToolResult structure expected by Context.run
  return {
    action: action,
    waitForNetwork: false,
  };
}

// Define tool using handle
const createSessionTool: Tool<typeof CreateSessionInputSchema> = {
  capability: "core", // Add capability
  schema: createSessionSchema,
  handle: handleCreateSession,
};

// --- Tool: Close Session ---
const CloseSessionInputSchema = z.object({});

const closeSessionSchema: ToolSchema<typeof CloseSessionInputSchema> = {
  name: "stagehand_session_close",
  description:
    "Close the current browser session and reset the active context.",
  inputSchema: CloseSessionInputSchema,
};

async function handleCloseSession(context: Context): Promise<ToolResult> {
  const action = async (): Promise<ToolActionResult> => {
    // Store the current session ID before cleanup
    const previousSessionId = context.currentSessionId;
    let cleanupSuccessful = false;
    let cleanupErrorMessage = "";

    // Step 1: Get session info before cleanup
    let browserbaseSessionId: string | undefined;
    const sessionManager = context.getSessionManager();
    const ngrokManager = context.getNgrokManager();

    try {
      const session = await sessionManager.getSession(
        previousSessionId,
        context.config,
        false,
      );

      if (session && session.stagehand) {
        // Store the actual Browserbase session ID for the replay URL
        browserbaseSessionId = session.sessionId;

        // Close any ngrok tunnels associated with this session
        await ngrokManager.closeSessionTunnels(previousSessionId);

        // cleanupSession handles both closing Stagehand and cleanup (idempotent)
        await sessionManager.cleanupSession(previousSessionId);
        cleanupSuccessful = true;
      } else {
        process.stderr.write(
          `[tool.closeSession] No session found for ID: ${previousSessionId || "default/unknown"}\n`,
        );
      }
    } catch (error: unknown) {
      cleanupErrorMessage =
        error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[tool.closeSession] Error cleaning up session (ID was ${previousSessionId || "default/unknown"}): ${cleanupErrorMessage}\n`,
      );
    }

    // Step 2: SessionManager automatically resets to default on cleanup
    // Context.currentSessionId getter will reflect the new active session
    const oldContextSessionId = previousSessionId;
    process.stderr.write(
      `[tool.closeSession] Session context reset to default. Previous context session ID was ${oldContextSessionId || "default/unknown"}.\n`,
    );

    // Step 3: Determine the result message
    const defaultSessionId = sessionManager.getDefaultSessionId();
    if (cleanupErrorMessage && !cleanupSuccessful) {
      throw new Error(
        `Failed to cleanup session (session ID was ${previousSessionId || "default/unknown"}). Error: ${cleanupErrorMessage}. Session context has been reset to default.`,
      );
    }

    if (cleanupSuccessful) {
      let successMessage = `Browser session (${previousSessionId || "default"}) closed successfully. Context reset to default.`;
      // Only show replay URL for cloud sessions (browserbaseSessionId will be a Browserbase ID, not our internal ID)
      if (browserbaseSessionId && browserbaseSessionId !== previousSessionId && previousSessionId !== defaultSessionId) {
        successMessage += ` View replay at https://www.browserbase.com/sessions/${browserbaseSessionId}`;
      }
      return { content: [{ type: "text", text: successMessage }] };
    }

    // No session was found
    let infoMessage =
      "No active session found to close. Session context has been reset to default.";
    if (previousSessionId && previousSessionId !== defaultSessionId) {
      infoMessage = `No active session found for session ID '${previousSessionId}'. The context has been reset to default.`;
    }
    return { content: [{ type: "text", text: infoMessage }] };
  };

  return {
    action: action,
    waitForNetwork: false,
  };
}

const closeSessionTool: Tool<typeof CloseSessionInputSchema> = {
  capability: "core",
  schema: closeSessionSchema,
  handle: handleCloseSession,
};

export default [createSessionTool, closeSessionTool];
