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
	AgentBrowserClient,
	AgentBrowserError,
	DEFAULT_AGENT_BROWSER_COMMAND,
} from "./agentBrowserClient.js";
export type {
	AgentBrowserDemoRecorder,
	AttachAgentBrowserDemoRecorderOptions,
	DemoRenderOptions,
	DemoStepOptions,
	RenderResult,
} from "./agentBrowserRecorder.js";

export {
	attachAgentBrowserDemoRecorder,
	DemoStepError,
	formatCommands,
	stepFailureHints,
} from "./agentBrowserRecorder.js";
export type {
	RenderedSegment,
	RenderTimelineOptions,
	RenderTimelineResult,
} from "./render.js";
export { renderTimeline } from "./render.js";
export type {
	SpeechOptions,
	SpeechOverrides,
	SynthesizedAudio,
} from "./speech.js";

export { estimateSpeechSeconds, silentWav, synthesize } from "./speech.js";
export type { ResolveSpeechDeps, SpeechFlags } from "./speechConfig.js";
export { resolveSpeech } from "./speechConfig.js";
export type { ModuleImporter, SpeechSpec } from "./speechProviders.js";
export {
	assertSpeechCredentials,
	DEFAULT_OPENAI_VOICE,
	DEFAULT_SPEECH_SPEC,
	KNOWN_PROVIDERS,
	loadSpeechModel,
	parseSpeechSpec,
} from "./speechProviders.js";
export type { Step, StepsFile } from "./stepsFile.js";

export {
	exampleStepsFile,
	parseStepsFile,
	parseStepsFileText,
	StepsFileError,
	StepsFileSchema,
	stepsFileJsonSchema,
} from "./stepsFile.js";
export type { CapturedFrame, TimelineEntry } from "./timeline.js";
