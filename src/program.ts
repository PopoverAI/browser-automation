import { program } from "commander";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import createServerFunction from "./index.js";
import { ServerList } from "./server.js";
import { startHttpTransport, startStdioTransport } from "./transport.js";

import { resolveConfig } from "./config.js";
import { type Scenario, parseScenario } from "./scenario.js";
import { parseVariablesEnv } from "./variables.js";
import { runScenario, DEFAULT_MODEL_NAME } from "./runScenario.js";

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
  .description("Run browser test assertions using Stagehand agent (one browser session)")
  .argument("[url]", "URL to test")
  .argument("[assertions...]", "Assertions to verify")
  .option(
    "--scenario <scenario>",
    "JSON scenario string or file path (mutually exclusive with positional url/assertions)"
  )
  .option("--usage", "Include token usage data in output")
  .action(async (url: string | undefined, assertions: string[], options: { scenario?: string; usage?: boolean }, cmd: { optsWithGlobals: () => { cloud?: boolean; modelName?: string; modelApiKey?: string } }) => {
    const globalOpts = cmd.optsWithGlobals();
    if (options.scenario && (url || assertions.length)) {
      console.error("Error: --scenario cannot be used with positional url/assertions arguments");
      process.exit(1);
    }
    if (!options.scenario && (!url || !assertions.length)) {
      console.error("Error: either --scenario or <url> <assertions...> is required");
      process.exit(1);
    }

    // Build scenario from either --scenario flag or positional args
    let scenario: Scenario;
    if (options.scenario) {
      try {
        scenario = parseScenario(options.scenario);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    } else {
      scenario = {
        baseUrl: url!,
        steps: assertions.map(a => ({ step: "assert" as const, description: a })),
      };
    }

    const modelName = globalOpts.modelName ?? DEFAULT_MODEL_NAME;
    const modelApiKey = globalOpts.modelApiKey ||
      process.env.MODEL_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY;

    const result = await runScenario({
      scenario,
      modelName,
      modelApiKey,
      env: globalOpts.cloud ? "BROWSERBASE" : "LOCAL",
      variables: parseVariablesEnv(process.env.STAGEHAND_VARIABLES),
      includeUsage: options.usage,
    });

    const payload: { results: typeof result.results; usage?: Record<string, unknown> } = {
      results: result.results,
    };
    if (result.usage) {
      payload.usage = result.usage;
    }

    if (result.structured) {
      console.log(JSON.stringify(payload));
      process.exit(result.allPassed ? 0 : 1);
    } else {
      console.error(JSON.stringify({ results: result.results }));
      process.exit(1);
    }
  });

program.parse(process.argv);
