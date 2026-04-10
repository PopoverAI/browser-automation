import type { AvailableModelSchema } from "@browserbasehq/stagehand";
import type { Variables } from "./src/variables.js";

export type Config = {
  /**
   * Browserbase API Key to authenticate requests
   */
  browserbaseApiKey: string;
  /**
   * Browserbase Project ID associated with the API key
   */
  browserbaseProjectId: string;
  /**
   * Whether or not to use Browserbase proxies
   * https://docs.browserbase.com/features/proxies
   *
   * @default false
   */
  proxies?: boolean;
  /**
   * Use advanced stealth mode. Only available to Browserbase Scale Plan users.
   *
   * @default false
   */
  advancedStealth?: boolean;
  /**
   * Whether or not to keep the Browserbase session alive
   *
   * @default false
   */
  keepAlive?: boolean;
  /**
   * Potential Browserbase Context to use
   * Would be a context ID
   */
  context?: {
    /**
     * The ID of the context to use
     */
    contextId?: string;
    /**
     * Whether or not to persist the context
     *
     * @default true
     */
    persist?: boolean;
  };
  /**
   * The viewport of the browser
   * @default { browserWidth: 1024, browserHeight: 768 }
   */
  viewPort?: {
    /**
     * The width of the browser
     */
    browserWidth?: number;
    /**
     * The height of the browser
     */
    browserHeight?: number;
  };
  /**
   * Server configuration for MCP transport layer
   *
   * Controls how the MCP server binds and listens for connections.
   * When port is specified, the server will start an SHTTP transport.
   * When both port and host are undefined, the server uses stdio transport.
   *
   * Security considerations:
   * - Use localhost (default) for local development
   * - Use 0.0.0.0 only when you need external access and have proper security measures
   * - Consider firewall rules and network security when exposing the server
   */
  server?: {
    /**
     * The port to listen on for SHTTP or MCP transport.
     * If undefined, uses stdio transport instead of HTTP.
     *
     * @example 3000
     */
    port?: number;
    /**
     * The host to bind the server to.
     *
     * @default "localhost" - Only accepts local connections
     * @example "0.0.0.0" - Accepts connections from any interface (use with caution)
     */
    host?: string;
  };
  /**
   * The Model that Stagehand uses
   * Available models: OpenAI, Claude, Gemini, Cerebras, Groq, and other providers
   *
   * @default "gemini-2.0-flash"
   */
  modelName?: z.infer<typeof AvailableModelSchema>;
  /**
   * API key for the custom model provider
   * Required when using a model other than the default gemini-2.0-flash
   */
  modelApiKey?: string;
  /**
   * Enable experimental features
   *
   * @default false
   */
  experimental?: boolean;
  /**
   * Enable Playwright MCP federation for low-level browser control tools.
   * When enabled, spawns Playwright MCP as a subprocess and exposes its tools
   * with a `playwright_` prefix. Requires additional resources (subprocess, port).
   *
   * @default false
   */
  enablePlaywright?: boolean;
  /**
   * Default to Browserbase cloud mode instead of local Playwright.
   * When true, stagehand_session_create will use cloud=true by default.
   * Useful for CI/CD environments without a local browser.
   *
   * @default false
   */
  cloud?: boolean;
  /**
   * Global Stagehand variables, auto-injected into every stagehand_act,
   * stagehand_agent, and stagehand_scenario call. Populated from the
   * STAGEHAND_VARIABLES env var (JSON-encoded). LLMs reference values as
   * %varName% in instructions; raw values are substituted at runtime and
   * never sent to the LLM.
   */
  variables?: Variables;
};
