# browser-demo

Narrated demo videos from [agent-browser](https://www.npmjs.com/package/agent-browser) flows.

You write a list of steps — agent-browser commands plus the sentence to say over them — and get back an mp4: each step runs as one `agent-browser batch`, the daemon's viewport stream is captured while it runs, narration is synthesised per step, and the segments are stitched together with the last frame of each held until its narration ends.

agent-browser owns the browser. Point it at local Chrome, a running Chrome over `--cdp`, or a cloud provider (`-p browserbase|kernel|browserless|agentcore`), and record the same way.

## Quick start

```bash
# 1. Get the page to the starting state (explore with `agent-browser snapshot -i`)
npx agent-browser open https://app.example.com/login

# 2. Describe the demo
cat > steps.json <<'JSON'
{
  "steps": [
    { "narrate": "Sign in with the demo account.",
      "commands": [["fill", "#email", "demo@example.com"],
                   ["fill", "#password", "hunter2"],
                   ["find", "text", "Sign in", "click"],
                   ["wait", "--load", "networkidle"]] },
    { "narrate": "The dashboard shows this week's numbers.",
      "commands": [["find", "text", "This week", "click"], ["wait", "500"]] }
  ]
}
JSON

# 3. Record
OPENAI_API_KEY=... npx browser-demo steps.json --out ./demo
#   → ./demo/final.mp4
```

`--silent` renders the same video with a silent audio track sized to the narration, so you can iterate on the steps without any key.

## For agents

The binary documents itself, so an agent can be told "use browser-demo" and work the rest out:

```
browser-demo guide           # the full workflow guide (SKILL.md), version-matched to the binary
browser-demo schema          # JSON Schema for the steps file
browser-demo example         # a starter steps file
browser-demo validate FILE   # check a file without opening a browser
```

`browser-demo --help` opens with those, and a failed step prints hints (wrong selector syntax, re-snapshot here, later steps didn't run). [SKILL.md](SKILL.md) is the same guide for agents reading the repo.

## Steps file

```jsonc
{
  "url": "https://app.example.com", // optional — `open`ed before recording
  "openArgs": ["--headers", "{\"x-vercel-protection-bypass\": \"...\"}"], // optional extra args for `open`
  "speech": {
    // optional — narration; default is openai:gpt-4o-mini-tts, voice "alloy"
    "provider": "elevenlabs",
    "model": "eleven_v3",
    "voice": "JBFqnCBsd6RMkjVDRZzb",
    "instructions": "Warm and unhurried.",
    "providerOptions": { "elevenlabs": { "stability": 0.4 } },
  },
  "steps": [
    {
      "narrate": "What is said over this step.",
      "commands": [
        ["click", "@e3"],
        ["wait", "300"],
      ], // agent-browser argv arrays
      "trailingDelay": 1000, // optional, ms (default 1000)
      "speech": { "voice": "..." }, // optional per-step override (voice, instructions, speed, language)
    },
  ],
}
```

- `commands` are exactly what `agent-browser batch` reads on stdin: one argv array per command. Anything the CLI accepts works — `click`, `fill`, `find text … click`, `press`, `scroll`, `wait --text`, `eval`, …
- Each step is one `batch --bail`. A failing command aborts the demo (the page is then in a state the next narration doesn't describe); the CLI prints which command failed.
- `trailingDelay` is how long to keep capturing after the last command so the final repaint lands in the segment.
- Leave `url` out to record whatever the daemon already has open.

## CLI

```
browser-demo <steps.json>
  -o, --out <dir>            output directory (default: a unique temp dir)
  --tts <provider[:model]>   narration provider (default: openai:gpt-4o-mini-tts)
  --voice <voice>            voice id for the narration provider
  --silent                   silent audio track; no key needed
  --keep                     keep per-segment audio/mp4/frames next to final.mp4
  --session <name>           agent-browser --session to drive
  --agent-browser "<cmd>"    how to invoke agent-browser (default: "npx agent-browser")
  --trailing-delay <ms>      default trailing delay for steps (default 1000)
  --max-fps <n>              cap the stream's frame rate (default: uncapped)
  --ffmpeg <path>            ffmpeg binary (default: ffmpeg-static's)
  --json                     print a result summary as JSON on stdout
```

Without `--json`, the path to `final.mp4` is printed on stdout and progress goes to stderr.

## Narration

Narration goes through the [AI SDK](https://ai-sdk.dev)'s `generateSpeech`, so any AI SDK speech provider works. Five ship with the CLI: **openai** (default), **elevenlabs**, **lmnt**, **hume**, **deepgram**. Each reads its key from its own env var.

| provider   | `--tts`                                                     | key                  | model examples                   |
| ---------- | ----------------------------------------------------------- | -------------------- | -------------------------------- |
| OpenAI     | `openai[:model]` (default `gpt-4o-mini-tts`, voice `alloy`) | `OPENAI_API_KEY`     | `gpt-4o-mini-tts`, `tts-1-hd`    |
| ElevenLabs | `elevenlabs[:model]` (default `eleven_multilingual_v2`)     | `ELEVENLABS_API_KEY` | `eleven_v3`, `eleven_flash_v2_5` |
| LMNT       | `lmnt[:model]` (default `aurora`)                           | `LMNT_API_KEY`       | `aurora`, `blizzard`             |
| Hume       | `hume`                                                      | `HUME_API_KEY`       | (single model)                   |
| Deepgram   | `deepgram[:model]` (default `aura-2`)                       | `DEEPGRAM_API_KEY`   | `aura`, `aura-2`                 |

Where the configuration lives:

- **Voice, instructions, speed, language, provider options** belong in the steps file's `speech` block — they're part of the demo's content, and voice ids are provider-specific so the model goes with them. A step's own `speech` block overrides voice/instructions/speed/language for that step only.
- **Credentials** stay in the environment, using each provider package's convention. The CLI checks for the key up front and fails before opening the browser if it's missing.
- **Flags** are one-off overrides: `--tts elevenlabs:eleven_v3 --voice <id>`, or `--silent`. Precedence is flags → steps file → default.

Any other AI SDK provider resolves the same way: `--tts acme:model` imports `@ai-sdk/acme`, preferring the copy installed in the current project, so `npm i @ai-sdk/acme` (or `npx -p @ai-sdk/acme -p @popoverai/browser-automation browser-demo …`) is all it takes.

## Cloud browsers

The recorder talks only to the local agent-browser daemon, so where the browser runs is the daemon's business:

```bash
# Built-in providers (see `agent-browser --help` for their env vars)
BROWSERBASE_API_KEY=... npx agent-browser --session demo -p browserbase open https://app.example.com
npx browser-demo steps.json --session demo

# Or provision the session yourself and hand agent-browser the CDP URL —
# keeps provider-specific features (contexts, proxies, replay) in the provider's own SDK
npx agent-browser --session demo --cdp "wss://connect.browserbase.com?..." open https://app.example.com
npx browser-demo steps.json --session demo
```

A remote browser adds one round-trip of latency to each frame; segment boundaries skew late by that much, which `trailingDelay` covers.

## Programmatic API

```ts
import { elevenlabs } from "@ai-sdk/elevenlabs";
import {
  AgentBrowserClient,
  attachAgentBrowserDemoRecorder,
} from "@popoverai/browser-automation";

const client = new AgentBrowserClient({ session: "demo" });
await client.run(["open", "https://app.example.com"]);

const demo = await attachAgentBrowserDemoRecorder({ client });
try {
  await demo.step(
    [
      ["find", "text", "Sign in", "click"],
      ["wait", "--load", "networkidle"],
    ],
    "Signing in.",
  );
  const { videoPath } = await demo.render({
    outputDir: "./out",
    speech: { model: elevenlabs.speech("eleven_v3"), voice: "<voiceId>" }, // omit for a silent track
  });
} finally {
  await demo.stop(); // idempotent; safe before, after, or instead of render()
}
```

| Export                                                          | Purpose                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `attachAgentBrowserDemoRecorder(opts)`                          | Enable the daemon's stream, connect, return a recorder.                                                                                                                                                                                                                              |
| `demo.step(commands, narrate, opts?)`                           | Run one batch, record one narrated segment. Throws `DemoStepError` on failure.                                                                                                                                                                                                       |
| `demo.timeline()`                                               | Read the captured `{ entries, frames }` without rendering.                                                                                                                                                                                                                           |
| `demo.render({ speech?, outputDir?, … })`                       | Stop capturing, narrate + encode, return `{ videoPath, outputDir, timeline, frames }`.                                                                                                                                                                                               |
| `demo.stop()`                                                   | Close the stream without rendering.                                                                                                                                                                                                                                                  |
| `AgentBrowserClient`                                            | Thin spawn-based wrapper over the CLI (`run`, `runJson`, `batch`, `ensureStream`).                                                                                                                                                                                                   |
| `renderTimeline({ timeline, frames, speech?, ffmpegPath?, … })` | The render pipeline on its own, for frames captured some other way.                                                                                                                                                                                                                  |
| `SpeechOptions`                                                 | `generateSpeech`'s options minus `text`: `{ model: SpeechModel, voice?, instructions?, speed?, language?, outputFormat?, providerOptions? }`. A hand-rolled `SpeechModelV4` (`{ specificationVersion, provider, modelId, doGenerate }`) works for backends the AI SDK doesn't cover. |
| `loadSpeechModel({ provider, model })`                          | The CLI's `--tts` resolution, for reuse.                                                                                                                                                                                                                                             |

## How it captures

`attachAgentBrowserDemoRecorder` enables `agent-browser stream` — a localhost WebSocket on which the daemon relays CDP `Page.screencastFrame` as JPEG — and stamps each frame on receipt. Step boundaries are stamped from the same clock around each batch, so frames bucket into segments consistently. The stream is change-driven: a static page produces no frames, and the renderer holds the previous frame.

It deliberately does **not** use `agent-browser record`. As of agent-browser 0.36, `record start` opens a fresh browser context in a new tab — cookies and localStorage survive, but the DOM, SPA state, and anything typed do not, so every step would begin with a reload — and `record stop` needs `ffmpeg` on `PATH` and encodes at 10 fps.

Segment length is `max(video, audio)`: the last frame is held until the narration finishes, and an action that outlasts its narration plays to completion over silence.

## Requirements and caveats

- **agent-browser** is resolved with `npx` by default; no global install needed. Its `engines` asks for Node ≥ 24 (it runs on 22 with a warning). Chrome is found automatically or via `agent-browser install` / `open --executable-path`.
- **ffmpeg.** `ffmpeg-static` downloads a binary at install time; pnpm 10 blocks that until you run `pnpm approve-builds`. Otherwise pass `--ffmpeg <path>` or set `FFMPEG_BIN`. Needs libx264 + aac (any standard build).
- **Narration** needs a key for whichever provider you pick (see [Narration](#narration)); `--silent` needs none.
- **Selectors.** `text=…` isn't a selector syntax agent-browser accepts; use `find text <value> click` or refs from `snapshot -i`.

## Environment variables

```
OPENAI_API_KEY=...        # narration with the default provider (not needed with --silent)
ELEVENLABS_API_KEY=...    # or LMNT_API_KEY, HUME_API_KEY, DEEPGRAM_API_KEY, per --tts
FFMPEG_BIN=...            # override the ffmpeg binary
# plus whatever agent-browser needs for your provider:
# BROWSERBASE_API_KEY, KERNEL_API_KEY, BROWSERLESS_API_KEY, AWS_* (agentcore), …
```

## History

This package began as a fork of [@browserbasehq/mcp-server-browserbase](https://github.com/browserbase/mcp-server-browserbase) (Apache 2.0) and for a while carried a Stagehand MCP server alongside the demo recorder. That surface — the MCP tools, Stagehand scripts and scenarios, Browserbase session management, ngrok tunnelling — was removed once agent-browser covered the driving side better; agent-browser ships its own agent skills (`agent-browser skills get core`), so an MCP wrapper wasn't pulling its weight.

## License

Apache 2.0. See [LICENSE](LICENSE).
