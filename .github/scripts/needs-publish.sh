#!/usr/bin/env bash
# Usage: needs-publish.sh NAME VERSION
# Prints true when NAME@VERSION still needs publishing, false when it is on
# npm. Only an E404 means "not published". Any other failure (network, a
# registry error) exits non-zero rather than being read as a version to
# publish.
set -euo pipefail
NAME=$1
VERSION=$2
ERR=$(mktemp)
if OUT=$(npm view "$NAME@$VERSION" version 2>"$ERR"); then
  if [ "$OUT" != "$VERSION" ]; then
    echo "::error::npm view returned '$OUT' for $NAME@$VERSION." >&2
    exit 1
  fi
  echo "::notice::$NAME@$VERSION is already on npm." >&2
  echo false
elif grep -q "code E404" "$ERR"; then
  echo "::notice::$NAME@$VERSION is not on npm yet." >&2
  echo true
else
  cat "$ERR" >&2
  echo "::error::Could not tell whether $NAME@$VERSION is on npm." >&2
  exit 1
fi
