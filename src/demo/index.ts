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

export { createOpenAITTS } from "./tts.js";
export type { TTSProvider, TTSResult } from "./tts.js";
