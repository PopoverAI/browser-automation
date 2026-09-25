---
name: agentic-demo
description: Record a narrated demo video of a web flow by driving agent-browser. Use when asked for a product walkthrough, feature demo, tutorial video, or "record a video of X happening in the browser". Output is an mp4 with per-step narration.
allowed-tools: Bash(agentic-demo:*), Bash(npx agentic-demo:*), Bash(npx @popoverai/browser-automation:*), Bash(agent-browser:*), Bash(npx agent-browser:*)
---

# agentic-demo

Turns a list of steps — agent-browser commands plus a sentence to say over
each — into an mp4. Each step runs as one `agent-browser batch --bail`, the
browser's viewport is captured while it runs, narration is synthesised per
step, and segments are concatenated with the last frame of each held until
its narration ends.

Steps are scripted, not prompted: the commands run exactly as written and the
narration is the sentence you supply, so nothing decides what to do mid-take.
Working out the right commands (step 1 below) _is_ the job.

The bin is `agentic-demo`, from either `@popoverai/browser-automation` or the
`agentic-demo` package. Without an install: `npx agentic-demo …`. Every command
below is spelled exactly as you can type it.

```bash
agentic-demo guide            # this document
agentic-demo schema           # JSON Schema for the steps file
agentic-demo example          # a starter steps file
agentic-demo validate FILE    # check a steps file without recording
agentic-demo record FILE      # record (also: agentic-demo FILE)
```

## Workflow

1. **Explore first, with agent-browser.** Open the page and find what to
   click. Do not guess selectors.
   ```bash
   agent-browser open https://app.example.com/login
   agent-browser snapshot -i          # interactive elements with @refs
   agent-browser find text "Sign in" click
   agent-browser wait --load networkidle
   agent-browser snapshot -i          # what changed
   ```
2. **Write the steps file** from what worked. Each step is a narration
   sentence plus the commands that make it true. Decide narration up front:
   it sets the segment length, and a step whose narration doesn't match what
   happens on screen is worse than no narration.
3. **Validate**, then **dry-run silently** — no API key, same timing:
   ```bash
   agentic-demo validate steps.json
   agentic-demo record steps.json --silent --out ./demo
   ```
   Scrub `./demo/final.mp4` (or extract frames with ffmpeg) and fix steps.
4. **Record with narration** once the flow is right:
   ```bash
   OPENAI_API_KEY=… agentic-demo record steps.json --out ./demo
   ```
5. Report the path printed on stdout. `--json` adds the video's total length
   (`durationSeconds`) and a per-step summary:
   `captureSeconds` (how long the commands took), `narrationSeconds` (the
   speech), `renderedSeconds` (the segment's length in the video — the larger
   of the two, plus a short tail), and `frameCount`; a step with
   `frameCount: 0` produced no visible change.

## Steps file

```json
{
  "url": "https://app.example.com/login",
  "speech": {
    "provider": "openai",
    "model": "gpt-4o-mini-tts",
    "voice": "alloy"
  },
  "steps": [
    {
      "narrate": "Sign in with the demo account.",
      "commands": [
        ["auth", "login", "demo", "--no-navigate"],
        ["wait", "--load", "networkidle"]
      ]
    },
    {
      "narrate": "The dashboard opens on this week's numbers.",
      "commands": [
        ["find", "text", "This week", "click"],
        ["wait", "500"]
      ],
      "trailingDelay": 1500
    }
  ]
}
```

- `commands` are **argv arrays**, exactly what `agent-browser batch` reads:
  one array per command, one string per argument. Anything the CLI accepts
  works (`agent-browser --help`, `agent-browser skills get core`).
- `url` is optional: omit it to record whatever the daemon already has open
  (useful after logging in by hand, or on a cloud browser). `openArgs` adds
  flags to `open` (`--headers`, `--executable-path`, …).
- `trailingDelay` (ms, default 1000) keeps capturing after the last command
  so the final repaint lands in the segment. Raise it for slow transitions.
- A per-step `speech` block overrides `voice`, `instructions`, `speed`,
  `language` for that step only.
- Full schema: `agentic-demo schema`.

## Commands that work well in steps

```
["find", "text", "Sign in", "click"]      click by visible text
["click", "@e12"]                         click by ref from `snapshot -i` (refs are per-snapshot; re-snapshot before relying on one)
["click", "#id"] / ["click", "button.primary"]   CSS selectors
["fill", "#email", "demo@example.com"]    clear + type
["press", "Enter"]
["scroll", "down", "600"]
["wait", "500"]                           milliseconds — add these so viewers can see the result
["wait", "--text", "Welcome"]             wait for text to appear
["wait", "--load", "networkidle"]
["wait", "--url", "**/dashboard"]
["eval", "document.title"]
```

Do **not** use `text=…` as a selector — agent-browser does not accept that
syntax; use `find text <value> click`. Do not put `tab new`, `tab close`,
`connect`, or `close` in steps: they change which tab or context is being
captured. Leave out `record` too: agentic-demo is already capturing.

## Signing in

Never put a password in a step. The steps file is kept and re-recorded
from, so a `fill` with a password leaves it in plain text. Use
agent-browser's encrypted credential store instead:

```bash
echo "$PASSWORD" | agent-browser auth save demo --url https://app.example.com/login \
  --username demo@example.com --password-stdin
```

then sign in inside a step with `["auth", "login", "demo", "--no-navigate"]`
(`--no-navigate` keeps the page the file's `url` opened, and fails the step
unless that page's origin matches the `--url` saved with the credential; for
a login hosted elsewhere, such as an identity provider, drop `--no-navigate`).
If the demo isn't about signing in, sign in before recording and leave `url`
out, so the recording starts on the signed-in page. Use a demo account: the video shows
whatever is on screen.

## Narration

The narration provider comes from the AI SDK. Bundled: `openai` (default,
`gpt-4o-mini-tts`, voice `alloy`), `elevenlabs`, `hume`, `deepgram`, and
`gateway` (Vercel AI Gateway, default `openai/tts-1-hd`).
Keys are read from `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `HUME_API_KEY`,
`DEEPGRAM_API_KEY`, `AI_GATEWAY_API_KEY` (or `VERCEL_OIDC_TOKEN` for the
gateway). The CLI checks the key before opening the
browser and tells you which variable is missing.

- Put `provider`, `model`, `voice`, `instructions` in the steps file's
  `speech` block — they're part of the demo.
- `--tts elevenlabs:eleven_v3 --voice <id>` overrides for one run.
- Gateway model ids name the provider: `--tts gateway:openai/tts-1`.
- `--silent` renders without any key; segment lengths are estimated from the
  narration text, so timing matches a narrated render.
- Any other AI SDK provider: `--tts acme:model` loads `@ai-sdk/acme` from the
  current project if installed.
- **A voice endpoint** instead of a provider: `--tts https://…`, or
  `"endpoint": "https://…"` in the `speech` block. The CLI sends the
  endpoint `AGENTIC_DEMO_TTS_TOKEN` as its credential and needs no provider
  key. It narrates step 1 before opening the browser, so a refusal arrives
  before any recording.

## Cloud browsers

The daemon owns the browser. Start it against a provider, then record with
the same `--session`:

```bash
BROWSERBASE_API_KEY=… agent-browser --session demo -p browserbase open https://app.example.com
agentic-demo record steps.json --session demo
```

Or hand agent-browser a CDP URL you provisioned yourself:
`agent-browser --session demo --cdp "wss://…" open …`.

## Reading failures

- **`demo step failed at \`click #x\`: Element not found`** — the batch
  stopped there and the page is now off-script. Re-run
  `agent-browser snapshot -i`, fix the step, and re-record. The CLI prints
  which commands in the step ran.
- **`<VAR> is not set (needed for --tts …)`** — export the key, pick another
  provider, or `--silent`.
- **`the voice endpoint … refused to narrate (HTTP <status>):`** — the lines
  after it are the endpoint's own message, such as a used-up quota with an
  upgrade link. Show them to the user word for word; don't retry, and don't
  switch to another voice source or `--silent` unless the user asks.
- **`could not load @ai-sdk/<name>`** — install it in the project.
- **`ffmpeg-static binary not found`** — run `pnpm approve-builds` (pnpm 10
  blocks postinstall downloads) or pass `--ffmpeg <path>`.
- **`stream socket … did not open`** — the agent-browser daemon isn't running
  or has no page; `agent-browser open <url>` first.
- **Nothing visible in a segment** (`frameCount: 0` in `--json`) — the step
  changed nothing on screen; the renderer holds the previous frame. Usually
  the narration belongs on the previous or next step.

## Requirements

agent-browser (via `npx`, no install needed; Node ≥ 24 preferred), an
ffmpeg with libx264 + aac (bundled via ffmpeg-static), and a narration key
unless `--silent`.
