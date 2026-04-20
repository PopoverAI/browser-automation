// Vestigial entry_point required by MCPB schema for type: "node".
// Not actually executed at runtime — the manifest overrides mcp_config.command
// to "npx", so Claude Desktop launches npx directly instead of this file.
// Kept here only so `mcpb pack` passes validation.
throw new Error(
  "server.js was unexpectedly executed. The manifest should route via npx.",
);
