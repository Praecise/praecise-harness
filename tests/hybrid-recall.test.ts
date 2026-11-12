/**
 * Recall asked two ways at once, and a second opinion on the order.
 *
 * Words and vectors find different things, and their scores have nothing in common, so
 * the two answers are joined by where each row came in its own list. Everything here
 * runs against the backend that keeps nothing past the process: it holds vectors and
 * has no text index, so the words half is the scan every backend without one takes.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agent, store } from "../src/define.js";
import type { Embedder } from "../src/harness/embed.js";
import { rerankerFor } from "../src/harness/rerank.js";
import { createApp } from "../src/sdk.js";
import { fuse, openStore } from "../src/stores/index.js";
import type { Reranker, Store } from "../src/stores/types.js";
import { MODEL_ENV, stubModel, systemText } from "./helpers.js";

const SPEC = { kind: "store", of: "vector", url: "memory:", dimensions: 2 } as const;
const now = Date.now();

async function filled(reranker?: Reranker): Promise<Store> {
  const kept = await openStore("kept", SPEC, { stateDir: "/x", reranker });
  await kept.remember([
    // Found by words only: it has no vector at all.
    { id: "words", text: "order 4021 was refunded in full", at: now },
    // Found by meaning only: it shares no word with the question.
    { id: "meaning", text: "the customer got their money back", at: now, vector: [1, 0] },
    // Found both ways.
    { id: "both", text: "refund for order 4021 approved", at: now, vector: [0.9, 0.1] },
    // Found neither way.
    { id: "neither", text: "shipping takes three days", at: now, vector: [0, 1] },
  ]);
  return kept;
}

describe("several orders made one", () => {
  it("puts what every list found above what one list put first", () => {
    const a = [{ id: "x" }, { id: "y" }, { id: "z" }];
    const b = [{ id: "y" }, { id: "w" }];
    const fused = fuse([a, b]);
    expect(fused.map((row) => row.id)).toEqual(["y", "x", "w", "z"]);
    // First in every list is the most a row can score, and reads as 1.
    expect(fuse([[{ id: "only" }], [{ id: "only" }]])[0]?.score).toBeCloseTo(1);
    expect(fused.every((row) => row.score > 0 && row.score <= 1)).toBe(true);
  });

  it("scores by place and not by what the list scored", () => {
    const fused = fuse([[{ id: "a", score: 0.001 }, { id: "b", score: 0.0001 }]]);
    expect(fused[0]?.score).toBeCloseTo(1);
    expect(fused[1]?.score).toBeCloseTo(61 / 62);
  });
});

describe("recall asked by words and by meaning", () => {
  it("finds what either would, and puts first what both did", async () => {
    const kept = await filled();
    const found = await kept.recall({ text: "refund order 4021", vector: [1, 0] });
    const ids = found.map((row) => row.id);
    expect(ids[0]).toBe("both");
    expect(ids).toContain("words");
    expect(ids).toContain("meaning");
    // A vector at right angles to the question is far, not opposite, so it is still
    // an answer by meaning — the last one.
    expect(ids.at(-1)).toBe("neither");
    await kept.close();
  });

  it("answers by words alone as it always did, and by a vector alone as it always did", async () => {
    const kept = await filled();
    expect((await kept.recall("refund order 4021")).map((row) => row.id).sort()).toEqual(["both", "words"]);
    expect((await kept.recall([1, 0])).map((row) => row.id).slice(0, 2)).toEqual(["meaning", "both"]);
    await kept.close();
  });

  it("lets the words answer alone when no vector came with them", async () => {
    const kept = await filled();
    const found = await kept.recall({ text: "refund order 4021" });
    expect(found.map((row) => row.id).sort()).toEqual(["both", "words"]);
    await kept.close();
  });

  it("never answers with a row that was taken back, whichever way it was found", async () => {
    const kept = await filled();
    await kept.redact({ id: "both" }, "[taken back]");
    const found = await kept.recall({ text: "refund order 4021", vector: [1, 0] });
    expect(found.map((row) => row.id)).not.toContain("both");
    await kept.close();
  });
});

describe("a second opinion on the order", () => {
  it("reorders what was found by what the reranker makes of each text", async () => {
    const asked: { query: string; documents: string[] }[] = [];
    const prefersMoney: Reranker = async (query, documents) => {
      asked.push({ query, documents });
      return documents.map((text) => (text.includes("money back") ? 0.9 : 0.1));
    };
    const kept = await filled(prefersMoney);
    const found = await kept.recall({ text: "refund order 4021", vector: [1, 0] });
    expect(found[0]?.id).toBe("meaning");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.query).toBe("refund order 4021");
    // What was found is what is sent to be scored again, each text once.
    expect([...asked[0]!.documents].sort()).toEqual([
      "order 4021 was refunded in full",
      "refund for order 4021 approved",
      "shipping takes three days",
      "the customer got their money back",
    ]);
    await kept.close();
  });

  it("is left out of one question when the question says so, and of a question with no words", async () => {
    let calls = 0;
    const counting: Reranker = async (_query, documents) => {
      calls++;
      return documents.map(() => 1);
    };
    const kept = await filled(counting);
    await kept.recall({ text: "refund order 4021", vector: [1, 0] }, { rerank: false });
    await kept.recall([1, 0]);
    expect(calls).toBe(0);
    await kept.close();
  });

  it("costs a question its second opinion, never its answer, when the reranker fails", async () => {
    const down: Reranker = async () => {
      throw new Error("rerank endpoint is down");
    };
    const short: Reranker = async () => [1];
    for (const reranker of [down, short]) {
      const kept = await filled(reranker);
      const found = await kept.recall({ text: "refund order 4021", vector: [1, 0] });
      expect(found[0]?.id).toBe("both");
      await kept.close();
    }
  });

  it("reads scores that are not relevances by their order", async () => {
    const logits: Reranker = async (_query, documents) =>
      documents.map((text) => (text.includes("money back") ? -0.5 : -7));
    const kept = await filled(logits);
    const found = await kept.recall({ text: "refund order 4021", vector: [1, 0] });
    expect(found[0]?.id).toBe("meaning");
    expect(found.every((row) => row.score >= 0 && row.score <= 1)).toBe(true);
    await kept.close();
  });
});

describe("the reranker an endpoint's config yields", () => {
  const providers = {
    house: { url: "https://models.test/v1", credential: "HOUSE_KEY", reranks: "rerank-small", headers: { "x-region": "eu" } },
  };

  it("is nothing where no endpoint names a rerank model, or none is reachable", () => {
    expect(rerankerFor({ house: { url: "https://models.test", credential: "HOUSE_KEY" } }, MODEL_ENV, fetch)).toBeUndefined();
    expect(rerankerFor(providers, {}, fetch)).toBeUndefined();
  });

  it("posts the query and the documents, and files each score against its own document", async () => {
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      // Best first, as the endpoints answer, which is not the order they were sent in.
      return new Response(
        JSON.stringify({ results: [{ index: 1, relevance_score: 0.8 }, { index: 0, relevance_score: 0.2 }] }),
        { status: 200 },
      );
    }) as typeof fetch;

    const scores = await rerankerFor(providers, MODEL_ENV, fetchImpl)!("which?", ["first", "second"]);
    expect(scores).toEqual([0.2, 0.8]);
    expect(seen[0]?.url).toBe("https://models.test/v1/rerank");
    expect(seen[0]?.body).toEqual({ model: "rerank-small", query: "which?", documents: ["first", "second"] });
    expect(seen[0]?.headers).toMatchObject({ authorization: "Bearer test-key", "x-region": "eu" });
  });

  it("says so when the endpoint did not score every document", async () => {
    const partial = (async () =>
      new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.5 }] }), { status: 200 })) as typeof fetch;
    await expect(rerankerFor(providers, MODEL_ENV, partial)!("q", ["a", "b"])).rejects.toThrow(/did not score every one of 2/);
  });
});

describe("an agent that remembers into a vector store", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "praecise-hybrid-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("is recalled by the exact words too, where the meaning points elsewhere", async () => {
    // Every exchange embeds to the same direction except the question, so meaning
    // alone cannot tell them apart and only the words can find the one about 4021.
    const flat: Embedder = async (texts) => texts.map(() => [1, 0]);
    const model = stubModel([
      { text: "Order 4021 shipped on Tuesday." },
      { text: "Our office is in Leeds." },
      { text: "We open at nine." },
      { text: "Tuesday." },
    ]);
    const app = await createApp(
      {
        root,
        config: { models: { house: { url: "https://models.test", credential: "HOUSE_KEY", speaks: "messages", fast: "small" } } },
        agents: { a: agent({ role: "Help.", quality: "fast", memory: { store: "kept" } }) },
        stores: { kept: store({ of: "vector", url: "memory:", dimensions: 2 }) },
      },
      { env: MODEL_ENV, fetch: model.fetch, embedder: flat },
    );

    await app.ask("a", "when did order 4021 ship?");
    await app.ask("a", "where is your office?");
    await app.ask("a", "what time do you open?");
    await app.ask("a", "remind me about order 4021");

    const told = systemText(model.calls.at(-1)?.body.system);
    expect(told.indexOf("Order 4021 shipped on Tuesday.")).toBeGreaterThan(-1);
    // Found by both, it is the first thing recalled rather than one of three equals.
    expect(told.indexOf("Order 4021 shipped on Tuesday.")).toBeLessThan(told.indexOf("Leeds") === -1 ? Infinity : told.indexOf("Leeds"));
  });
});
