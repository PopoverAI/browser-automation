# agentic-demo

The npm name for [`@popoverai/browser-automation`](https://www.npmjs.com/package/@popoverai/browser-automation)'s
`agentic-demo` CLI: narrated demo videos from
[agent-browser](https://www.npmjs.com/package/agent-browser) flows.

```bash
npx agentic-demo guide            # the workflow guide
npx agentic-demo example          # a starter steps file
npx agentic-demo steps.json --silent --out ./demo
```

This package contains one file, which hands off to the CLI in
`@popoverai/browser-automation`. Everything — the steps-file format, the
guide, the flags, the changelog — lives there, and
`npx @popoverai/browser-automation …` remains an equivalent way in.

Steps are scripted, not prompted: commands run exactly as written and the
narration is the sentence you supply. An agent is what usually _writes_ the
steps file; it is not what drives the browser during the take.
