#!/usr/bin/env node
// `agentic-demo` — the npx-able name for this project's CLI. Nothing lives
// here but the name: the implementation, guide and schema all ship in
// @popoverai/browser-automation, whose bin is spelled `agentic-demo` too, so
// there is one CLI to maintain and no way for the two to drift.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

let cli;
try {
  // Resolve via package.json: the package's exports map does not expose
  // dist/cli.js, and going through the manifest keeps this working whatever
  // the installer's node_modules layout is.
  cli = join(
    dirname(require.resolve("@popoverai/browser-automation/package.json")),
    "dist",
    "cli.js",
  );
} catch {
  process.stderr.write(
    "agentic-demo: cannot find @popoverai/browser-automation, which carries the CLI this name points at.\n" +
      "Reinstall (npm i agentic-demo), or run the package directly:\n" +
      "  npx @popoverai/browser-automation …\n",
  );
  process.exit(1);
}

// The CLI parses process.argv on import; this file takes argv[1], so the
// arguments after it arrive unchanged.
await import(pathToFileURL(cli).href);
