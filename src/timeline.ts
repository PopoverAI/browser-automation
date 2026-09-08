/**
 * Shared shapes between the recorder (which produces frames + a timeline)
 * and the renderer (which turns them into a narrated mp4).
 */

import type { SpeechOverrides } from "./speech.js";

export interface CapturedFrame {
  /**
   * Wall-clock timestamp (ms since epoch) for the frame. Stamped on receipt
   * from the agent-browser stream (its frame metadata carries no usable
   * timestamp as of 0.36); step boundaries are stamped from the same clock.
   */
  timestamp: number;
  /** Base64-encoded image data. */
  data: string;
  /** Image encoding of `data`. Default "png"; the agent-browser stream sends "jpeg". */
  format?: "png" | "jpeg";
}

export interface TimelineEntry {
  /** One-line label for the step, e.g. the batch commands joined with `&&`. */
  instruction: string;
  /** Narration spoken over this segment. */
  narrative: string;
  /** Wall-clock ms since epoch — start of the step. */
  startTime: number;
  /** Wall-clock ms since epoch — end of the step (after trailingDelay). */
  endTime: number;
  /** Number of frames whose timestamp fell within [startTime, endTime]. */
  frameCount: number;
  /** (endTime - startTime) / 1000, in seconds. */
  segmentDuration: number;
  /** Per-step narration overrides (voice, language, …) merged over the render's `speech`. */
  speech?: SpeechOverrides;
}
