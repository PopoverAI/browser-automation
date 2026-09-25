#!/usr/bin/env bash
# Ensure v<version> tags the commit that version was published from.
# Env: NAME, VERSION, SHA (the commit on main), PUBLISHED_NOW (true when this
# run just published it), GH_TOKEN (write token, used only for the push).
set -euo pipefail
TAG="v$VERSION"
# ^{commit} peels an annotated tag to its commit, so the no-op branch is reachable.
if git rev-parse -q --verify "$TAG^{commit}" >/dev/null 2>&1; then
  EXISTING=$(git rev-parse "$TAG^{commit}")
  if [ "$EXISTING" = "$SHA" ]; then
    echo "Tag $TAG already at $SHA — no-op."
    exit 0
  fi
  # Already published from an earlier commit (e.g. a docs change
  # after the release): the tag stays where the release was cut.
  if [ "$PUBLISHED_NOW" = "false" ]; then
    echo "Tag $TAG is at $EXISTING, where $VERSION was published — leaving it."
    exit 0
  fi
  echo "::error::Tag $TAG points to $EXISTING but this run published from $SHA. Refusing to move it."
  exit 1
fi
if [ "$PUBLISHED_NOW" = "false" ]; then
  # Published earlier but never tagged (e.g. the tag push failed).
  # npm records the commit it was published from as gitHead; tag
  # this commit only if it is that one.
  PUBLISHED_FROM=$(npm view "$NAME@$VERSION" gitHead)
  if [ "$PUBLISHED_FROM" != "$SHA" ]; then
    echo "::warning::$VERSION is on npm, published from ${PUBLISHED_FROM:-an unknown commit}, and has no $TAG tag. Not tagging $SHA; run this workflow with that SHA to tag it."
    exit 0
  fi
  echo "$VERSION was published from $SHA but never tagged — tagging it now."
fi
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git tag -a "$TAG" "$SHA" -m "$VERSION"
git push "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "refs/tags/$TAG"
echo "::notice::Tagged $SHA as $TAG."
