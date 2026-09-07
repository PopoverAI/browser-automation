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

`--silent` renders the same video with a silent audio track sized to the narration, so you can iterate on the steps without an OpenAI key.

## Steps file

```jsonc
{
  "url": "https://app.example.com", // optional — `open`ed before recording
  "openArgs": ["--headers", "{\"x-vercel-protection-bypass\": \"...\"}"], // optional extra args for `open`
  "steps": [
    {
      "narrate": "What is said over this step.",
      "commands": [
        ["click", "@e3"],
        ["wait", "300"],
      ], // agent-browser argv arrays
      "trailingDelay": 1000, // optional, ms (default 1000)
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
  --silent                   silent audio track instead of OpenAI TTS
  --voice <voice>            OpenAI TTS voice (default: alloy)
  --keep                     keep per-segment audio/mp4/frames next to final.mp4
  --session <name>           agent-browser --session to drive
  --agent-browser "<cmd>"    how to invoke agent-browser (default: "npx agent-browser")
  --trailing-delay <ms>      default trailing delay for steps (default 1000)
  --max-fps <n>              cap the stream's frame rate (default: uncapped)
  --ffmpeg <path>            ffmpeg binary (default: ffmpeg-static's)
  --json                     print a result summary as JSON on stdout
```

Without `--json`, the path to `final.mp4` is printed on stdout and progress goes to stderr.

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
  const { videoPath } = await demo.render({ outputDir: "./out" });
} finally {
  await demo.stop(); // idempotent; safe before, after, or instead of render()
}
```

| Export                                                       | Purpose                                                                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `attachAgentBrowserDemoRecorder(opts)`                       | Enable the daemon's stream, connect, return a recorder.                                |
| `demo.step(commands, narrate, opts?)`                        | Run one batch, record one narrated segment. Throws `DemoStepError` on failure.         |
| `demo.timeline()`                                            | Read the captured `{ entries, frames }` without rendering.                             |
| `demo.render(opts?)`                                         | Stop capturing, run TTS + ffmpeg, return `{ videoPath, outputDir, timeline, frames }`. |
| `demo.stop()`                                                | Close the stream without rendering.                                                    |
| `AgentBrowserClient`                                         | Thin spawn-based wrapper over the CLI (`run`, `runJson`, `batch`, `ensureStream`).     |
| `renderTimeline({ timeline, frames, tts?, ffmpegPath?, … })` | The render pipeline on its own, for frames captured some other way.                    |
| `createOpenAITTS()` / `createSilentTTS()`                    | TTS providers; anything with `speak(text, voice)` works.                               |

## How it captures

`attachAgentBrowserDemoRecorder` enables `agent-browser stream` — a localhost WebSocket on which the daemon relays CDP `Page.screencastFrame` as JPEG — and stamps each frame on receipt. Step boundaries are stamped from the same clock around each batch, so frames bucket into segments consistently. The stream is change-driven: a static page produces no frames, and the renderer holds the previous frame.

It deliberately does **not** use `agent-browser record`. As of agent-browser 0.36, `record start` opens a fresh browser context in a new tab — cookies and localStorage survive, but the DOM, SPA state, and anything typed do not, so every step would begin with a reload — and `record stop` needs `ffmpeg` on `PATH` and encodes at 10 fps.

Segment length is `max(video, audio)`: the last frame is held until the narration finishes, and an action that outlasts its narration plays to completion over silence.

## Requirements and caveats

- **agent-browser** is resolved with `npx` by default; no global install needed. Its `engines` asks for Node ≥ 24 (it runs on 22 with a warning). Chrome is found automatically or via `agent-browser install` / `open --executable-path`.
- **ffmpeg.** `ffmpeg-static` downloads a binary at install time; pnpm 10 blocks that until you run `pnpm approve-builds`. Otherwise pass `--ffmpeg <path>` or set `FFMPEG_BIN`. Needs libx264 + aac (any standard build).
- **Narration** uses OpenAI `gpt-4o-mini-tts` via `OPENAI_API_KEY`; `--silent` needs no key.
- **Selectors.** `text=…` isn't a selector syntax agent-browser accepts; use `find text <value> click` or refs from `snapshot -i`.

## Environment variables

```
OPENAI_API_KEY=...        # narration (not needed with --silent)
FFMPEG_BIN=...            # override the ffmpeg binary
# plus whatever agent-browser needs for your provider:
# BROWSERBASE_API_KEY, KERNEL_API_KEY, BROWSERLESS_API_KEY, AWS_* (agentcore), …
```

## History

This package began as a fork of [@browserbasehq/mcp-server-browserbase](https://github.com/browserbase/mcp-server-browserbase) (Apache 2.0) and for a while carried a Stagehand MCP server alongside the demo recorder. That surface — the MCP tools, Stagehand scripts and scenarios, Browserbase session management, ngrok tunnelling — was removed once agent-browser covered the driving side better; agent-browser ships its own agent skills (`agent-browser skills get core`), so an MCP wrapper wasn't pulling its weight.

## License

Apache 2.0. See [LICENSE](LICENSE).
