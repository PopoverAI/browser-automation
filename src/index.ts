import * as dotenv from "dotenv";
dotenv.config();

import { randomUUID } from "crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MCPToolsArray } from "./types/types.js";

import { Context } from "./context.js";
import type { Config } from "../config.d.ts";
import { TOOLS } from "./tools/index.js";
import { RESOURCE_TEMPLATES } from "./mcp/resources.js";
import { CdpProxy } from "./cdpProxy.js";
import { PlaywrightFederation } from "./playwrightFederation.js";

import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

// Configuration schema for Smithery - matches existing Config interface
export const configSchema = z
  .object({
    browserbaseApiKey: z.string().describe("The Browserbase API Key to use"),
    browserbaseProjectId: z
      .string()
      .describe("The Browserbase Project ID to use"),
    proxies: z
      .boolean()
      .optional()
      .describe("Whether or not to use Browserbase proxies"),
    advancedStealth: z
      .boolean()
      .optional()
      .describe(
        "Use advanced stealth mode. Only available to Browserbase Scale Plan users",
      ),
    keepAlive: z
      .boolean()
      .optional()
      .describe("Whether or not to keep the Browserbase session alive"),
    context: z
      .object({
        contextId: z
          .string()
          .optional()
          .describe("The ID of the context to use"),
        persist: z
          .boolean()
          .optional()
          .describe("Whether or not to persist the context"),
      })
      .optional(),
    viewPort: z
      .object({
        browserWidth: z
          .number()
          .optional()
          .describe("The width of the browser"),
        browserHeight: z
          .number()
          .optional()
          .describe("The height of the browser"),
      })
      .optional(),
    server: z
      .object({
        port: z
          .number()
          .optional()
          .describe("The port to listen on for SHTTP or MCP transport"),
        host: z
          .string()
          .optional()
          .describe(
            "The host to bind the server to. Default is localhost. Use 0.0.0.0 to bind to all interfaces",
          ),
      })
      .optional(),
    modelName: z
      .string()
      .optional()
      .describe("The model to use for Stagehand (default: google/gemini-3-flash-preview)"),
    modelApiKey: z
      .string()
      .optional()
      .describe(
        "API key for the custom model provider. Required when using a model other than the default google/gemini-3-flash-preview",
      ),
    experimental: z
      .boolean()
      .optional()
      .describe("Enable experimental Stagehand features"),
    enablePlaywright: z
      .boolean()
      .optional()
      .describe("Enable Playwright MCP federation for low-level browser control tools (spawns subprocess)"),
  })
  .refine(
    (data) => {
      // If a non-default model is explicitly specified, API key is required
      if (data.modelName && data.modelName !== "google/gemini-3-flash-preview") {
        return (
          data.modelApiKey !== undefined &&
          typeof data.modelApiKey === "string" &&
          data.modelApiKey.length > 0
        );
      }
      return true;
    },
    {
      message: "modelApiKey is required when specifying a custom model",
      path: ["modelApiKey"],
    },
  );

// Default function for Smithery - async to block until federation is ready
export default async function ({ config }: { config: z.infer<typeof configSchema> }) {
  // Note: browserbaseApiKey and browserbaseProjectId are only required for cloud mode
  // They are validated at session creation time when cloud: true is passed

  const server = new McpServer(
    {
      name: "Stagehand MCP Server",
      version: "0.1.0",
    },
    {
      capabilities: {
        resources: {
          subscribe: true,
          listChanged: true,
        },
        tools: {},
      },
    }
  );

  const internalConfig: Config = config as Config;

  // Create the context, passing server instance and config
  const contextId = randomUUID();
  const context = new Context(server.server, internalConfig, contextId);

  // CDP proxy and Playwright federation (opt-in via enablePlaywright flag)
  let cdpProxy: CdpProxy | null = null;
  let playwrightFederation: PlaywrightFederation | null = null;

  if (internalConfig.enablePlaywright) {
    // Create and start CDP proxy for Playwright federation (dynamic port)
    cdpProxy = new CdpProxy(
      context.getSessionManager(),
      internalConfig
    );
    const cdpProxyPort = await cdpProxy.start();

    // Create Playwright federation with the dynamically allocated port
    playwrightFederation = new PlaywrightFederation(cdpProxyPort);
  }

  server.server.registerCapabilities({
    resources: {
      subscribe: true,
      listChanged: true,
    },
  });

  // Add resource handlers
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return context.listResources();
  });

  server.server.setRequestHandler(
    ReadResourceRequestSchema,
    async (request) => {
      return context.readResource(request.params.uri);
    },
  );

  server.server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async () => {
      return { resourceTemplates: RESOURCE_TEMPLATES };
    },
  );

  const tools: MCPToolsArray = [...TOOLS];

  // Register each tool with the Smithery server
  tools.forEach((tool) => {
    if (tool.schema.inputSchema instanceof z.ZodObject) {
      server.tool(
        tool.schema.name,
        tool.schema.description,
        tool.schema.inputSchema.shape,
        async (params: z.infer<typeof tool.schema.inputSchema>) => {
          try {
            const result = await context.run(tool, params);
            return result;
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            process.stderr.write(
              `[Smithery Error] ${new Date().toISOString()} Error running tool ${tool.schema.name}: ${errorMessage}\n`,
            );
            throw new Error(
              `Failed to run tool '${tool.schema.name}': ${errorMessage}`,
            );
          }
        },
      );
    } else {
      console.warn(
        `Tool "${tool.schema.name}" has an input schema that is not a ZodObject. Schema type: ${tool.schema.inputSchema.constructor.name}`,
      );
    }
  });

  // Start Playwright federation and register its tools (if enabled)
  if (playwrightFederation) {
    // Capture in const for TypeScript narrowing in closures
    const federation = playwrightFederation;
    try {
      await federation.start();

      // Register federated Playwright tools
      for (const tool of federation.getTools()) {
        server.tool(
          tool.name,
          tool.description,
          tool.inputSchema as Record<string, z.ZodTypeAny>,
          async (params: Record<string, unknown>): Promise<CallToolResult> => {
            try {
              const result = await federation.callTool(tool.originalName, params);
              return result;
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              process.stderr.write(
                `[Federation Error] ${new Date().toISOString()} Error calling ${tool.name}: ${errorMessage}\n`,
              );
              throw new Error(`Failed to call '${tool.name}': ${errorMessage}`);
            }
          }
        );
      }

      process.stderr.write(
        `[stagehand-mcp] Playwright federation ready with ${federation.getTools().length} tools\n`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[stagehand-mcp] WARN - Playwright federation failed to start: ${errorMessage}\n` +
        `Playwright tools will not be available. Stagehand tools will work normally.\n`
      );
    }
  }

  // Set up cleanup handlers
  const cleanup = async () => {
    process.stderr.write(`[stagehand-mcp] Shutting down...\n`);

    // Close ngrok tunnels
    await context.getNgrokManager().closeAll();

    // Stop Playwright federation (if enabled)
    if (playwrightFederation) {
      await playwrightFederation.shutdown();
    }

    // Stop CDP proxy (if enabled)
    if (cdpProxy) {
      cdpProxy.stop();
    }

    // Close all browser sessions
    await context.getSessionManager().closeAllSessions();

    process.stderr.write(`[stagehand-mcp] Shutdown complete\n`);
  };

  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });

  // Handle stdin close (most common way Claude Code disconnects)
  process.stdin.on("close", async () => {
    await cleanup();
  });

  return server.server;
}
