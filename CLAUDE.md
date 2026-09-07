# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

`@popoverai/browser-automation` is an MCP server for AI browser automation — a
fork of `@browserbasehq/mcp-server-browserbase` with LOCAL mode as the default,
Playwright federation, and Vercel header injection. It ships to npm, as a
Claude Desktop extension (`.mcpb`), and as a container.

Single package, no workspace. TypeScript, ESM, Node 22 (the Dockerfile builds
on `node:22-alpine` and runs on `distroless/nodejs22-debian12`).

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

- `src/tools/` — one file per MCP tool (`act`, `agent`, `extract`, `observe`,
  `navigate`, `screenshot`, `scenario`, `runScript`, `demoVideo`, …), registered
  through `src/tools/index.ts`
- `src/mcp/` — MCP protocol surface (server plumbing, resources)
- `src/demo/` — the narrated demo-video pipeline (CDP screencast → TTS → ffmpeg)
- `src/sessionManager.ts` — Stagehand session lifecycle; LOCAL and Browserbase
- `src/playwrightFederation.ts`, `src/cdpProxy.ts`, `src/ngrokManager.ts` —
  connection plumbing
- `tests/` — vitest, one file per subject, mocking external binaries and APIs
- `evals/` — MCP eval configs, run separately from the test suite

## Development Commands

```bash
pnpm install          # also builds, via the `prepare` script
pnpm build            # tsc && chmod +x dist/*.js
pnpm test             # vitest run
pnpm lint             # eslint . --ext .ts   (see "Known red" below)
pnpm format           # prettier --write .
pnpm evals            # MCP evals — slow, hits real models
```

**Known red:** `pnpm lint` fails on `main` with 4 pre-existing errors (an unused
import in `src/sessionManager.ts`; three `no-explicit-any` hits in
`src/sessionManager.ts` and `src/tools/navigate.ts`, all on untyped third-party
internals). CI deliberately does not run lint until those are fixed — see the
comment at the foot of `.github/workflows/test.yml`. Don't add new ones.

## Releases

Versioning and publishing go through **changesets**: `pnpm changeset` to record
a change, `pnpm version:packages` to apply, `pnpm release` to publish. There is
no `production` branch — `main` is the trunk.

## CI

- **`test.yml`** — typecheck + vitest on every PR.
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
both commented in the workflow: this repo is public, so the decide step gates
review on the PR author being OWNER/MEMBER/COLLABORATOR; and the Fable/release
branch is inert here, since there is no `production` branch.

Iterate on review *judgment* in `.claude/skills/ci-review-pr/SKILL.md`, not in
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
