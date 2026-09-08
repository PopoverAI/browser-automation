import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { SpeechModel } from "ai";

/**
 * CLI-side resolution of `--tts <provider>[:<model>]` (or the `speech`
 * block of a steps file) to an AI SDK speech model. The renderer never sees
 * any of this — it takes a `SpeechModel` and nothing else.
 */

export interface SpeechSpec {
  provider: string;
  model?: string;
}

interface KnownProvider {
  /** Env var the provider package reads its API key from. */
  apiKeyEnv: string;
  /** Default model when the spec has none; `null` means the factory takes no id. */
  defaultModel: string | null;
  /** Example model ids for error messages. */
  examples: string[];
}

/**
 * Providers bundled with the CLI. Anything else is resolved the same way
 * (`@ai-sdk/<name>`), just without a key preflight or default model.
 */
export const KNOWN_PROVIDERS: Record<string, KnownProvider> = {
  openai: {
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4o-mini-tts",
    examples: ["gpt-4o-mini-tts", "tts-1-hd"],
  },
  elevenlabs: {
    apiKeyEnv: "ELEVENLABS_API_KEY",
    defaultModel: "eleven_multilingual_v2",
    examples: ["eleven_v3", "eleven_multilingual_v2", "eleven_flash_v2_5"],
  },
  lmnt: {
    apiKeyEnv: "LMNT_API_KEY",
    defaultModel: "aurora",
    examples: ["aurora", "blizzard"],
  },
  hume: {
    apiKeyEnv: "HUME_API_KEY",
    defaultModel: null,
    examples: [],
  },
  deepgram: {
    apiKeyEnv: "DEEPGRAM_API_KEY",
    defaultModel: "aura-2",
    examples: ["aura", "aura-2"],
  },
};

export const DEFAULT_SPEECH_SPEC: SpeechSpec = {
  provider: "openai",
  model: "gpt-4o-mini-tts",
};

/** Default voice for the default provider; other providers pick their own. */
export const DEFAULT_OPENAI_VOICE = "alloy";

/** Parse `provider[:model]`. */
export function parseSpeechSpec(input: string): SpeechSpec {
  const trimmed = input.trim();
  const idx = trimmed.indexOf(":");
  const provider = (idx === -1 ? trimmed : trimmed.slice(0, idx)).toLowerCase();
  const model = idx === -1 ? undefined : trimmed.slice(idx + 1);
  if (!/^[a-z0-9-]+$/.test(provider)) {
    throw new Error(
      `--tts: "${input}" is not a valid provider spec (expected <provider>[:<model>], e.g. elevenlabs:eleven_v3)`,
    );
  }
  if (model !== undefined && model.length === 0) {
    throw new Error(`--tts: "${input}" has an empty model id`);
  }
  return { provider, model };
}

/**
 * Fail before recording if a bundled provider's key is missing — the SDK
 * would otherwise only notice on the first synthesis, after the browser
 * work is done.
 */
export function assertSpeechCredentials(
  spec: SpeechSpec,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const known = KNOWN_PROVIDERS[spec.provider];
  if (!known) return;
  if (!env[known.apiKeyEnv]) {
    throw new Error(
      `${known.apiKeyEnv} is not set (needed for --tts ${spec.provider}). Set it, choose another provider with --tts or the steps file's "speech" block, or pass --silent.`,
    );
  }
}

/** Shape of an AI SDK provider package's default instance, as far as we use it. */
interface ProviderInstance {
  speechModel?: (modelId?: string) => SpeechModel;
  speech?: (modelId?: string) => SpeechModel;
}

export type ModuleImporter = (
  specifier: string,
) => Promise<Record<string, unknown>>;

/**
 * Import `@ai-sdk/<provider>`, preferring the copy installed in `cwd`'s
 * project (so a provider we don't bundle, or a newer version, wins), then
 * falling back to the CLI's own dependencies.
 */
export async function importProviderModule(
  provider: string,
  opts: { cwd?: string; importer?: ModuleImporter } = {},
): Promise<Record<string, unknown>> {
  const specifier = `@ai-sdk/${provider}`;
  const importer = opts.importer ?? ((s) => import(s));
  const cwd = opts.cwd ?? process.cwd();
  try {
    const resolved = createRequire(join(cwd, "package.json")).resolve(
      specifier,
    );
    return await importer(pathToFileURL(resolved).href);
  } catch {
    // Not installed in the project — fall through to our own tree.
  }
  try {
    return await importer(specifier);
  } catch (err) {
    throw new Error(
      `--tts ${provider}: could not load ${specifier}. Install it in this project (npm i ${specifier}) or run via npx -p ${specifier} -p @popoverai/browser-automation browser-demo …\n${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Turn a spec into a model: load the provider package, find its default
 * instance (exported under the provider's name, e.g. `elevenlabs`), and call
 * its speech factory.
 */
export async function loadSpeechModel(
  spec: SpeechSpec,
  opts: { cwd?: string; importer?: ModuleImporter } = {},
): Promise<SpeechModel> {
  const mod = await importProviderModule(spec.provider, opts);
  const instance = findProviderInstance(mod, spec.provider);
  if (!instance) {
    throw new Error(
      `--tts ${spec.provider}: @ai-sdk/${spec.provider} does not export a speech-capable provider instance`,
    );
  }
  const known = KNOWN_PROVIDERS[spec.provider];
  const factory = instance.speechModel ?? instance.speech;
  if (!factory) {
    throw new Error(`--tts ${spec.provider}: provider has no speech models`);
  }
  if (known?.defaultModel === null) {
    // Single-model provider (Hume): the factory takes no id.
    return factory.call(instance);
  }
  const model = spec.model ?? known?.defaultModel;
  if (!model) {
    throw new Error(
      `--tts ${spec.provider}: a model id is required (--tts ${spec.provider}:<model>)`,
    );
  }
  return factory.call(instance, model);
}

function findProviderInstance(
  mod: Record<string, unknown>,
  provider: string,
): ProviderInstance | undefined {
  const isInstance = (v: unknown): v is ProviderInstance =>
    typeof v === "function" || (typeof v === "object" && v !== null)
      ? typeof (v as ProviderInstance).speech === "function" ||
        typeof (v as ProviderInstance).speechModel === "function"
      : false;
  const named = mod[provider] ?? mod[provider.replace(/-/g, "")];
  if (isInstance(named)) return named;
  const fallback = mod.default;
  if (isInstance(fallback)) return fallback;
  for (const v of Object.values(mod)) {
    if (isInstance(v)) return v;
  }
  return undefined;
}
