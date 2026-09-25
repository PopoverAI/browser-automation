import { generateSpeech } from "ai";
import { describe, expect, it, vi } from "vitest";

import { silentWav } from "../src/speech.js";
import {
	createEndpointSpeechModel,
	isSpeechEndpointUrl,
	SpeechEndpointError,
} from "../src/speechEndpoint.js";

const URL = "https://app.example.com/api/voice";

function respond(body: BodyInit | null, init: ResponseInit = {}) {
	return vi.fn<typeof fetch>(async () => new Response(body, init));
}

function sent(fetch: ReturnType<typeof respond>) {
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
	return {
		url,
		method: init.method,
		headers: init.headers as Record<string, string>,
		body: JSON.parse(init.body as string),
	};
}

describe("isSpeechEndpointUrl", () => {
	it("tells a URL from a provider spec", () => {
		expect(isSpeechEndpointUrl(URL)).toBe(true);
		expect(isSpeechEndpointUrl("http://localhost:3000/voice")).toBe(true);
		expect(isSpeechEndpointUrl("openai:gpt-4o-mini-tts")).toBe(false);
		expect(isSpeechEndpointUrl("elevenlabs")).toBe(false);
	});
});

describe("endpoint speech model", () => {
	it("posts the line and its voice settings as JSON with a bearer token, and returns the audio", async () => {
		const wav = silentWav(0.01);
		const fetch = respond(new Uint8Array(wav), {
			headers: { "Content-Type": "audio/wav" },
		});
		const model = createEndpointSpeechModel({
			url: URL,
			model: "gpt-4o-mini-tts",
			token: "secret",
			fetch,
		});

		const result = await generateSpeech({
			model,
			text: "Sign in with the demo account.",
			voice: "alloy",
			instructions: "warm",
			speed: 1.1,
			language: "en",
			outputFormat: "mp3",
		});

		const req = sent(fetch);
		expect(req.url).toBe(URL);
		expect(req.method).toBe("POST");
		expect(req.headers).toMatchObject({
			Authorization: "Bearer secret",
			"Content-Type": "application/json",
			Accept: "audio/*",
		});
		expect(req.body).toEqual({
			text: "Sign in with the demo account.",
			model: "gpt-4o-mini-tts",
			voice: "alloy",
			instructions: "warm",
			speed: 1.1,
			language: "en",
			outputFormat: "mp3",
		});
		expect(result.audio.format).toBe("wav");
		expect(result.audio.uint8Array).toEqual(wav);
	});

	it("sends no Authorization header and no unset fields when there is no token", async () => {
		const fetch = respond(new Uint8Array([1]), {
			headers: { "Content-Type": "audio/mpeg" },
		});
		await createEndpointSpeechModel({ url: URL, fetch }).doGenerate({
			text: "hi",
		});
		const req = sent(fetch);
		expect(req.headers.Authorization).toBeUndefined();
		expect(req.body).toEqual({ text: "hi" });
	});

	it("shows a refusal's JSON error message word for word, without retrying", async () => {
		const message =
			"Your team has used this month's AI quota. Upgrade at https://example.com/billing to keep recording.";
		const fetch = respond(JSON.stringify({ error: message }), {
			status: 402,
			headers: { "Content-Type": "application/json" },
		});
		const model = createEndpointSpeechModel({ url: URL, token: "t", fetch });

		const err = await generateSpeech({ model, text: "hi" }).catch((e) => e);

		expect(err).toBeInstanceOf(SpeechEndpointError);
		expect(err.status).toBe(402);
		expect(err.endpointMessage).toBe(message);
		expect(err.message).toContain(`HTTP 402`);
		expect(err.message.endsWith(`\n${message}`)).toBe(true);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("shows a non-JSON error body as it came", async () => {
		const fetch = respond("Bad gateway: upstream timed out", { status: 502 });
		const err = await createEndpointSpeechModel({ url: URL, fetch })
			.doGenerate({ text: "hi" })
			.then(
				() => undefined,
				(e) => e,
			);
		expect(err.endpointMessage).toBe("Bad gateway: upstream timed out");
	});

	it("says the token is missing when the endpoint wants a credential and none was sent", async () => {
		const fetch = respond(JSON.stringify({ error: "Missing token" }), {
			status: 401,
		});
		const err = await createEndpointSpeechModel({ url: URL, fetch })
			.doGenerate({ text: "hi" })
			.then(
				() => undefined,
				(e) => e,
			);
		expect(err.message).toMatch(/AGENTIC_DEMO_TTS_TOKEN is not set/);
		expect(err.message).toMatch(/Missing token$/);
	});

	it.each([
		"application/json",
		"application/problem+json",
		"image/png",
		"application/octet-stream",
		null,
	])("refuses a success response whose Content-Type is %s", async (type) => {
		// A byte body gets no Content-Type unless one is given.
		const fetch = respond(new Uint8Array([1]), {
			headers: type ? { "Content-Type": type } : {},
		});
		await expect(
			createEndpointSpeechModel({ url: URL, fetch }).doGenerate({ text: "hi" }),
		).rejects.toThrow(/not audio\/\*/);
	});

	it("names the endpoint when it cannot be reached", async () => {
		const unreachable = vi.fn<typeof fetch>(async () => {
			throw new TypeError("fetch failed", {
				cause: new Error("connect ECONNREFUSED 127.0.0.1:3000"),
			});
		});
		await expect(
			createEndpointSpeechModel({ url: URL, fetch: unreachable }).doGenerate({
				text: "hi",
			}),
		).rejects.toThrow(
			`could not reach the voice endpoint ${URL}: connect ECONNREFUSED 127.0.0.1:3000`,
		);
	});
});
