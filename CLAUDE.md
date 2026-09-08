# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

`@popoverai/browser-automation` ships the `browser-demo` CLI and library:
narrated demo videos from [agent-browser](https://www.npmjs.com/package/agent-browser)
flows. A steps file (agent-browser commands plus a narration sentence per step)
goes in; an mp4 comes out. agent-browser owns the browser (local Chrome,
`--cdp`, or a cloud provider); the AI SDK owns narration; ffmpeg stitches.

It began as a fork of `@browserbasehq/mcp-server-browserbase` and carried a
Stagehand MCP server until agent-browser proved the better agentic interface;
that surface was removed (see README "History"). There is no MCP server, no
Stagehand, no Browserbase session management, no Docker image.

Single package, no workspace. TypeScript, ESM, Node 22+ (`ai@7` sets the
floor; agent-browser itself prefers 24 but runs on 22).

## What's worth doing

We are a pre-revenue startup. Work earns its place by changing something for a
person using the product, or by unblocking work that does.

The common miss is insurance against futures nobody has chosen — portability
away from a platform we have no plan to leave, resilience at a scale we have not
reached, an abstraction over a second implementation that does not exist. The
cost lands now; the benefit waits on a decision no one has made. A working
system coupled to its platform is not a problem.

Before proposing work — a fix, a refactor, a ticket, a review finding — name who
is affected today, at our scale, on the stack we run. If you can't, report it as
an observation rather than a problem.

## Layout

- `src/cli.ts` — the `browser-demo` binary: `record` (default), `validate`,
  `guide`, `schema`, `example`
- `src/stepsFile.ts` — the steps-file schema (zod/v4), its JSON Schema, and
  the starter example; the single source of truth for the input format
- `src/agentBrowserClient.ts` — spawn-based wrapper over the agent-browser CLI
  (`batch` via stdin JSON, `stream status/enable/disable`)
- `src/agentBrowserRecorder.ts` — captures the daemon's viewport stream, runs
  each step as one `agent-browser batch --bail`, builds the timeline
- `src/render.ts` — per-segment narration + ffmpeg encode, concat; segment
  length is max(video, audio)
- `src/speech.ts` — narration through the AI SDK's `generateSpeech`, or a
  pure-JS silent WAV when no `speech` is configured
- `src/speechProviders.ts` — CLI-side `--tts <provider[:model]>` resolution;
  openai, elevenlabs, lmnt, hume, deepgram are bundled
- `src/timeline.ts` — `CapturedFrame` / `TimelineEntry` shared types
- `SKILL.md` — the agent-facing guide, printed by `browser-demo guide`;
  shipped in the package so it always matches the binary
- `tests/` — vitest, one file per subject; ffmpeg and agent-browser are
  stubbed (an exec seam and a fake stream WebSocket server), speech models
  are `MockSpeechModelV4` from `ai/test`

## Development Commands

```bash
pnpm install          # also builds, via the `prepare` script
pnpm build            # tsc && chmod +x dist/cli.js
pnpm test             # vitest run
pnpm typecheck        # tsc --noEmit over src/ AND tests/ (see below)
pnpm lint             # eslint . --ext .ts
pnpm format           # prettier --write .
```

**Typechecking:** run `pnpm typecheck`, not a bare `tsc --noEmit`. The build's
`tsconfig.json` is scoped to `src/` (it sets `rootDir` there and emits
declarations), and vitest transpiles tests without typechecking them — so a
bare `tsc --noEmit` checks no test file at all. `tsconfig.typecheck.json`
widens the net to `src/` + `tests/` without changing what `pnpm build` emits.

**Trying it for real:** `node dist/cli.js example > steps.json`, edit the
`url`/commands for a page you can reach, then
`node dist/cli.js steps.json --silent --out ./demo`. `--silent` needs no API
key. `ffmpeg-static`'s postinstall download is blocked by pnpm 10 until
`pnpm approve-builds`; `--ffmpeg <path>` or `FFMPEG_BIN` points at another
binary.

## Conventions

- The renderer takes an AI SDK `SpeechModel`; it never imports a provider
  package. Provider resolution is a CLI concern (`speechProviders.ts`).
- Don't use `agent-browser record` for capture: it opens a fresh context in a
  new tab (page state is lost between steps), needs ffmpeg on PATH, and
  captures at 10 fps. The stream is the right surface.
- Anything an agent needs to use the CLI belongs in `SKILL.md` or the zod
  descriptions in `stepsFile.ts`, not only in the README — `browser-demo
guide` / `schema` are how a CLI-only agent learns the tool.

## Releases

Publishing is manual, from a checkout of `main`, with npm's own tooling — the
way every 0.13.x release was cut:

```bash
npm version <patch|minor>   # bumps package.json, commits "x.y.z", tags vx.y.z
npm publish                 # prepublishOnly rebuilds; ships README.md, SKILL.md, dist
git push --follow-tags
```

The package is 0.x, so **breaking changes bump the minor** (SemVer item 4;
`^0.13.x` ranges exclude 0.14.0). 1.0.0 would declare the API stable, which it
is not. Add a `CHANGELOG.md` entry under the new version in the same commit as
the bump — the changelog is the release note; there is no other.

There is no `production` branch — `main` is the trunk — and no changesets: the
scaffolding inherited from the upstream fork was never initialised and has been
removed. (`pr-review.yml` still mentions changesets in a comment on a branch
that is inert here; it is kept verbatim for diffability with dotrequirements.)

## CI

- **`test.yml`** — typecheck, vitest, and lint on every PR.
- **`pr-review.yml`** — the formal Claude review (below).
- **`claude.yml`** — the `@claude` mention trigger, gated to repo collaborators.

## PR Reviews

Every PR gets a formal `claude[bot]` review from CI on each push
(`pr-review.yml` + the `ci-review-pr` skill). An APPROVE ends the loop: later
pushes are not reviewed. If you push a substantive change to an already-approved
PR, include `[re-review]` in a commit subject (the message's first line) — that
buys one fresh round on the changes since the approved commit, and its verdict
then governs as usual. The subject only: mentioning the tag in a commit body
does not trigger a round.

The review path is ported from `PopoverAI/dotrequirements`, whose
`docs/working/ci-pr-review.md` is the design write-up. Both copies are kept as
close as possible so a fix in either ports by diff. Two deliberate divergences,
both commented in the workflow: this repo is public, so the decide step only
reviews PRs whose head branch lives in this repository (pushing one already
requires write access), falling back to an OWNER/MEMBER/COLLABORATOR check for
a collaborator working from a fork; and the Fable/release branch is inert here,
since there is no `production` branch.

Don't narrow that gate to `author_association` alone — it isn't dependable.
PR #8 reported `CONTRIBUTOR` for an org member whose comment on PR #6 reported
`MEMBER`, and an assoc-only gate skipped a maintainer's own PR while reporting
green.

Iterate on review _judgment_ in `.claude/skills/ci-review-pr/SKILL.md`, not in
the workflow: `claude-code-action` skips any run whose workflow file differs
from `main`, so edits to `pr-review.yml` land unexercised and are only proven by
the next PR.

### Agent-authored PRs

Branches starting with `claude/` are authored in Claude Code sessions rather
than typed by hand. (Unlike dotrequirements, this repo has no Linear
`repository_dispatch` workflow — the branches come from interactive and remote
sessions.) They still go through a human before merging, so review them
normally; just don't flag the absence of process artifacts this repo has never
kept, such as working-design documents.
