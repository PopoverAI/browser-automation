# agentic-demo

Narrated demo videos of your web app, recorded by your coding agent.

Ask Claude Code, Codex, Cursor, or any agent that can run shell commands for a walkthrough of a flow. It explores the app with [agent-browser](https://www.npmjs.com/package/agent-browser), writes a short script (the browser commands for each step and a sentence to say over it), and agentic-demo records the script as an mp4 with a voiceover. No screen recorder, no microphone, no editing.

The script stays behind as a file. Nothing improvises during the take, so the same script gives the same video, and when the app changes you re-record with one command instead of redoing the demo. If a step no longer works, the CLI names the command that failed.

## Installation

### Global Installation (recommended)

```bash
npm install -g agentic-demo
```

If you don't have agent-browser yet:

```bash
npm install -g agent-browser
agent-browser install  # Download Chrome (first time only)
```

### Project Installation (local dependency)

For projects that want to pin the version, or use the [library](#library):

```bash
npm install -D @popoverai/browser-automation
```

`agentic-demo` is the short name for `@popoverai/browser-automation`. Both install the same `agentic-demo` command; only `@popoverai/browser-automation` carries the library.

### Without Installing

```bash
npx agentic-demo --help
```

### Updating

```bash
npm install -g agentic-demo@latest
```

Versions are 0.x, so a minor version can break things. The [changelog](https://github.com/PopoverAI/browser-automation/blob/main/CHANGELOG.md) lists every change.

### Requirements

- **Node.js 22+**
- **agent-browser** - Run as `npx agent-browser`, which uses your installed copy if there is one; `--agent-browser "<cmd>"` runs something else. agent-browser prefers Node.js 24+ and runs on 22 with a warning.
- **ffmpeg** - Bundled through `ffmpeg-static`, which downloads a binary at install time. pnpm 10 blocks that download until you run `pnpm approve-builds`. Otherwise pass `--ffmpeg <path>` or set `FFMPEG_BIN`; any build with libx264 and aac works.
- **A narration key** - `OPENAI_API_KEY` by default (see [Narration](#narration)). Not needed with `--silent`.

## Quick Start

Paste this into Claude Code, or any coding agent:

```
Use `agentic-demo` to create a demo of this feature. Start from `npx agentic-demo --help`.
```

The agent does the rest. It will tell you if it needs anything from you, such as an OpenAI API key for the voiceover. You get a video file, plus the script it was made from, so you can ask for a fresh recording whenever the feature changes.

### By Hand

This is what the agent does, and what you run to adjust a script yourself:

```bash
# 1. Find the flow with agent-browser
agent-browser open https://app.example.com/login
agent-browser snapshot -i                # Interactive elements with refs

# 2. Write it as steps: agent-browser commands, and the sentence to say over each
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

# 3. Check it, rehearse it without a key, then record
agentic-demo validate steps.json
agentic-demo steps.json --silent --out ./demo
OPENAI_API_KEY=... agentic-demo steps.json --out ./demo   # → ./demo/final.mp4
```

## Commands

```bash
agentic-demo <steps.json>            # Record to an mp4 (same as `record <steps.json>`)
agentic-demo validate <steps.json>   # Check a steps file without opening a browser
agentic-demo guide                   # Print the workflow guide for agents
agentic-demo schema                  # Print the steps file's JSON Schema
agentic-demo example                 # Print a starter steps file
```

## Steps File

```jsonc
{
  "url": "https://app.example.com", // Optional: opened before recording; omit to record the current page
  "openArgs": ["--headers", "{\"x-vercel-protection-bypass\": \"...\"}"], // Optional: extra args for `open`
  "speech": {
    // Optional: narration (default: OpenAI gpt-4o-mini-tts, voice "alloy")
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
      "trailingDelay": 1000, // Optional: ms to keep capturing after the last command (default 1000)
      "speech": { "voice": "..." }, // Optional: this step's voice, instructions, speed, language
    },
  ],
}
```

- `commands` are what `agent-browser batch` reads on stdin: one argv array per command. Anything agent-browser accepts works (`click`, `fill`, `find text … click`, `press`, `scroll`, `wait --text`, `eval`, …).
- Each step runs as one `batch --bail`. If a command fails, recording stops and the CLI prints which command it was.
- `text=…` is not a selector agent-browser accepts. Use `find text <value> click`, or refs from `snapshot -i`.
- Unknown keys are errors, so a misspelt key fails `validate` rather than being ignored.

## Options

| Option                     | Description                                                     |
| -------------------------- | --------------------------------------------------------------- |
| `-o, --out <dir>`          | Output directory (default: a new temporary directory)           |
| `--tts <provider[:model]>` | Narration provider and model (default: `openai:gpt-4o-mini-tts`) |
| `--voice <voice>`          | Voice id for the narration provider                             |
| `--silent`                 | Silent audio track sized to the narration; no key needed        |
| `--keep`                   | Keep each segment's audio, video and frames next to `final.mp4` |
| `--session <name>`         | agent-browser session to drive                                  |
| `--agent-browser "<cmd>"`  | How to run agent-browser (default: `npx agent-browser`)         |
| `--trailing-delay <ms>`    | Default `trailingDelay` for every step (default: 1000)          |
| `--max-fps <n>`            | Cap the capture frame rate (default: uncapped)                  |
| `--ffmpeg <path>`          | ffmpeg binary (default: ffmpeg-static's, or `FFMPEG_BIN`)       |
| `--json`                   | Print a per-step summary as JSON on stdout                      |

Without `--json`, stdout is the path to `final.mp4` and progress goes to stderr.

## Narration

Narration goes through the [AI SDK](https://ai-sdk.dev)'s `generateSpeech`. Four providers ship with the CLI, and each reads its key from its own environment variable:

| Provider   | `--tts`                                                     | Key                  | Models                           |
| ---------- | ----------------------------------------------------------- | -------------------- | -------------------------------- |
| OpenAI     | `openai[:model]` (default `gpt-4o-mini-tts`, voice `alloy`) | `OPENAI_API_KEY`     | `gpt-4o-mini-tts`, `tts-1-hd`    |
| ElevenLabs | `elevenlabs[:model]` (default `eleven_multilingual_v2`)     | `ELEVENLABS_API_KEY` | `eleven_v3`, `eleven_flash_v2_5` |
| Hume       | `hume`                                                      | `HUME_API_KEY`       | (single model)                   |
| Deepgram   | `deepgram[:model]` (default `aura-2`)                       | `DEEPGRAM_API_KEY`   | `aura`, `aura-2`                 |

- Voice, instructions, speed, language and provider options go in the steps file's `speech` block. Voice ids are provider-specific, so they belong with the demo.
- Flags override the file for one run: `--tts elevenlabs:eleven_v3 --voice <id>`, or `--silent`. Precedence is flags, then the steps file, then the default.
- The CLI checks for the key before it opens the browser.
- Any other AI SDK provider works the same way: `--tts acme:model` loads `@ai-sdk/acme` from your project, so `npm install @ai-sdk/acme` (or `npx -p @ai-sdk/acme -p @popoverai/browser-automation agentic-demo …`) is all it takes.

## Cloud Browsers

agent-browser owns the browser, so start it wherever you like and record against the same session:

```bash
# A built-in provider: browserbase, kernel, browserless, browseruse, agentcore
BROWSERBASE_API_KEY=... agent-browser --session demo -p browserbase open https://app.example.com
agentic-demo steps.json --session demo

# Or a browser you provisioned yourself, over CDP
agent-browser --session demo --cdp "wss://connect.browserbase.com?..." open https://app.example.com
agentic-demo steps.json --session demo
```

Each provider's settings are in [agent-browser's docs](https://github.com/vercel-labs/agent-browser#integrations). A remote browser delays each frame by one round trip, which `trailingDelay` covers.

## Library

`@popoverai/browser-automation` exports the recorder for use from code:

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

| Export                                                          | Purpose                                                                                                  |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `attachAgentBrowserDemoRecorder(opts)`                          | Enable the daemon's stream, connect, return a recorder                                                   |
| `demo.step(commands, narrate, opts?)`                           | Run one batch and record one narrated segment; throws `DemoStepError` on failure                         |
| `demo.timeline()`                                               | Read the captured `{ entries, frames }` without rendering                                                |
| `demo.render({ speech?, outputDir?, … })`                       | Stop capturing, narrate and encode; returns `{ videoPath, outputDir, timeline, frames }`                 |
| `demo.stop()`                                                   | Close the stream without rendering                                                                       |
| `AgentBrowserClient`                                            | Thin spawn-based wrapper over the CLI (`run`, `runJson`, `batch`, `ensureStream`)                        |
| `renderTimeline({ timeline, frames, speech?, ffmpegPath?, … })` | The render pipeline on its own, for frames captured some other way                                       |
| `SpeechOptions`                                                 | `generateSpeech`'s options minus `text`; any AI SDK `SpeechModel`, or a hand-rolled `SpeechModelV4`      |
| `loadSpeechModel({ provider, model })`                          | The CLI's `--tts` resolution, for reuse                                                                  |

## How It Works

Each step runs as one `agent-browser batch --bail` while agentic-demo reads the daemon's viewport stream, stamping each frame and each step boundary on one clock. Narration is synthesised per step. Each segment lasts as long as the longer of its video and its narration: the last frame holds until the narration ends, and an action that outlasts its narration plays out over silence. ffmpeg joins the segments into `final.mp4`.

The stream only sends frames when the page changes. A step that changes nothing on screen shows `frameCount: 0` in `--json`, and the video holds the previous frame.

## Usage with AI Agents

The [Quick Start](#quick-start) prompt is usually all an agent needs. `agentic-demo guide` prints the full workflow, matched to the installed version: exploring with agent-browser, writing and validating the steps file, rehearsing with `--silent`, and reading failures. `agentic-demo --help` points agents to it too.

### AGENTS.md / CLAUDE.md

So your agent reaches for it without being told:

```markdown
## Demo Videos

Use `agentic-demo` to record narrated demo videos of web flows. Run `npx agentic-demo guide` for the workflow before writing a steps file.
```

## License

Apache-2.0. Originally forked from [@browserbasehq/mcp-server-browserbase](https://github.com/browserbase/mcp-server-browserbase).
