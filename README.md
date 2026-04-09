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
```

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
| `--modelName <model>` | Model to use (default: `google/gemini-3-flash-preview`) |
| `--modelApiKey <key>` | API key for the model provider |
| `--cloud` | Use Browserbase cloud browser instead of local Playwright |

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
