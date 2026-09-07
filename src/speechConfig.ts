import type { SpeechOptions } from "./speech.js";
import {
  assertSpeechCredentials,
  DEFAULT_OPENAI_VOICE,
  DEFAULT_SPEECH_SPEC,
  loadSpeechModel,
  parseSpeechSpec,
  type SpeechSpec,
} from "./speechProviders.js";
import type { StepsFile } from "./stepsFile.js";

export interface SpeechFlags {
  /** `--tts <provider[:model]>` */
  tts?: string;
  /** `--voice <id>` */
  voice?: string;
}

export interface ResolveSpeechDeps {
  loadModel?: typeof loadSpeechModel;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

/**
 * Turn the steps file's `speech` block plus CLI flags into render options.
 *
 * Precedence: --tts / --voice flags → the steps file's `speech` block →
 * OpenAI gpt-4o-mini-tts with voice "alloy". A file that names a model but
 * no provider means the default provider with that model. Credentials come
 * from the provider package's own env var (OPENAI_API_KEY, ELEVENLABS_API_KEY,
 * …) and are checked before anything touches a browser.
 */
export async function resolveSpeech(
  fileSpeech: StepsFile["speech"],
  flags: SpeechFlags,
  deps: ResolveSpeechDeps = {},
): Promise<SpeechOptions> {
  const file = fileSpeech ?? {};
  const fileProvider = file.provider?.toLowerCase();

  let spec: SpeechSpec;
  if (flags.tts) {
    spec = parseSpeechSpec(flags.tts);
  } else if (fileProvider) {
    spec = { provider: fileProvider, model: file.model };
  } else {
    spec = {
      ...DEFAULT_SPEECH_SPEC,
      model: file.model ?? DEFAULT_SPEECH_SPEC.model,
    };
  }
  assertSpeechCredentials(spec, deps.env);

  const model = await (deps.loadModel ?? loadSpeechModel)(spec);

  // Flags beat the file. The file's voice is provider-specific, so it only
  // applies when the provider actually in use is the one the file named
  // (or the default, when the file named none).
  const fileVoiceApplies =
    (fileProvider ?? DEFAULT_SPEECH_SPEC.provider) === spec.provider;
  const voice =
    flags.voice ??
    (fileVoiceApplies ? file.voice : undefined) ??
    (spec.provider === "openai" ? DEFAULT_OPENAI_VOICE : undefined);

  const speech: SpeechOptions = { model };
  if (voice) speech.voice = voice;
  if (file.instructions) speech.instructions = file.instructions;
  if (file.speed) speech.speed = file.speed;
  if (file.language) speech.language = file.language;
  if (file.outputFormat) speech.outputFormat = file.outputFormat;
  if (file.providerOptions) {
    speech.providerOptions =
      file.providerOptions as SpeechOptions["providerOptions"];
  }
  deps.log?.(
    `narration: ${spec.provider}${spec.model ? `:${spec.model}` : ""}${voice ? ` (voice ${voice})` : ""}`,
  );
  return speech;
}
