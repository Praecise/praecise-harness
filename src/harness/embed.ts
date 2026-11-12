/**
 * Turning text into a vector, where an app has somewhere to do it.
 *
 * A vector store compares vectors, and for a long time an app had to supply them: the
 * framework requires no credential that can produce one, so it derived none. That left
 * an agent remembering into a vector store with a text index doing the remembering —
 * recall by shared words, which misses the exchange that said the same thing differently.
 *
 * So an endpoint may now say which model it embeds with, and where one does, what an
 * agent remembers is embedded on the way in and looked up by meaning on the way out.
 * Nothing is derived for an app that declared nothing, and an embedding that cannot be
 * had is never a reason to lose the memory: the text path is still there underneath.
 */

import type { ModelProvider } from "../define.js";
import { chooseProviders, type Env } from "../compile/models.js";
import { ProviderError } from "./types.js";
import { retryAfterOf } from "./wire/http.js";

/** Text in, one vector per text out, in the same order. */
export type Embedder = (texts: string[], signal?: AbortSignal) => Promise<number[][]>;

interface EmbeddingsPayload {
  data?: { index?: number; embedding?: number[] }[];
}

/**
 * An embedder for the first reachable endpoint that names an embedding model.
 *
 * The request is the one shape nearly every endpoint that embeds at all accepts:
 * `POST {url}/embeddings` with a model and a list of inputs. An endpoint that embeds
 * some other way is an `Embedder` an app writes and hands to `App.load`.
 */
export function embedderFor(
  providers: Record<string, ModelProvider> | undefined,
  env: Env,
  fetchImpl: typeof fetch,
): Embedder | undefined {
  const chosen = chooseProviders(providers, env).find((entry) => entry.provider.embeds);
  if (!chosen) return undefined;
  const { provider, apiKey, baseUrl } = chosen;
  const url = `${baseUrl.replace(/\/+$/, "")}/embeddings`;

  return async (texts, signal) => {
    if (!texts.length) return [];
    const credential = provider.credentialHeader ?? "authorization";
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        ...(apiKey ? { [credential]: provider.credentialHeader ? apiKey : `Bearer ${apiKey}` } : {}),
        "content-type": "application/json",
        ...provider.headers,
      },
      body: JSON.stringify({ model: provider.embeds, input: texts }),
      signal,
    });
    if (!response.ok) {
      throw new ProviderError("embeddings", response.status, await response.text(), retryAfterOf(response.headers));
    }
    const payload = (await response.json()) as EmbeddingsPayload;
    // Ordered by the index each row carries rather than by arrival: the shape permits
    // either, and a vector filed against the wrong text is a wrong answer found confidently.
    const rows = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = rows.map((row) => row.embedding ?? []);
    if (vectors.length !== texts.length || vectors.some((vector) => !vector.length)) {
      throw new Error(`the endpoint returned ${vectors.length} embedding(s) for ${texts.length} text(s)`);
    }
    return vectors;
  };
}
