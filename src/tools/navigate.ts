import { z } from "zod";
import type { Tool, ToolSchema, ToolResult } from "./tool.js";
import type { Context } from "../context.js";
import type { ToolActionResult } from "../types/types.js";
import type { TunnelInfo } from "../ngrokManager.js";

const NavigateInputSchema = z.object({
  url: z.string().describe("The URL to navigate to"),
});

type NavigateInput = z.infer<typeof NavigateInputSchema>;

const navigateSchema: ToolSchema<typeof NavigateInputSchema> = {
  name: "stagehand_navigate",
  description: `Navigate to a URL in the browser. Only use this tool with URLs you're confident will work and be up to date.
    Otherwise, use https://google.com as the starting point.
    Supports localhost URLs when using cloud browser - automatically tunnels via ngrok.`,
  inputSchema: NavigateInputSchema,
};

/**
 * Check if hostname is localhost.
 */
function isLocalhost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(hostname.toLowerCase());
}

/**
 * Set extra HTTP headers on the browser context for ngrok auth.
 * Uses Playwright's built-in setExtraHTTPHeaders which is more reliable than CDP Fetch.
 */
async function setupNgrokHeaders(
  context: any,
  auth: { user: string; pass: string }
): Promise<void> {
  const authHeader = `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString("base64")}`;

  try {
    await context.setExtraHTTPHeaders({
      "Authorization": authHeader,
      "ngrok-skip-browser-warning": "true",
    });
    process.stderr.write(`[Navigate] ngrok headers configured via setExtraHTTPHeaders\n`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[Navigate] WARN - Failed to set ngrok headers: ${errorMsg}\n`);
  }
}

async function handleNavigate(
  context: Context,
  params: NavigateInput,
): Promise<ToolResult> {
  const action = async (): Promise<ToolActionResult> => {
    try {
      const stagehand = await context.getStagehand();
      const sessionManager = context.getSessionManager();
      const ngrokManager = context.getNgrokManager();

      const pages = stagehand.context.pages();
      const page = pages[0];

      if (!page) {
        throw new Error("No active page available");
      }

      // Parse the URL
      let targetUrl: URL;
      try {
        targetUrl = new URL(params.url);
      } catch {
        throw new Error(`Invalid URL: ${params.url}`);
      }

      let finalUrl = params.url;
      let tunnelInfo: TunnelInfo | undefined;

      // Check if this is a localhost URL and we're using a cloud session
      const isCloudSession = !!stagehand.browserbaseSessionId;
      const isLocalhostUrl = isLocalhost(targetUrl.hostname);

      if (isCloudSession && isLocalhostUrl) {
        // Get the port (default to 80 for http, 443 for https)
        const port = targetUrl.port
          ? parseInt(targetUrl.port, 10)
          : targetUrl.protocol === "https:" ? 443 : 80;

        const sessionId = sessionManager.getActiveSessionId();

        process.stderr.write(
          `[Navigate] Localhost URL detected with cloud session, creating ngrok tunnel for port ${port}\n`
        );

        // Create or reuse ngrok tunnel
        tunnelInfo = await ngrokManager.ensureTunnel(port, sessionId);

        // Rewrite the URL to use the ngrok tunnel
        const ngrokUrl = new URL(tunnelInfo.url);
        targetUrl.protocol = ngrokUrl.protocol;
        targetUrl.hostname = ngrokUrl.hostname;
        targetUrl.port = ngrokUrl.port;

        finalUrl = targetUrl.toString();

        // Set extra HTTP headers for ngrok auth
        await setupNgrokHeaders(stagehand.context, tunnelInfo.auth);

        process.stderr.write(`[Navigate] Rewritten URL: ${params.url} -> ${finalUrl}\n`);
      }

      // Navigate to the final URL
      await page.goto(finalUrl, { waitUntil: "domcontentloaded" });

      // Build response message
      let responseText = `Navigated to: ${params.url}`;
      if (tunnelInfo) {
        responseText += ` (via ngrok tunnel: ${tunnelInfo.url})`;
      }

      return {
        content: [
          {
            type: "text",
            text: responseText,
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to navigate: ${errorMsg}`);
    }
  };

  return {
    action,
    waitForNetwork: false,
  };
}

const navigateTool: Tool<typeof NavigateInputSchema> = {
  capability: "core",
  schema: navigateSchema,
  handle: handleNavigate,
};

export default navigateTool;
