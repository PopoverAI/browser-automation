# Changelog

`@popoverai/browser-automation` — the `browser-demo` CLI and library.

Versions are cut by hand with `npm version` / `npm publish` (see
CLAUDE.md → Releases). This package is 0.x: a minor bump is a breaking change.

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
