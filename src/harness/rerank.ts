/**
 * A second opinion on what a store found, where an app has somewhere to ask for one.
 *
 * A text index and a vector index both score a candidate without reading it against
 * the question: one counts shared words, the other compares two summaries made
 * separately. A reranker reads the question and each candidate together, which is
 * slower and better, and is why it is asked about a short list rather than a store.
 *
 * It goes through the same seam embedding does. An endpoint may name the model it
 * reranks with, and where one does, what `recall` finds by its words is scored again
 * on the way out. An app with a reranker of its own hands a function over instead.
 * Nothing is reordered for an app that declared nothing, and a reranker that cannot be
 * reached costs a question its second opinion, never its answer.
 */

import type { ModelProvider } from "../define.js";
import { chooseProviders, type Env } from "../compile/models.js";
import type { Reranker } from "../stores/types.js";
import { ProviderError } from "./types.js";
import { retryAfterOf } from "./wire/http.js";

interface RerankRow {
  index?: number;
  relevance_score?: number;
  score?: number;
}

interface RerankPayload {
  results?: RerankRow[];
  data?: RerankRow[];
}

/**
 * A reranker for the first reachable endpoint that names a rerank model.
 *
 * The request is the one shape the endpoints that rerank have settled on:
 * `POST {url}/rerank` with a model, a query and a list of documents, answered with a
 * relevance for each document by its index. An endpoint that reranks some other way is
 * a `Reranker` an app writes and hands to `App.load`.
 */
export function rerankerFor(
  providers: Record<string, ModelProvider> | undefined,
  env: Env,
  fetchImpl: typeof fetch,
): Reranker | undefined {
  const chosen = chooseProviders(providers, env).find((entry) => entry.provider.reranks);
  if (!chosen) return undefined;
  const { provider, apiKey, baseUrl } = chosen;
  const url = `${baseUrl.replace(/\/+$/, "")}/rerank`;

  return async (query, documents, signal) => {
    if (!documents.length) return [];
    const credential = provider.credentialHeader ?? "authorization";
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        ...(apiKey ? { [credential]: provider.credentialHeader ? apiKey : `Bearer ${apiKey}` } : {}),
        "content-type": "application/json",
        ...provider.headers,
      },
      body: JSON.stringify({ model: provider.reranks, query, documents }),
      signal,
    });
    if (!response.ok) {
      throw new ProviderError("rerank", response.status, await response.text(), retryAfterOf(response.headers));
    }
    const payload = (await response.json()) as RerankPayload;
    // Results arrive best first, each naming the document it is about. They are put
    // back in the order the documents were sent, because a score filed against the
    // wrong text is a wrong answer given confidently.
    const scores = documents.map(() => Number.NaN);
    for (const row of payload.results ?? payload.data ?? []) {
      const score = row.relevance_score ?? row.score;
      if (typeof row.index === "number" && typeof score === "number") scores[row.index] = score;
    }
    if (scores.some((score) => Number.isNaN(score))) {
      throw new Error(`the endpoint did not score every one of ${documents.length} document(s)`);
    }
    return scores;
  };
}
