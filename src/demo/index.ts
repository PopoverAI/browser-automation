export { attachDemoRecorder } from "./recorder.js";
export type {
  AttachDemoRecorderOptions,
  CapturedFrame,
  DemoActOptions,
  DemoAgentOptions,
  DemoRecorder,
  DemoRenderOptions,
  RenderResult,
  TimelineEntry,
} from "./recorder.js";

export { renderTimeline } from "./render.js";
export type {
  RenderTimelineOptions,
  RenderTimelineResult,
  RenderedSegment,
} from "./render.js";

export {
  attachAgentBrowserDemoRecorder,
  DemoStepError,
  formatCommands,
} from "./agentBrowserRecorder.js";
export type {
  AgentBrowserDemoRecorder,
  AttachAgentBrowserDemoRecorderOptions,
  DemoStepOptions,
} from "./agentBrowserRecorder.js";

export {
  AgentBrowserClient,
  AgentBrowserError,
  DEFAULT_AGENT_BROWSER_COMMAND,
} from "./agentBrowserClient.js";
export type {
  AgentBrowserClientOptions,
  AgentBrowserExec,
  AgentBrowserExecOptions,
  AgentBrowserExecResult,
  BatchCommandResult,
  BatchOptions,
  StreamStatus,
} from "./agentBrowserClient.js";

export {
  createOpenAITTS,
  createSilentTTS,
  estimateSpeechSeconds,
} from "./tts.js";
export type { SilentTTSOptions, TTSProvider, TTSResult } from "./tts.js";
