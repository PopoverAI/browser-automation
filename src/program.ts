import { program } from "commander";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import createServerFunction from "./index.js";
import { ServerList } from "./server.js";
import { startHttpTransport, startStdioTransport } from "./transport.js";

import { resolveConfig } from "./config.js";
import { runTest } from "./testRunner.js";

let __filename: string;
let __dirname: string;

try {
  // Try ES modules first
  __filename = fileURLToPath(import.meta.url);
  __dirname = path.dirname(__filename);
} catch {
  // Fallback for CommonJS or when import.meta is not available
  __filename =
    (globalThis as { __filename: string }).__filename ||
    process.cwd() + "/dist/program.js";
  __dirname = path.dirname(__filename);
}

// Load package.json using fs
const packageJSONPath = path.resolve(__dirname, "../package.json");
const packageJSONBuffer = fs.readFileSync(packageJSONPath);
const packageJSON = JSON.parse(packageJSONBuffer.toString());

program
  .version("Version " + packageJSON.version)
  .name(packageJSON.name)
  .option("--browserbaseApiKey <key>", "The Browserbase API Key to use")
  .option("--browserbaseProjectId <id>", "The Browserbase Project ID to use")
  .option("--proxies", "Use Browserbase proxies.")
  .option(
    "--advancedStealth",
    "Use advanced stealth mode. Only available to Browserbase Scale Plan users.",
  )
  .option("--contextId <contextId>", "Browserbase Context ID to use.")
  .option(
    "--persist [boolean]",
    "Whether to persist the Browserbase context",
    true,
  )
  .option("--port <port>", "Port to listen on for SHTTP transport.")
  .option(
    "--host <host>",
    "Host to bind server to. Default is localhost. Use 0.0.0.0 to bind to all interfaces.",
  )
  .option("--browserWidth <width>", "Browser width to use for the browser.")
  .option("--browserHeight <height>", "Browser height to use for the browser.")
  .option(
    "--modelName <model>",
    "The model to use for Stagehand (default: google/gemini-3-flash-preview)",
  )
  .option(
    "--modelApiKey <key>",
    "API key for the custom model provider (required when using custom models)",
  )
  .option("--keepAlive", "Enable Browserbase Keep Alive Session")
  .option("--experimental", "Enable experimental features")
  .option("--enable-playwright", "Enable Playwright MCP federation for low-level browser control tools")
  .option("--cloud", "Default to Browserbase cloud mode instead of local Playwright")
  .action(async (options) => {
    const config = await resolveConfig(options);
    const serverList = new ServerList(async () =>
      createServerFunction({
        config: config,
      }),
    );
    setupExitWatchdog(serverList);

    if (options.port)
      startHttpTransport(+options.port, options.host, serverList);
    else await startStdioTransport(serverList, config);
  });

function setupExitWatchdog(serverList: ServerList) {
  const handleExit = async () => {
    setTimeout(() => process.exit(0), 15000);
    try {
      // SessionManager within each server handles session cleanup
      await serverList.closeAll();
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
    process.exit(0);
  };

  process.stdin.on("close", handleExit);
  process.on("SIGINT", handleExit);
  process.on("SIGTERM", handleExit);
}

program
  .command("test")
  .description("Run browser test assertions using Claude (one browser session)")
  .argument("<url>", "URL to test")
  .argument("<assertions...>", "Assertions to verify")
  .option(
    "--tools <tools>",
    "Built-in Claude tools to enable (default: none for security). Example: --tools 'Bash,Read'"
  )
  .option(
    "--allowConfiguredMCPs",
    "Include user's configured MCP servers (default: browser MCP only)"
  )
  .option(
    "--useAgent",
    "Encourage Claude to use the Agent tool for multi-step tasks"
  )
  .action(async (url: string, assertions: string[], options: { tools?: string; allowConfiguredMCPs?: boolean; useAgent?: boolean }, cmd: { optsWithGlobals: () => { cloud?: boolean } }) => {
    const globalOpts = cmd.optsWithGlobals();
    try {
      const result = await runTest(url, assertions, {
        tools: options.tools,
        allowConfiguredMCPs: options.allowConfiguredMCPs,
        cloud: globalOpts.cloud,
        useAgent: options.useAgent,
      });
      console.log(JSON.stringify(result));
      const allPassed = result.results.every(r => r.status === "passed");
      process.exit(allPassed ? 0 : 1);
    } catch (error) {
      console.error(JSON.stringify(assertions.map(() => ({
        status: "blocked",
        notes: `Error: ${error instanceof Error ? error.message : String(error)}`,
      }))));
      process.exit(1);
    }
  });

program.parse(process.argv);
