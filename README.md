# Browser Automation MCP

MCP server for AI browser automation. Alpha software - expect bugs and rough edges.

## Attribution

This is a fork of [@browserbasehq/mcp-server-browserbase](https://github.com/browserbase/mcp-server-browserbase) by Browserbase, Inc., licensed under Apache 2.0.

## Modifications from Original

1. **Default to LOCAL** - Uses local Playwright by default instead of requiring Browserbase cloud. Pass `cloud: true` to session create for cloud execution.

2. **Hybrid mode agent** - Agent tool uses hybrid mode (DOM + coordinate-based actions) with `google/gemini-3-flash-preview` instead of CUA mode.

3. **Vercel header injection** - Automatically injects `x-vercel-protection-bypass` header when `VERCEL_AUTOMATION_BYPASS_SECRET` env var is set.

4. **Renamed tools** - All tools renamed from `browserbase_*` to `stagehand_*`.

## Tools

| Tool | Description |
|------|-------------|
| `stagehand_session_create` | Create browser session. `cloud?: boolean` to use Browserbase (default: local) |
| `stagehand_session_close` | Close the current session |
| `stagehand_navigate` | Navigate to a URL |
| `stagehand_act` | Perform an action on the page (natural language) |
| `stagehand_extract` | Extract structured data from the page |
| `stagehand_observe` | Observe and find actionable elements |
| `stagehand_screenshot` | Capture a screenshot |
| `stagehand_get_url` | Get current page URL |
| `stagehand_agent` | Autonomous multi-step execution (hybrid mode) |
| `agent_browser_help` | Show help for agent-browser, a low-level CLI for precise browser control |
| `agent_browser_run` | Run a low-level browser command (snapshot, click by ref, network, JS eval, etc.) |

### Stagehand vs agent-browser

Stagehand tools (`stagehand_act`, `stagehand_extract`, etc.) provide high-level, AI-powered browser control — good for acceptance testing and exploratory flows where natural language actions are convenient.

agent-browser tools (`agent_browser_run`) provide low-level, deterministic control — good for precise element interactions by ref, DOM inspection, network debugging, JS evaluation, and situations where Stagehand's abstractions are too coarse. agent-browser shares the same browser session as Stagehand via CDP, so you can freely mix both.

agent-browser is resolved via `npx` automatically — no global install required.

## Environment Variables

```
MODEL_API_KEY=...                # API key for the configured model provider (works with any provider)
GEMINI_API_KEY=...               # alternative to MODEL_API_KEY for Gemini (the default model)
BROWSERBASE_API_KEY=...          # only needed for cloud: true
BROWSERBASE_PROJECT_ID=...       # only needed for cloud: true
NGROK_AUTHTOKEN=...              # only needed for cloud: true with localhost URLs
VERCEL_AUTOMATION_BYPASS_SECRET=... # optional, for Vercel preview deployments
STAGEHAND_VARIABLES=...          # optional, JSON map of variables auto-injected into stagehand_act, stagehand_agent, and stagehand_scenario (see Variables below)
```

## Variables

Stagehand supports templated variables in instructions so sensitive values (passwords, API keys, personal info) can be kept out of the text sent to the LLM. Reference them in any `stagehand_act`, `stagehand_agent`, or `stagehand_scenario` instruction as `%varName%` and Stagehand substitutes the value client-side just before the action runs.

There are three ways to supply variables. Later sources override earlier ones on key conflict:

1. **Global** — set the `STAGEHAND_VARIABLES` env var to a JSON object. Applies to every tool call and every CLI scenario run.
2. **Scenario-scoped** — add a top-level `variables` field to a scenario object (MCP tool or CLI `--scenario` JSON). Applies to the agent call that runs the scenario.
3. **Per-call** — pass `variables` as a parameter to `stagehand_act` or `stagehand_agent`.

All three use the same shape:

```json
{
  "password": { "value": "hunter2" },
  "username": { "value": "user@example.com", "description": "login email" }
}
```

`description` is optional. For agent calls it helps the model understand when to use each variable; for act calls it's ignored.

Example MCP client config with a global:

```json
"env": {
  "MODEL_API_KEY": "sk-ant-...",
  "STAGEHAND_VARIABLES": "{\"password\":{\"value\":\"hunter2\",\"description\":\"login password\"}}"
}
```

Example CLI scenario with a scenario-scoped variable:

```bash
browser-automation test --scenario '{"baseUrl":"https://example.com/login","variables":{"password":{"value":"hunter2"}},"steps":[{"step":"act","description":"Type %password% into the password field"},{"step":"assert","description":"Login succeeds"}]}'
```

### Caveat: screenshot leakage in hybrid mode

Stagehand guarantees that raw values never appear in the instructions sent to the LLM. But the agent tool runs in hybrid mode, which takes screenshots between steps, and any value typed into a non-masked input (search box, plain text field) will be *rendered* on the page and captured by the next screenshot. A vision model looking at that screenshot can read the value and echo it in its reasoning or final message. Password fields are safe because browsers mask them to dots; everything else is not. Variables protect the instruction channel, not the visible page.

## Localhost Tunneling (Cloud Mode)

When using cloud mode (`cloud: true`), the browser runs on Browserbase's infrastructure and can't directly access your localhost. If you navigate to a localhost URL, the server automatically creates an ngrok tunnel to expose your local service to the cloud browser.

- Requires `NGROK_AUTHTOKEN` environment variable
- Tunnels are session-scoped and cleaned up automatically
- Each tunnel gets randomly generated basic auth credentials for security
- Only triggered when navigating to localhost URLs in cloud mode

## CLI

### Test Command

Run browser-based assertions from the command line using the Stagehand agent. Each invocation runs a single browser session where all assertions are checked:

```bash
browser-automation test <url> <assertions...> [options]
browser-automation test --scenario <json-or-file> [options]
```

Examples:
```bash
# Simple assertions
browser-automation test "https://example.com" "The page has a heading"

# Multiple assertions (same browser session)
browser-automation test "https://example.com" \
  "The page has a heading" \
  "There is a link on the page" \
  "The title contains 'Example'"

# Using a custom model
browser-automation test --modelName "anthropic/claude-haiku-4-5" \
  --modelApiKey "sk-ant-..." \
  "https://example.com" "The page has a heading"

# Multi-step scenario (arrange/act/assert)
browser-automation test --scenario '{"baseUrl":"https://example.com","steps":[{"step":"act","description":"Click the More information link"},{"step":"assert","description":"Page navigated away from example.com"}]}'
```

Scenarios can also reference templated variables (see [Variables](#variables)) — either from the `STAGEHAND_VARIABLES` env var or from a top-level `variables` field on the scenario object itself.

Returns JSON results (one per assertion):
```json
{"results":[{"status":"passed","notes":"The page has a heading 'Example Domain'"}]}
```

Each result contains:
- `status`: `"passed"` | `"failed"` | `"blocked"`
- `notes`: explanation of the result

Exit codes: 0 if all assertions pass, 1 otherwise.

**Options:**

| Option | Description |
|--------|-------------|
| `--scenario <json\|file>` | JSON scenario string or file path (mutually exclusive with positional url/assertions) |
| `--usage` | Include token usage data in the JSON output |
| `--modelName <model>` | Model to use (default: `google/gemini-3-flash-preview`) |
| `--modelApiKey <key>` | API key for the model provider |
| `--cloud` | Use Browserbase cloud browser instead of local Playwright |

When `--usage` is passed, a `usage` field is added to the JSON output alongside `results`:

```json
{
  "results": [{"status": "passed", "notes": "The page title is 'Example Domain'"}],
  "usage": {
    "model": "google/gemini-3-flash-preview",
    "input_tokens": 16223,
    "output_tokens": 47,
    "reasoning_tokens": 474,
    "cached_input_tokens": 7990,
    "inference_time_ms": 10336
  }
}
```

## MCP Usage

Basic (Stagehand tools only):
```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["@popoverai/browser-automation"],
      "env": {
        "MODEL_API_KEY": "your-api-key"
      }
    }
  }
}
```

With a custom model and Playwright federation:
```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["@popoverai/browser-automation", "--enable-playwright", "--modelName", "anthropic/claude-haiku-4-5"],
      "env": {
        "MODEL_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

The `--enable-playwright` flag spawns a Playwright MCP subprocess and federates its tools (click, fill, type, etc.) alongside the Stagehand AI tools.

## License

Apache-2.0 (same as original)
