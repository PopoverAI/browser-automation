import { program } from "commander";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import createServerFunction from "./index.js";
import { ServerList } from "./server.js";
import { startHttpTransport, startStdioTransport } from "./transport.js";

import { resolveConfig } from "./config.js";
import { Stagehand } from "@browserbasehq/stagehand";
import { type Scenario, parseScenario, buildInstruction, buildOutputSchema, getAssertCount } from "./scenario.js";

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
  .action(async (url: string | undefined, assertions: string[], options: { scenario?: string }, cmd: { optsWithGlobals: () => { cloud?: boolean; modelName?: string; modelApiKey?: string } }) => {
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

    const instruction = buildInstruction(scenario);
    const outputSchema = buildOutputSchema(scenario);
    const assertCount = getAssertCount(scenario);

    const modelName = globalOpts.modelName ?? "google/gemini-3-flash-preview";
    const modelApiKey = globalOpts.modelApiKey ||
      process.env.MODEL_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY;

    const stagehand = new Stagehand({
      env: globalOpts.cloud ? "BROWSERBASE" : "LOCAL",
      model: modelApiKey
        ? { apiKey: modelApiKey, modelName }
        : modelName,
      experimental: true,
    });

    try {
      await stagehand.init();
      const page = stagehand.context.pages()[0];
      await page.goto(scenario.baseUrl);

      const agent = stagehand.agent({
        mode: "hybrid",
        model: modelName,
      });

      const result = await agent.execute({
        instruction,
        maxSteps: 30,
        output: outputSchema,
      });

      const output = result.output as { results: { status: string; notes: string; key?: string }[] } | undefined;
      if (output?.results) {
        console.log(JSON.stringify({ results: output.results }));
        const allPassed = output.results.every(r => r.status === "passed");
        process.exit(allPassed ? 0 : 1);
      } else {
        const blocked = Array.from({ length: assertCount }, () => ({
          status: "blocked",
          notes: "No structured output returned from agent",
        }));
        console.error(JSON.stringify({ results: blocked }));
        process.exit(1);
      }
    } catch (error) {
      const errorMsg = `Error: ${error instanceof Error ? error.message : String(error)}`;
      const blocked = Array.from({ length: assertCount }, () => ({
        status: "blocked",
        notes: errorMsg,
      }));
      console.error(JSON.stringify({ results: blocked }));
      process.exit(1);
    } finally {
      await stagehand.close();
    }
  });

program.parse(process.argv);
