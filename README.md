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

## Usage

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
