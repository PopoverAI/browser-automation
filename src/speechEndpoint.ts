import type { SpeechModel } from "ai";

/**
 * Narration from an HTTP endpoint: an app that speaks for the tool. The CLI
 * posts each line as JSON and gets audio back, so the machine running the
 * recording holds only a token for that app, never a speech provider's key.
 * The request and response are documented in README.md → "Voice endpoint";
 * change both together.
 *
 * It is an ordinary AI SDK speech model, so the renderer needs nothing new.
 */

type SpeechModelV4 = Extract<SpeechModel, { specificationVersion: "v4" }>;

/** Environment variable whose value is sent as `Authorization: Bearer …`. */
export const SPEECH_ENDPOINT_TOKEN_ENV = "AGENTIC_DEMO_TTS_TOKEN";

/** True when a `--tts` value is an endpoint URL rather than `provider[:model]`. */
export function isSpeechEndpointUrl(value: string): boolean {
	return /^https?:\/\//i.test(value.trim());
}

/**
 * The endpoint refused a line or answered with something other than audio.
 * `message` carries the endpoint's own words unchanged, so an app can put
 * instructions for the person (a quota message, an upgrade link) in front of
 * them.
 */
export class SpeechEndpointError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly endpointMessage: string,
	) {
		super(message);
		this.name = "SpeechEndpointError";
	}
}

export interface EndpointSpeechModelOptions {
	url: string;
	/** Sent as `model`; the endpoint picks its own when omitted. */
	model?: string;
	/** Sent as `Authorization: Bearer <token>` when set. */
	token?: string;
	/** Test seam. */
	fetch?: typeof fetch;
}

export function createEndpointSpeechModel(
	options: EndpointSpeechModelOptions,
): SpeechModelV4 {
	const { url, model, token } = options;
	const doFetch = options.fetch ?? fetch;
	return {
		specificationVersion: "v4",
		provider: "endpoint",
		modelId: model ?? "",
		async doGenerate(call) {
			const body = {
				text: call.text,
				model,
				voice: call.voice,
				instructions: call.instructions,
				speed: call.speed,
				language: call.language,
				outputFormat: call.outputFormat,
				providerOptions:
					call.providerOptions && Object.keys(call.providerOptions).length > 0
						? call.providerOptions
						: undefined,
			};
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Accept: "audio/*",
			};
			if (token) headers.Authorization = `Bearer ${token}`;

			let res: Response;
			try {
				res = await doFetch(url, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: call.abortSignal,
				});
			} catch (err) {
				if (err instanceof Error && err.name === "AbortError") throw err;
				const cause =
					err instanceof Error && err.cause instanceof Error
						? err.cause.message
						: err instanceof Error
							? err.message
							: String(err);
				throw new Error(`could not reach the voice endpoint ${url}: ${cause}`, {
					cause: err,
				});
			}

			if (!res.ok) {
				const said = await readErrorMessage(res);
				const hint =
					(res.status === 401 || res.status === 403) && !token
						? ` (${SPEECH_ENDPOINT_TOKEN_ENV} is not set, so no credential was sent)`
						: "";
				throw new SpeechEndpointError(
					`the voice endpoint ${url} refused to narrate (HTTP ${res.status})${hint}:\n${said}`,
					res.status,
					said,
				);
			}

			const contentType = res.headers.get("content-type") ?? "";
			if (/^(application\/json|text\/)/i.test(contentType)) {
				const said = (await res.text()).trim();
				throw new SpeechEndpointError(
					`the voice endpoint ${url} answered HTTP ${res.status} with ${contentType}, not audio:\n${said}`,
					res.status,
					said,
				);
			}

			return {
				audio: new Uint8Array(await res.arrayBuffer()),
				warnings: [],
				request: { body },
				response: {
					timestamp: new Date(),
					modelId: model ?? "",
					headers: Object.fromEntries(res.headers.entries()),
				},
			};
		},
	};
}

/**
 * The endpoint's message, unchanged: the `error` string of a JSON body, or
 * else the whole body as text.
 */
async function readErrorMessage(res: Response): Promise<string> {
	const text = (await res.text()).trim();
	try {
		const parsed: unknown = JSON.parse(text);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as { error?: unknown }).error === "string"
		) {
			return (parsed as { error: string }).error;
		}
	} catch {
		// Not JSON — the body itself is the message.
	}
	return text || res.statusText || "(empty response)";
}
