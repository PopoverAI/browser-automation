import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool, CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";

/**
 * PlaywrightFederation - Spawns Playwright MCP as a subprocess and
 * re-exports its tools through our MCP server.
 *
 * This enables access to Playwright's low-level browser control tools
 * (click, type, screenshot, etc.) while Stagehand handles high-level
 * operations (act, observe, extract).
 *
 * The Playwright MCP connects to our CDP proxy, which forwards to
 * the active Browserbase session.
 */

export interface FederatedTool {
  name: string;
  originalName: string;
  description: string;
  inputSchema: Tool["inputSchema"];
}

export class PlaywrightFederation {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: FederatedTool[] = [];
  private cdpProxyPort: number;

  constructor(cdpProxyPort: number) {
    this.cdpProxyPort = cdpProxyPort;
  }

  /**
   * Start the Playwright MCP subprocess and connect to it.
   */
  async start(): Promise<void> {
    if (this.client) {
      process.stderr.write(`[PlaywrightFederation] Already started\n`);
      return;
    }

    process.stderr.write(`[PlaywrightFederation] Starting Playwright MCP subprocess...\n`);

    try {
      this.transport = new StdioClientTransport({
        command: "npx",
        args: [
          "@playwright/mcp@latest",
          "--cdp-endpoint",
          `ws://localhost:${this.cdpProxyPort}`,
        ],
      });

      this.client = new Client(
        {
          name: "stagehand-mcp-federation",
          version: "1.0.0",
        },
        {
          capabilities: {},
        }
      );

      await this.client.connect(this.transport);

      // List and cache tools
      const { tools } = await this.client.listTools();

      // Filter out browser_navigate (we use our own for ngrok support)
      // and rename to playwright_* prefix for clarity
      this.tools = tools
        .filter((tool) => tool.name !== "browser_navigate")
        .map((tool) => ({
          name: tool.name.replace(/^browser_/, "playwright_"),
          originalName: tool.name,
          description: tool.description || "",
          inputSchema: tool.inputSchema,
        }));

      process.stderr.write(
        `[PlaywrightFederation] Started with ${this.tools.length} tools: ${this.tools.map((t) => t.name).join(", ")}\n`
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[PlaywrightFederation] Failed to start: ${errorMsg}\n`);
      throw new Error(`Failed to start Playwright MCP: ${errorMsg}`);
    }
  }

  /**
   * Get the list of federated tools (renamed to playwright_* prefix).
   */
  getTools(): FederatedTool[] {
    return this.tools;
  }

  /**
   * Call a federated tool by its original name.
   * Transforms the client result format to server result format.
   */
  async callTool(originalName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.client) {
      throw new Error("PlaywrightFederation not started");
    }

    try {
      const result = await this.client.callTool({
        name: originalName,
        arguments: args,
      });

      // The client's callTool returns CompatibilityCallToolResult which is compatible
      // with CallToolResult when content is present
      if ("content" in result && Array.isArray(result.content)) {
        return {
          content: result.content,
          isError: typeof result.isError === "boolean" ? result.isError : false,
        };
      }

      // Fallback: wrap unknown result as text content
      const textContent: TextContent = {
        type: "text",
        text: JSON.stringify(result),
      };
      return {
        content: [textContent],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to call ${originalName}: ${errorMsg}`);
    }
  }

  /**
   * Shutdown the Playwright MCP subprocess.
   */
  async shutdown(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[PlaywrightFederation] Error during shutdown: ${errorMsg}\n`);
      }
      this.client = null;
    }

    if (this.transport) {
      try {
        await this.transport.close();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[PlaywrightFederation] Error closing transport: ${errorMsg}\n`);
      }
      this.transport = null;
    }

    this.tools = [];
    process.stderr.write(`[PlaywrightFederation] Shutdown complete\n`);
  }
}
