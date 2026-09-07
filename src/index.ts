export type { CapturedFrame, TimelineEntry } from "./timeline.js";

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
  stepFailureHints,
} from "./agentBrowserRecorder.js";
export type {
  AgentBrowserDemoRecorder,
  AttachAgentBrowserDemoRecorderOptions,
  DemoRenderOptions,
  DemoStepOptions,
  RenderResult,
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

export { estimateSpeechSeconds, silentWav, synthesize } from "./speech.js";
export type {
  SpeechOptions,
  SpeechOverrides,
  SynthesizedAudio,
} from "./speech.js";

export {
  assertSpeechCredentials,
  DEFAULT_OPENAI_VOICE,
  DEFAULT_SPEECH_SPEC,
  KNOWN_PROVIDERS,
  loadSpeechModel,
  parseSpeechSpec,
} from "./speechProviders.js";
export type { ModuleImporter, SpeechSpec } from "./speechProviders.js";

export {
  exampleStepsFile,
  parseStepsFile,
  parseStepsFileText,
  StepsFileError,
  stepsFileJsonSchema,
  StepsFileSchema,
} from "./stepsFile.js";
export type { Step, StepsFile } from "./stepsFile.js";
