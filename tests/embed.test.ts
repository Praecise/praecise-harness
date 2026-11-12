/**
 * Remembering by meaning, where an app has an endpoint that embeds.
 *
 * A vector store with nothing to make vectors falls back to its text index, which
 * finds the exchange that shares words with the question and misses the one that said
 * the same thing differently. An endpoint that names an `embeds` model closes that —
 * and an embedding that cannot be had must never cost the memory itself.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agent, store } from "../src/define.js";
import { embedderFor, type Embedder } from "../src/harness/embed.js";
import { createApp } from "../src/sdk.js";
import { attachmentsIn } from "../src/server/index.js";
import { MODEL_ENV, stubModel, systemText } from "./helpers.js";

const CONFIG = {
  models: {
    house: { url: "https://models.test", credential: "HOUSE_KEY", speaks: "messages", fast: "small" },
  },
};

/** Two directions: anything about money back, and everything else. */
const meaning: Embedder = async (texts) =>
  texts.map((text) => (/refund|money back|reimburse/i.test(text) ? [1, 0] : [0, 1]));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "praecise-embed-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const definition = {
  config: CONFIG,
  agents: { a: agent({ role: "Help.", quality: "fast", memory: { store: "kept" } }) },
  stores: { kept: store({ of: "vector", url: "memory:", dimensions: 2 }) },
};

describe("an agent that remembers into a vector store", () => {
  it("recalls the exchange that meant the same thing, though it shares no words", async () => {
    const model = stubModel([
      { text: "Refunds take five business days." },
      { text: "Shipping is free over fifty pounds." },
      { text: "Five business days." },
    ]);
    const app = await createApp({ root, ...definition }, { env: MODEL_ENV, fetch: model.fetch, embedder: meaning });

    await app.ask("a", "how long does a refund take?");
    await app.ask("a", "what does delivery cost?");
    await app.ask("a", "when do I get my money back?");

    const told = systemText(model.calls.at(-1)?.body.system);
    expect(told).toContain("Refunds take five business days.");
  });

  it("still remembers, by words, when the embedding cannot be had", async () => {
    const down: Embedder = async () => {
      throw new Error("embedding endpoint is down");
    };
    const model = stubModel([{ text: "Refunds take five business days." }, { text: "Five days." }]);
    const app = await createApp({ root, ...definition }, { env: MODEL_ENV, fetch: model.fetch, embedder: down });

    await app.ask("a", "how long does a refund take?");
    const second = await app.ask("a", "how long does a refund take again?");

    expect(second.notes ?? []).not.toContain("could not read memory");
    expect(systemText(model.calls.at(-1)?.body.system)).toContain("Refunds take five business days.");
  });
});

describe("the embedder an endpoint's config yields", () => {
  const providers = {
    house: { url: "https://models.test/v1", credential: "HOUSE_KEY", embeds: "embed-small", headers: { "x-region": "eu" } },
  };

  it("is nothing when no endpoint names an embedding model", () => {
    expect(embedderFor(CONFIG.models, MODEL_ENV, fetch)).toBeUndefined();
    expect(embedderFor(providers, {}, fetch)).toBeUndefined();
  });

  it("posts the model and the texts, and files each vector against its own text", async () => {
    const sent: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
      // Out of order on purpose: the index says which text a row belongs to.
      return new Response(
        JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const vectors = await embedderFor(providers, MODEL_ENV, fetchImpl)!(["first", "second"]);

    expect(vectors).toEqual([[1, 0], [0, 1]]);
    expect(sent[0]!.url).toBe("https://models.test/v1/embeddings");
    expect(sent[0]!.body).toEqual({ model: "embed-small", input: ["first", "second"] });
    expect(sent[0]!.headers).toMatchObject({ authorization: "Bearer test-key", "x-region": "eu" });
  });

  it("refuses a reply that does not have a vector for every text", async () => {
    const short = (async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(embedderFor(providers, MODEL_ENV, short)!(["a", "b"])).rejects.toThrow(/1 embedding\(s\) for 2 text\(s\)/);
  });
});

describe("what a request body may send with a question", () => {
  it("keeps what says what it is and carries bytes or a fetchable address", () => {
    expect(
      attachmentsIn([
        { mime: "image/png", data: "aGVsbG8=" },
        { mime: "application/pdf", url: "https://example.com/a.pdf", name: "a.pdf" },
      ]),
    ).toEqual([
      { mime: "image/png", data: "aGVsbG8=" },
      { mime: "application/pdf", url: "https://example.com/a.pdf", name: "a.pdf" },
    ]);
  });

  it("drops an address only the server's own network could resolve, and anything unlabelled", () => {
    expect(
      attachmentsIn([
        { mime: "image/png", url: "http://169.254.169.254/latest/meta-data" },
        { mime: "image/png", url: "file:///etc/passwd" },
        { data: "aGVsbG8=" },
        { mime: "not a type", data: "aGVsbG8=" },
        "nonsense",
      ]),
    ).toBeUndefined();
    expect(attachmentsIn("nonsense")).toBeUndefined();
  });

  it("takes ten and no more", () => {
    const many = Array.from({ length: 14 }, () => ({ mime: "image/png", data: "aGVsbG8=" }));
    expect(attachmentsIn(many)).toHaveLength(10);
  });
});
