import type { SpeechModel } from "ai";

import type { SpeechOptions } from "./speech.js";
import {
	createEndpointSpeechModel,
	isSpeechEndpointUrl,
	SPEECH_ENDPOINT_TOKEN_ENV,
} from "./speechEndpoint.js";
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
	/** `--tts <provider[:model]|url>` */
	tts?: string;
	/** `--voice <id>` */
	voice?: string;
}

export interface ResolveSpeechDeps {
	loadModel?: typeof loadSpeechModel;
	/** Test seam for the endpoint model's requests. */
	fetch?: typeof fetch;
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
 *
 * The voice source can instead be an endpoint URL (`--tts https://…` or the
 * file's `speech.endpoint`), which is sent AGENTIC_DEMO_TTS_TOKEN as a bearer
 * token and asked for each line.
 */
export async function resolveSpeech(
	fileSpeech: StepsFile["speech"],
	flags: SpeechFlags,
	deps: ResolveSpeechDeps = {},
): Promise<SpeechOptions> {
	const file = fileSpeech ?? {};
	const env = deps.env ?? process.env;
	// Where the file's voice and model were chosen for: an endpoint URL or a
	// provider name.
	const fileSource =
		file.endpoint ??
		file.provider?.toLowerCase() ??
		DEFAULT_SPEECH_SPEC.provider;

	const endpoint = flags.tts
		? isSpeechEndpointUrl(flags.tts)
			? flags.tts.trim()
			: undefined
		: file.endpoint;

	let model: SpeechModel;
	let source: string;
	let label: string;
	if (endpoint) {
		// The file's model goes to the endpoint it was written for, not another.
		const modelId = fileSource === endpoint ? file.model : undefined;
		model = createEndpointSpeechModel({
			url: endpoint,
			model: modelId,
			token: env[SPEECH_ENDPOINT_TOKEN_ENV],
			fetch: deps.fetch,
		});
		source = endpoint;
		label = `${endpoint}${modelId ? ` (model ${modelId})` : ""}`;
	} else {
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
		assertSpeechCredentials(spec, env);
		model = await (deps.loadModel ?? loadSpeechModel)(spec);
		source = spec.provider;
		label = `${spec.provider}${spec.model ? `:${spec.model}` : ""}`;
	}

	// Flags beat the file. The file's voice is specific to its voice source,
	// so it only applies when the source in use is the one the file named
	// (or the default, when the file named none).
	const voice =
		flags.voice ??
		(fileSource === source ? file.voice : undefined) ??
		(source === "openai" ? DEFAULT_OPENAI_VOICE : undefined);

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
	deps.log?.(`narration: ${label}${voice ? ` (voice ${voice})` : ""}`);
	return speech;
}
