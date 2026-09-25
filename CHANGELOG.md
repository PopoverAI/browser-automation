# Changelog

`@popoverai/browser-automation` — the `agentic-demo` CLI and library.

A merged version bump publishes itself from CI (see CLAUDE.md → Releases).
This package is 0.x: a minor bump is a breaking change.

## 0.15.1 — 2026-09-23

Changed

- **`agentic-demo example` signs in without a password in the file.** The
  starter steps file, and the guide's example, used to `fill` a password
  field, which left the password in plain text in a file people keep and
  re-record from. Both now sign in with agent-browser's encrypted
  credential store: save it once with `agent-browser auth save`, then use
  `["auth", "login", "demo", "--no-navigate"]` in a step. `agentic-demo
  guide` gains a "Signing in" section.
- **One README for both npm pages**, rewritten for the person asking
  "what is this for and how do I use it", with a reference section below.
  The `agentic-demo` package now copies it in when packed, so the two pages
  cannot drift.
- `package.json` declares `engines.node >=22`, the floor `ai@7` already
  set, and shares its description and keywords with `agentic-demo`.

## 0.15.0 — 2026-09-21

**Breaking.** The CLI's bin is now `agentic-demo`; `browser-demo` is gone.

Changed

- **The bin is `agentic-demo`, not `browser-demo`.** `browser-demo` was a name
  only an installed user could type: it is not a package on npm, so the `npx`
  route could never reach it, while `SKILL.md` — the guide an agent reads
  before its first command — spelled every example that way. There is one name
  now, and it is the same one everywhere: the bin of
  `@popoverai/browser-automation`, the `agentic-demo` package on npm, the
  guide, `--help`, and the error messages.

  Breaking for anyone who installed the package and calls `browser-demo`; the
  command is `agentic-demo`. The old name is not kept as a second bin, because
  a package with two bins cannot be run as `npx @popoverai/browser-automation
…` at all — npx picks a bin unprompted only when there is exactly one
  (verified: two bins gives `could not determine executable to run`).

- Docs lead with `npx agentic-demo …`, with
  `npx @popoverai/browser-automation …` beside it as the same CLI under the
  full package name. The old `npx -p @popoverai/browser-automation
browser-demo …` form was never needed: npx runs a package's only bin whatever
  it is called. The `-p` spelling remains where a second package really is
  being added to the npx sandbox (`npx -p @ai-sdk/acme -p
@popoverai/browser-automation …`).

- README and SKILL.md say outright that steps are scripted, not prompted — the
  commands run as written and nothing chooses actions at record time. An agent
  writes the steps file; it does not drive the browser during a take.

Added

- **`agentic-demo`** (`alias/agentic-demo/`): a separately published package
  that is nothing but the name, so `npx agentic-demo …` works the way
  `npx agent-browser …` does. Its bin resolves `@popoverai/browser-automation`
  and imports the same `dist/cli.js` — one implementation, one guide, no
  drift. Publish it after the main package; it depends on the version being
  released.

Removed

- The **LMNT** narration provider and its `@ai-sdk/lmnt` dependency. LMNT has
  shut down; the package is deprecated upstream and no longer works, and npm
  printed that deprecation notice on every install and every `npx` run of the
  CLI. `--tts lmnt` (or `"provider": "lmnt"` in a steps file) now fails up
  front with `LMNT has shut down…  Use one of openai, elevenlabs, hume,
deepgram, or pass --silent.`

  It gets its own message rather than falling through to the generic
  `could not load @ai-sdk/<name>, install it` path, because that path's
  advice would make things worse: the package is deprecated, not
  unpublished, so `npm i @ai-sdk/lmnt` succeeds and still exports a speech
  factory. The startup check would then pass and the failure would move to
  the first `generateSpeech` call — after the capture is already recorded.

## 0.14.0 — 2026-09-08

**Breaking.** The package is now `browser-demo`: narrated demo videos from
agent-browser flows. Everything else is gone.

Removed

- The MCP server and every `stagehand_*` tool (`act`, `extract`, `observe`,
  `navigate`, `screenshot`, `agent`, `session`, `run_script`, `scenario`,
  `demo_video`) and the `agent_browser_*` tools that rode on its session.
- Stagehand scripts and scenarios (`defineScript`, `runScenario`), the
  `./script` and `./scenario` subpath exports, `%var%` substitution.
- Browserbase session management, the CDP proxy, Playwright federation, ngrok
  tunnelling, Vercel header injection (use agent-browser's `--headers`).
- The Claude Desktop extension, Smithery/Gemini manifests, `server.json`,
  Dockerfile, evals, the `browser-automation` bin.
- Dependencies: `@browserbasehq/sdk`, `@browserbasehq/stagehand`,
  `@modelcontextprotocol/sdk`, `@mcp-ui/server`, `@ngrok/ngrok`, `sharp`,
  `dotenv`, `tsx`, `@changesets/cli`.

Added

- `browser-demo` CLI: `record` (default), `validate`, `guide`, `schema`,
  `example`. A steps file — agent-browser commands as argv arrays plus a
  narration sentence per step — in; an mp4 out. Self-documenting for agents:
  `--help` opens with a "Start here" block, `guide` prints the shipped
  `SKILL.md`, `schema` prints a JSON Schema generated from the validator, a
  failed step prints actionable hints.
- Library: `attachAgentBrowserDemoRecorder`, `AgentBrowserClient`,
  `renderTimeline`, `resolveSpeech`, `loadSpeechModel`, the steps-file schema.
- Capture via agent-browser's viewport `stream` (not `record`, which reloads
  the page into a fresh tab, needs ffmpeg on `PATH`, and captures at 10 fps).
  Works against local Chrome, `--cdp <wsUrl>`, or any `agent-browser
--provider`.
- Narration through the AI SDK 7 `generateSpeech` seam: `renderTimeline({
speech?: SpeechOptions })` takes any AI SDK speech model; omit it for a
  silent track sized to the narration. Bundled providers: openai (default),
  elevenlabs, lmnt, hume, deepgram, via `--tts <provider[:model]>`. Steps files
  carry a `speech` block and per-step overrides.

Fixed

- Narrated renders came out with **no audio stream at all** on ffmpeg-static's
  6.0 build (macOS): `-shortest` made that build write zero audio packets and
  drop the AAC stream, with exit 0; the 7.0.2 build (Linux) instead let the
  padded audio overrun the video. Segments are now encoded in two passes —
  video alone, measured, then narration padded to exactly that length — with
  no `-shortest` involved. Found by the first real narrated run before
  publishing; the unit tests stub ffmpeg, so a real-ffmpeg integration test
  now runs wherever a binary is present.
- Rendered segments no longer end 1–2 s before their narration: `-t <audio
duration>` made ffmpeg 6 drop the held last frame. Segment length is now
  max(video, audio) — the last frame is held to the narration's end, audio is
  padded past a longer action.
- Renderer frame-gap floor lowered from 100 ms to 20 ms so a 30 fps capture is
  no longer played back at one-third speed.

## 0.13.x and earlier

Releases of the MCP server this package used to be — a fork of
[@browserbasehq/mcp-server-browserbase](https://github.com/browserbase/mcp-server-browserbase)
with LOCAL mode as the default, Playwright federation, Vercel header injection,
Stagehand scripts/scenarios, and (from 0.13.11) the first narrated demo-video
pipeline over Stagehand. The upstream project's changelog covers the code this
fork started from.
