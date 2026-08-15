/**
 * The whole path, as one continuous run: documents on disk → a real store → an answer.
 *
 * Every piece of this was already tested in isolation, against a recording store or a
 * hand-built result list. That is exactly the arrangement in which the JOINS go untested,
 * and the joins are where the interesting failures live — a chunk written with metadata
 * the retriever does not read, a store whose search returns rows the compactor discards,
 * a schema.org type declared in config and never reaching the output.
 *
 * So this uses a real SQLite store on a real temporary file, writes real documents, and
 * asks a real question.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/sdk.js";
import { agent, store as declareStore } from "../src/define.js";
import { ingestInto } from "../src/ingest/pipeline.js";
import { ask } from "../src/server/ask.js";
import { MODEL_ENV, stubModel } from "./helpers.js";

const roots: string[] = [];
const stub = stubModel(Array.from({ length: 40 }, () => ({ text: "an answer from the catalogue" })));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CONFIG = {
  models: {
    house: {
      url: "https://models.test",
      credential: "HOUSE_KEY",
      speaks: "messages" as const,
      fast: "small",
      balanced: "mid",
      best: "large",
    },
  },
};

describe("a business's documents, mirrored for agents", () => {
  it("goes from files on disk to an answer, through a real store", async () => {
    const root = await mkdtemp(join(tmpdir(), "praecise-mirror-"));
    roots.push(root);
    await mkdir(join(root, "docs"), { recursive: true });

    await writeFile(
      join(root, "docs", "catalogue.md"),
      "The Blue Widget costs 12.50 and ships in two days.\n\n" +
        "The Green Widget costs 18.00 and is made from recycled steel.\n\n" +
        "Delivery is free on orders over 50.",
      "utf8",
    );
    await writeFile(
      join(root, "docs", "returns.txt"),
      "Returns are accepted within 30 days of delivery.",
      "utf8",
    );

    // An app with a real store declared, exactly as an author would.
    const app = await createApp(
      {
        name: "acme",
        root,
        config: {
          ...CONFIG,
          ask: { store: "catalogue", type: "Product", mode: "summarize", quality: "fast" },
        },
        agents: { support: agent({ role: "Answer from the catalogue.", description: "Answers product questions." }) },
        stores: { catalogue: declareStore({ of: "document" }) },
      },
      { env: MODEL_ENV, fetch: stub.fetch },
    );

    // ── ingest ───────────────────────────────────────────────────────────
    const catalogue = await app.store("catalogue");
    const report = await ingestInto(join(root, "docs"), catalogue, { chunkSize: 200, overlap: 0 });

    expect(report.problems).toEqual([]);
    expect(report.rows).toBeGreaterThan(0);

    // ── the store really holds it ────────────────────────────────────────
    const held = await catalogue.search("widget");
    expect(held.length).toBeGreaterThan(0);

    // ── ask, which is the join under test ────────────────────────────────
    const answered = await ask(
      app,
      { query: "how much is the blue widget" },
      { identified: true },
      app.project.config.ask ?? {},
    );

    // The rows came from the DOCUMENTS, not from the app's capability list.
    const fromDocs = answered.results.filter((r) => r.site === "catalogue");
    expect(fromDocs.length).toBeGreaterThan(0);
    expect(fromDocs.some((r) => r.description.includes("Blue Widget"))).toBe(true);

    // Declared in config, present in the output: an agent reads structured data.
    expect(fromDocs[0]?.schema_object["@type"]).toBe("Product");
    expect(fromDocs[0]?.schema_object["@context"]).toBe("https://schema.org");
    // The provenance the pipeline wrote survives all the way to the answer.
    expect(fromDocs[0]?.schema_object.source).toBe("catalogue.md");

    await app.close();
  });

  it("answers from the documents after a re-ingest, without doubling them", async () => {
    const root = await mkdtemp(join(tmpdir(), "praecise-mirror-"));
    roots.push(root);
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "a.md"), "The Blue Widget costs 12.50.", "utf8");

    const app = await createApp(
      {
        name: "acme",
        root,
        config: { ...CONFIG, ask: { store: "catalogue", type: "Product" } },
        agents: { support: agent({ role: "Answer.", description: "Answers." }) },
        stores: { catalogue: declareStore({ of: "document" }) },
      },
      { env: MODEL_ENV, fetch: stub.fetch },
    );

    const catalogue = await app.store("catalogue");
    await ingestInto(join(root, "docs"), catalogue, {});
    const once = (await catalogue.search("widget")).length;
    await ingestInto(join(root, "docs"), catalogue, {});
    const twice = (await catalogue.search("widget")).length;

    // Idempotence through a REAL store, not a Map that happens to key by id.
    expect(twice).toBe(once);

    const answered = await ask(app, { query: "blue widget" }, { identified: true }, app.project.config.ask ?? {});
    expect(answered.results.filter((r) => r.site === "catalogue")).toHaveLength(1);

    await app.close();
  });
});
