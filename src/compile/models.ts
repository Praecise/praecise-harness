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
import { ROOM } from "../harness/budget.js";

/**
 * The name of a request shape an endpoint speaks.
 *
 * Three ship — "messages", "chat", "contents", each named after the field it carries its
 * conversation in — and an app may register more. It is a string rather than a union of
 * the three because a closed union made a fourth vendor unreachable without a fork: the
 * `ChatAdapter` interface was public and typechecked, and there was nowhere to put an
 * implementation of it. `adapterFor` refuses an unregistered name and says which are
 * known, so the openness costs nothing at the point of a typo.
 */
export type Wire = string;

export type Env = Record<string, string | undefined>;

/** One resolved rung: a concrete model and the credential that reaches it. */
export interface Rung {
  provider: string;
  wire: Wire;
  model: string;
  baseUrl: string;
  apiKey: string;
  /** Environment variable the credential came from. */
  credentialEnv: string;
  /** Which step of the ladder this is, for the record the router keeps. */
  tier: Quality;
  /**
   * The most depth this rung may be asked for, 0..1. A ceiling rather than a
   * setting: how much of it a given request actually uses is decided per
   * request, because most questions handed to a thinking model do not need one.
   */
  effort: number;
  /** How this endpoint takes a request for more depth. */
  depth: "effort" | "budget" | "none";
  tools: boolean;
  /** Tokens of context this model has, which everything carried is a share of. */
  room: number;
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
    if (!provider.url) continue;
    // An endpoint you host yourself may need no credential at all — a llama.cpp server
    // on the local network is the ordinary case. `credential: ""` says so explicitly.
    // Omitting the field still defaults to NAME_API_KEY, so this branch cannot be
    // reached by forgetting to set a key: it is only reached by declaring, in the
    // config, that this endpoint takes none. Before this, the only way past the check
    // was to invent a dummy value, which reads in a config file like a secret that
    // matters and is a lie about the endpoint.
    if (provider.credential === "") {
      return { name, provider, apiKey: "", baseUrl: provider.url, credentialEnv: "", viaCloud: false };
    }
    const credentialEnv = credentialFor(name, provider);
    const apiKey = env[credentialEnv];
    if (!apiKey) continue;
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
 * Why nothing resolved, one line per endpoint the app declared.
 *
 * Empty when the app declared none, and that emptiness is load-bearing: an app
 * with no endpoints has never been configured, which is a first run. An app with
 * endpoints and no rungs was configured and is unreachable, which is a broken
 * deployment — and the two must not look alike to anything downstream, because
 * only one of them is safe to answer with a placeholder.
 */
export function unreachableEndpoints(
  providers: Record<string, ModelProvider> | undefined,
  env: Env,
): string[] {
  return Object.entries(providers ?? {}).map(([name, provider]) =>
    !provider.url
      ? `"${name}" declares no \`url\``
      : `"${name}" needs ${credentialFor(name, provider)} to be set${
          env[credentialFor(name, provider)] ? " to something non-empty" : ""
        }`,
  );
}

/**
 * The models each quality is allowed to use, cheapest first.
 *
 * This says how much room there is, not where in it a request lands. Nothing
 * here decides which rung answers: the router does that per request, and more
 * quality means more room for it to work in.
 */
const LADDER: Record<Quality, Quality[]> = {
  fast: ["fast"],
  balanced: ["fast", "balanced"],
  best: ["fast", "balanced", "best"],
};

/** The model for a rung, falling back towards whatever the provider did name. */
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
  const seen = new Set<string>();
  for (const tier of LADDER[options.quality]) {
    const model = modelFor(provider, tier);
    if (!model) continue;

    // A provider that names one model must not be given three rungs of it.
    // Climbing to the same model buys nothing, and the router would spend a
    // request finding that out. Asking it for more depth is a real difference,
    // so that counts as a rung where the endpoint takes such a request at all.
    // The fast rung declines depth BY DEFINITION — an author who asked for fast did not
    // ask for thinking — and that is also what lets one named model become two rungs
    // without the router paying a request to discover they are the same.
    //
    // The consequence is worth knowing: escalating along depth before crossing to another
    // model cannot happen ON a fast rung, because there is no headroom there to climb
    // into. It works from the middle rung up. Raising this is not a one-line change —
    // a non-thinking endpoint may reject a depth argument outright, and the key below
    // decides how many rungs a single-model provider gets — so it is a decision about
    // what "fast" promises, not a tuning constant.
    const effort = tier === "fast" ? 0 : 1;
    const key = `${model}\u0000${depth === "none" ? "" : String(effort)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rungs.push({
      provider: chosen.name,
      wire,
      model,
      baseUrl: chosen.baseUrl,
      apiKey: chosen.apiKey,
      credentialEnv: chosen.credentialEnv,
      tier,
      effort,
      depth,
      tools: provider.tools ?? true,
      room: provider.room ?? ROOM,
    });
  }
  return rungs;
}
