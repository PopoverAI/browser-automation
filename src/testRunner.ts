import { spawn } from "child_process";
import { fileURLToPath } from "url";
import * as path from "path";

// Resolve path to our own CLI for MCP config
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.resolve(__dirname, "../cli.js");

type TestStatus = "passed" | "failed" | "blocked";

export interface TestResult {
  status: TestStatus;
  notes: string;
}

const SYSTEM_PROMPT = `You are a browser test runner. Navigate to the URL and verify each assertion.

For each assertion, determine its status:
- "passed": The assertion is true
- "failed": The assertion is false
- "blocked": Cannot determine (page didn't load, auth required, CAPTCHA, ambiguous, etc.)

Return results in the same order as the assertions were provided.`;

const JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          status: { enum: ["passed", "failed", "blocked"] },
          notes: { type: "string" },
        },
        required: ["status", "notes"],
      },
    },
  },
  required: ["results"],
});

const MCP_CONFIG = JSON.stringify({
  mcpServers: {
    browser: {
      command: "node",
      args: [CLI_PATH],
    },
  },
});

export interface TestOptions {
  tools?: string;
  allowConfiguredMCPs?: boolean;
}

export async function runTest(
  url: string,
  assertions: string[],
  options: TestOptions = {}
): Promise<TestResult[]> {
  const assertionList = assertions
    .map((a, i) => `${i + 1}. ${a}`)
    .join("\n");
  const userPrompt = `URL: ${url}\n\nAssertions:\n${assertionList}`;

  // Default secure configuration:
  // - tools="" blocks built-in tools (Bash, Read, Write, etc.) while MCP tools remain usable
  // - strict-mcp-config only uses our browser MCP
  // - bypassPermissions required for -p mode (no interactive prompts)
  //
  // Users can override with --tools and --allowConfiguredMCPs at their own risk

  const args = [
    "-p",
    "--tools",
    options.tools ?? "",
    "--mcp-config",
    MCP_CONFIG,
    ...(options.allowConfiguredMCPs ? [] : ["--strict-mcp-config"]),
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "json",
    "--json-schema",
    JSON_SCHEMA,
    "--system-prompt",
    SYSTEM_PROMPT,
    userPrompt,
  ];

  // Log the exact command for debugging
  const quotedArgs = args.map(a => a.includes(" ") || a.includes("{") ? `'${a}'` : a);
  console.error(`[DEBUG] Running: claude ${quotedArgs.join(" ")}`);

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        const response = JSON.parse(stdout);

        if (response.is_error) {
          resolve(assertions.map(() => ({
            status: "blocked" as const,
            notes: `Claude error: ${response.result || "Unknown error"}`,
          })));
          return;
        }

        if (response.structured_output?.results) {
          resolve(response.structured_output.results as TestResult[]);
        } else {
          resolve(assertions.map(() => ({
            status: "blocked" as const,
            notes: `No structured output returned: ${response.result || ""}`,
          })));
        }
      } catch (e) {
        reject(new Error(`Failed to parse claude output: ${stdout}`));
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}
