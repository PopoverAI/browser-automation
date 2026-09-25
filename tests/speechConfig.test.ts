import { describe, expect, it, vi } from "vitest";

import { resolveSpeech } from "../src/speechConfig.js";
import type { SpeechSpec } from "../src/speechProviders.js";

const URL = "https://app.example.com/api/voice";

const env = {
	OPENAI_API_KEY: "k",
	ELEVENLABS_API_KEY: "k",
};

function fakeLoader() {
	return vi.fn(async (spec: SpeechSpec) => ({
		specificationVersion: "v4" as const,
		provider: spec.provider,
		modelId: spec.model ?? "",
		doGenerate: async () => {
			throw new Error("not called");
		},
	}));
}

describe("resolveSpeech", () => {
	it("defaults to openai gpt-4o-mini-tts with voice alloy", async () => {
		const loadModel = fakeLoader();
		const s = await resolveSpeech(undefined, {}, { loadModel, env });
		expect(loadModel).toHaveBeenCalledWith({
			provider: "openai",
			model: "gpt-4o-mini-tts",
		});
		expect(s.voice).toBe("alloy");
	});

	it("keeps a model configured without a provider (default provider, that model)", async () => {
		const loadModel = fakeLoader();
		await resolveSpeech({ model: "tts-1-hd" }, {}, { loadModel, env });
		expect(loadModel).toHaveBeenCalledWith({
			provider: "openai",
			model: "tts-1-hd",
		});
	});

	it("matches the file's provider to the flag case-insensitively when choosing the voice", async () => {
		const loadModel = fakeLoader();
		const s = await resolveSpeech(
			{ provider: "OpenAI", voice: "nova" },
			{ tts: "openai" },
			{ loadModel, env },
		);
		expect(s.voice).toBe("nova");
	});

	it("drops the file's voice when --tts switches provider, and lets --voice win", async () => {
		const loadModel = fakeLoader();
		const dropped = await resolveSpeech(
			{ provider: "openai", voice: "nova" },
			{ tts: "elevenlabs:eleven_v3" },
			{ loadModel, env },
		);
		expect(dropped.voice).toBeUndefined();
		const flagged = await resolveSpeech(
			{ provider: "openai", voice: "nova" },
			{ voice: "shimmer" },
			{ loadModel, env },
		);
		expect(flagged.voice).toBe("shimmer");
	});

	it("sends an endpoint named in the file the file's model and voice, with the token", async () => {
		const loadModel = fakeLoader();
		const fetch = vi.fn(
			async () =>
				new Response(new Uint8Array([1]), {
					headers: { "Content-Type": "audio/mpeg" },
				}),
		);
		const s = await resolveSpeech(
			{ endpoint: URL, model: "m1", voice: "nova", instructions: "warm" },
			{},
			{ loadModel, fetch, env: { AGENTIC_DEMO_TTS_TOKEN: "t" } },
		);
		expect(loadModel).not.toHaveBeenCalled();
		expect(s).toMatchObject({ voice: "nova", instructions: "warm" });
		const model = s.model as Extract<typeof s.model, { doGenerate: unknown }>;
		await model.doGenerate({ text: "hi", voice: s.voice });
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(URL);
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer t",
		);
		expect(JSON.parse(init.body as string)).toEqual({
			text: "hi",
			model: "m1",
			voice: "nova",
		});
	});

	it("takes an endpoint URL from --tts, dropping a voice the file chose for a provider", async () => {
		const loadModel = fakeLoader();
		const log = vi.fn();
		const s = await resolveSpeech(
			{ provider: "openai", model: "tts-1-hd", voice: "nova" },
			{ tts: URL },
			{ loadModel, env: {}, log },
		);
		expect(loadModel).not.toHaveBeenCalled();
		expect(s.voice).toBeUndefined();
		expect(s.model).toMatchObject({ provider: "endpoint", modelId: "" });
		expect(log).toHaveBeenCalledWith(`narration: ${URL}`);

		const flagged = await resolveSpeech(
			{ endpoint: URL, voice: "nova" },
			{ tts: URL, voice: "shimmer" },
			{ loadModel, env: {} },
		);
		expect(flagged.voice).toBe("shimmer");
	});

	it("lets --tts <provider> override an endpoint in the file", async () => {
		const loadModel = fakeLoader();
		const s = await resolveSpeech(
			{ endpoint: URL, voice: "nova" },
			{ tts: "openai" },
			{ loadModel, env },
		);
		expect(loadModel).toHaveBeenCalledWith({ provider: "openai" });
		expect(s.voice).toBe("alloy");
	});

	it("passes narration knobs through and checks credentials up front", async () => {
		const loadModel = fakeLoader();
		const s = await resolveSpeech(
			{
				provider: "elevenlabs",
				model: "eleven_v3",
				voice: "v",
				instructions: "warm",
				speed: 1.1,
				language: "en",
				providerOptions: { elevenlabs: { stability: 0.4 } },
			},
			{},
			{ loadModel, env },
		);
		expect(s).toMatchObject({
			voice: "v",
			instructions: "warm",
			speed: 1.1,
			language: "en",
			providerOptions: { elevenlabs: { stability: 0.4 } },
		});
		await expect(
			resolveSpeech({ provider: "deepgram" }, {}, { loadModel, env: {} }),
		).rejects.toThrow(/DEEPGRAM_API_KEY/);
		expect(loadModel).toHaveBeenCalledTimes(1);
	});
});
