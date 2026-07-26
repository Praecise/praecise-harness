/**
 * Which models an agent actually runs on.
 *
 * A developer never names a model on an agent. They set `quality`, and this
 * module answers "given the credentials actually present, which models does that
 * mean, and when should each one hand off to the next?"
 *
 * The framework knows exactly one endpoint: Praecise Cloud. It ships no list of
 * other people's model APIs, no base URLs and no model ids — those change on
 * someone else's schedule and belong to the app that chose them. Point at any
 * endpoint you like by adding it to `models` in `praecise.config.ts`; it is a
 * few lines, and it says out loud what your app runs on.
 */

import type { ModelProvider, Quality } from "../define.js";

/**
 * The three request shapes an endpoint can speak, named after the field each
 * one carries its conversation in.
 */
export type Wire = "messages" | "chat" | "contents";

export type Env = Record<string, string | undefined>;

/** One resolved rung: a concrete model, its credential, and when to hand off. */
export interface Rung {
  provider: string;
  wire: Wire;
  model: string;
  baseUrl: string;
  apiKey: string;
  /** Environment variable the credential came from. */
  credentialEnv: string;
  /** Ask for more depth on this rung. */
  thinking: boolean;
  /** How this endpoint takes a request for more depth. */
  depth: "effort" | "budget" | "none";
  /**
   * Accept below this and the next rung takes over. `undefined` on the last
   * rung — there is nowhere left to go, so its answer stands.
   */
  handOffBelow?: number;
  tools: boolean;
}

const GATEWAY = "https://gateway.praecise.ai";

/**
 * Praecise Cloud takes the rung by name and decides the rest. That is the whole
 * point of it: one key, no model ids to keep current, and the choice of what
 * runs happens where it can be changed without a deploy.
 */
const CLOUD: Required<Pick<ModelProvider, "speaks" | "fast" | "balanced" | "best">> = {
  speaks: "chat",
  fast: "fast",
  balanced: "balanced",
  best: "best",
};

export interface Chosen {
  name: string;
  provider: ModelProvider;
  apiKey: string;
  baseUrl: string;
  credentialEnv: string;
  viaCloud: boolean;
}

/** The environment variable a provider's key lives in. Defaults to its name. */
export function credentialFor(name: string, provider: ModelProvider): string {
  return provider.credential ?? `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/**
 * Which provider to use, and with what credential.
 *
 * A declared provider always wins over the cloud — an explicit credential is
 * never quietly overridden. Declaration order is preference order.
 */
export function chooseProvider(
  providers: Record<string, ModelProvider> | undefined,
  env: Env,
  prefer?: string,
): Chosen | undefined {
  const entries = Object.entries(providers ?? {});
  const ordered = prefer
    ? [...entries].sort(([a], [b]) => (a === prefer ? -1 : b === prefer ? 1 : 0))
    : entries;

  for (const [name, provider] of ordered) {
    const credentialEnv = credentialFor(name, provider);
    const apiKey = env[credentialEnv];
    if (!apiKey || !provider.url) continue;
    return { name, provider, apiKey, baseUrl: provider.url, credentialEnv, viaCloud: false };
  }

  const key = env.PRAECISE_API_KEY;
  if (!key) return undefined;
  return {
    name: "praecise",
    provider: CLOUD,
    apiKey: key,
    baseUrl: (env.PRAECISE_GATEWAY_URL ?? GATEWAY).replace(/\/$/, ""),
    credentialEnv: "PRAECISE_API_KEY",
    viaCloud: true,
  };
}

/**
 * Hand-off thresholds per quality. More quality means more rungs and a higher
 * bar before an answer is accepted, so a hard question climbs and an easy one
 * stops at the cheapest model that got it right.
 */
const CASCADE: Record<Quality, { rung: Quality; handOffBelow?: number }[]> = {
  fast: [{ rung: "fast" }],
  balanced: [{ rung: "fast", handOffBelow: 0.75 }, { rung: "balanced" }],
  best: [
    { rung: "fast", handOffBelow: 0.85 },
    { rung: "balanced", handOffBelow: 0.9 },
    { rung: "best" },
  ],
};

/**
 * The model for a rung, falling back towards whatever the provider did name.
 * A provider that names one model runs every rung on it — the cascade still
 * works, it just stops buying anything by climbing.
 */
function modelFor(provider: ModelProvider, rung: Quality): string | undefined {
  const named = [provider[rung], provider.balanced, provider.best, provider.fast];
  return named.find((model) => typeof model === "string" && model.length > 0);
}

export interface PlanModelsOptions {
  env: Env;
  quality: Quality;
  /** Declared providers, in preference order. */
  providers?: Record<string, ModelProvider>;
  /** Force one by name. */
  prefer?: string;
}

/**
 * Turn a quality setting into the concrete rungs to walk. Returns an empty
 * array when nothing is configured — callers fall back to offline mode.
 */
export function planModels(options: PlanModelsOptions): Rung[] {
  const chosen = chooseProvider(options.providers, options.env, options.prefer);
  if (!chosen) return [];

  const { provider } = chosen;
  const wire = provider.speaks ?? "chat";
  const depth = provider.thinking ?? (wire === "messages" ? "budget" : "none");

  const rungs: Rung[] = [];
  for (const { rung, handOffBelow } of CASCADE[options.quality]) {
    const model = modelFor(provider, rung);
    if (!model) continue;
    rungs.push({
      provider: chosen.name,
      wire,
      model,
      baseUrl: chosen.baseUrl,
      apiKey: chosen.apiKey,
      credentialEnv: chosen.credentialEnv,
      thinking: rung !== "fast",
      depth,
      handOffBelow,
      tools: provider.tools ?? true,
    });
  }

  // The last rung is where an answer stands, whichever rung that turned out to
  // be: a provider naming fewer models must not be left waiting to hand off to
  // something that is not there.
  const last = rungs[rungs.length - 1];
  if (last) delete last.handOffBelow;
  return rungs;
}
