#!/usr/bin/env bash
# The agentic-demo alias ships in step with the main package: same version,
# and a dependency range that admits exactly that release line. `npm version`
# bumps neither for us, so check both before anything is published.
set -euo pipefail
VERSION=$(jq -r .version package.json)
ALIAS_VERSION=$(jq -r .version alias/agentic-demo/package.json)
ALIAS_RANGE=$(jq -r '.dependencies["@popoverai/browser-automation"]' alias/agentic-demo/package.json)
ok=true
if [ "$ALIAS_VERSION" != "$VERSION" ]; then
  echo "::error file=alias/agentic-demo/package.json::agentic-demo is at $ALIAS_VERSION but @popoverai/browser-automation is at $VERSION. Run: (cd alias/agentic-demo && npm version $VERSION --allow-same-version --no-git-tag-version)"
  ok=false
fi
if [ "$ALIAS_RANGE" != "^$VERSION" ]; then
  echo "::error file=alias/agentic-demo/package.json::agentic-demo depends on @popoverai/browser-automation@$ALIAS_RANGE, not ^$VERSION, so npx agentic-demo would not run this release. Run: (cd alias/agentic-demo && npm pkg set dependencies.@popoverai/browser-automation=^$VERSION)"
  ok=false
fi
$ok && echo "Both packages at $VERSION; the alias depends on ^$VERSION."
$ok
