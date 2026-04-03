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

## Environment Variables

```
GEMINI_API_KEY=...               # for Stagehand AI features (act, extract, observe, agent)
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

Run browser-based assertions from the command line using Claude. Each invocation runs a single browser session where all assertions are checked:

```bash
browser-automation test <url> <assertions...> [options]
```

Examples:
```bash
# Single assertion
browser-automation test "https://example.com" "The page has a heading"

# Multiple assertions (same browser session)
browser-automation test "https://example.com" \
  "The page has a heading" \
  "There is a link on the page" \
  "The title contains 'Example'"
```

Returns a JSON array of results (one per assertion):
```json
[
  {"status":"passed","notes":"The page has a heading 'Example Domain'"},
  {"status":"passed","notes":"There is a link that says 'More information'"},
  {"status":"passed","notes":"The title is 'Example Domain'"}
]
```

Each result contains:
- `status`: `"passed"` | `"failed"` | `"blocked"`
- `notes`: explanation of the result

Exit codes: 0 if all assertions pass, 1 otherwise.

**Options:**

| Option | Description |
|--------|-------------|
| `--tools <tools>` | Enable built-in Claude tools (default: none). Example: `--tools "Bash,Read"` |
| `--allowConfiguredMCPs` | Include your globally configured MCP servers (default: browser MCP only) |
| `--useAgent` | Encourage Claude to prefer the Agent tool for multi-step tasks |
| `--cloud` | Use Browserbase cloud browser instead of local Playwright. Requires `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` environment variables. |

**Security:** By default, Claude only has access to browser automation tools - no shell, filesystem, or other MCPs. Use `--tools` and `--allowConfiguredMCPs` to expand access at your own risk.

Requires the [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) to be installed.

## MCP Usage

Basic (Stagehand tools only):
```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["@popoverai/browser-automation"]
    }
  }
}
```

With Playwright federation (adds low-level browser control tools):
```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["@popoverai/browser-automation", "--enable-playwright"]
    }
  }
}
```

The `--enable-playwright` flag spawns a Playwright MCP subprocess and federates its tools (click, fill, type, etc.) alongside the Stagehand AI tools.

## License

Apache-2.0 (same as original)
