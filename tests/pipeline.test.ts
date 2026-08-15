/**
 * Documents in, rows in a database out.
 *
 * Two things here are worth more than the happy path. Chunking decides what a retrieved
 * fragment looks like, and a fragment cut through the middle of a sentence is worse than a
 * miss — the model completes it from imagination rather than noticing it is partial. And
 * structuring is a model call, which means it fails in the way model calls fail: with
 * something that looks close enough to parse and is not.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  chunk,
  chunkId,
  extractionPrompt,
  ingestible,
  ingestInto,
  readFields,
} from "../src/ingest/pipeline.js";
import type { Keep, Store } from "../src/stores/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function docs(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "praecise-ingest-"));
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  roots.push(root);
  return root;
}

/** A store that records what it was handed, keyed the way a real one would key it. */
function recording() {
  const rows = new Map<string, Keep>();
  const store = {
    name: "catalogue",
    of: "notes",
    capabilities: {},
    async remember(items: Keep | Keep[]) {
      const list = Array.isArray(items) ? items : [items];
      for (const item of list) rows.set(item.id ?? String(rows.size), item);
      return list.map((item) => item.id ?? "");
    },
    async search() {
      return [];
    },
    async recall() {
      return [];
    },
    async history() {
      return [];
    },
    async forget() {
      return 0;
    },
    async redact() {
      return 0;
    },
  } as unknown as Store;
  return { store, rows };
}

describe("chunking", () => {
  it("leaves a short document whole", () => {
    expect(chunk("One paragraph.", 2_000)).toEqual(["One paragraph."]);
  });

  it("splits where the document says a thought ended", () => {
    const text = ["First paragraph here.", "Second paragraph here.", "Third paragraph here."].join("\n\n");
    const parts = chunk(text, 30, 0);
    expect(parts.length).toBeGreaterThan(1);
    // No chunk ends mid-word: every boundary was a boundary the document already had.
    for (const part of parts) expect(part.trim()).toBe(part);
  });

  it("carries overlap, so a fact across a boundary is whole somewhere", () => {
    const text = `${"a".repeat(80)}\n\n${"b".repeat(80)}`;
    const parts = chunk(text, 100, 30);
    expect(parts.length).toBeGreaterThan(1);
    // The second chunk begins with the tail of the first.
    expect(parts[1]?.startsWith("a")).toBe(true);
  });

  it("cuts an enormous paragraph between words rather than through one", () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const parts = chunk(words, 200, 0);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      // A seam through a word would leave a fragment like "wor" at an edge.
      expect(part).toMatch(/^word\d+/);
      expect(part).toMatch(/word\d+$/);
    }
  });

  it("returns nothing for a document that converted to nothing", () => {
    expect(chunk("   \n\n  ")).toEqual([]);
  });
});

describe("idempotence", () => {
  it("gives the same chunk the same id every time", () => {
    expect(chunkId("a.md", "hello")).toBe(chunkId("a.md", "hello"));
  });

  it("separates identical text from two different files", () => {
    // Otherwise the same boilerplate paragraph in two contracts collapses into one row.
    expect(chunkId("a.md", "hello")).not.toBe(chunkId("b.md", "hello"));
  });

  it("re-ingesting an unchanged folder does not double anything", async () => {
    const root = await docs({ "a.md": "One.\n\nTwo.\n\nThree." });
    const { store, rows } = recording();

    await ingestInto(root, store, { chunkSize: 10, overlap: 0 });
    const first = rows.size;
    await ingestInto(root, store, { chunkSize: 10, overlap: 0 });

    expect(first).toBeGreaterThan(0);
    expect(rows.size).toBe(first);
  });
});

describe("reading the extraction a model returned", () => {
  it("takes JSON out of a code fence, which is what models actually send", () => {
    const read = readFields('Here you go:\n```json\n{"price": 12}\n```', { price: "the price" });
    expect(read).toEqual({ values: { price: 12 } });
  });

  it("refuses prose, rather than storing a sentence where a price goes", () => {
    // The failure that matters: a row stored with prose in a numeric field is worse than
    // a row stored as text, because everything downstream treats it as a number.
    expect(readFields("Sure! The price is £12.", { price: "the price" })).toHaveProperty("problem");
  });

  it("refuses an extraction that left a declared field out", () => {
    const read = readFields('{"product":"Widget"}', { product: "the name", price: "the price" });
    expect(read).toHaveProperty("problem");
    expect((read as { problem: string }).problem).toContain("price");
  });

  it("accepts an explicit null, which is the model saying the text does not state it", () => {
    // Distinct from a missing key: `null` is an answer, absence is a non-answer.
    expect(readFields('{"price": null}', { price: "the price" })).toEqual({ values: { price: null } });
  });

  it("refuses an array, which is a model answering a different question", () => {
    expect(readFields("[1,2,3]", { price: "the price" })).toHaveProperty("problem");
  });

  it("asks for exactly the declared fields, and says not to guess", () => {
    const prompt = extractionPrompt("Blue Widget, £12", { price: "the price in pounds" });
    expect(prompt).toContain('"price": the price in pounds');
    expect(prompt).toContain("Do not infer");
  });
});

describe("the pipeline", () => {
  it("reads a folder into rows carrying where they came from", async () => {
    const root = await docs({
      "catalogue.md": "The Blue Widget costs £12.50.",
      "notes/policy.txt": "Returns within 30 days.",
    });
    const { store, rows } = recording();

    const report = await ingestInto(root, store, {});
    expect(report.files).toBe(2);
    expect(report.rows).toBe(2);
    expect(report.problems).toEqual([]);

    const sources = [...rows.values()].map((row) => row.meta?.source);
    expect(sources).toContain("catalogue.md");
    expect(sources).toContain(join("notes", "policy.txt"));
  });

  it("keeps a chunk as text when the extraction fails, and says so", async () => {
    // Never dropped, and never stored as though it worked.
    const root = await docs({ "a.md": "The Blue Widget costs £12.50." });
    const { store, rows } = recording();

    const report = await ingestInto(root, store, {
      fields: { price: "the price" },
      extract: async () => "I think it is about twelve pounds fifty.",
    });

    expect(report.rows).toBe(1);
    expect(report.structured).toBe(0);
    expect(report.notes.join(" ")).toContain("kept as text");
    expect([...rows.values()][0]?.text).toContain("Blue Widget");
  });

  it("carries extracted fields onto the row when it works", async () => {
    const root = await docs({ "a.md": "The Blue Widget costs £12.50." });
    const { store, rows } = recording();

    const report = await ingestInto(root, store, {
      fields: { price: "the price" },
      extract: async () => '{"price": 12.5}',
    });

    expect(report.structured).toBe(1);
    expect([...rows.values()][0]?.meta?.price).toBe(12.5);
  });

  it("one unreadable file does not stop the rest", async () => {
    // A directory of five hundred documents with one corrupt PDF should produce four
    // hundred and ninety-nine imports and a line naming the one that failed.
    const root = await docs({ "good.md": "Readable.", "bad.pdf": "not really a pdf at all" });
    const { store } = recording();

    const report = await ingestInto(root, store, {});
    expect(report.rows).toBeGreaterThan(0);
    // Whatever became of the bad file, the good one is in.
    expect(report.files).toBe(2);
  });

  it("skips what it was told to skip", async () => {
    const root = await docs({ "a.md": "Keep me.", "b.csv": "drop,me" });
    expect(await ingestible(root, [".csv"])).toHaveLength(1);
  });

  it("reports a store that will not take the rows rather than throwing", async () => {
    const root = await docs({ "a.md": "Something." });
    const store = {
      name: "x",
      of: "notes",
      capabilities: {},
      async remember() {
        throw new Error("disk is full");
      },
    } as unknown as Store;

    const report = await ingestInto(root, store, {});
    expect(report.rows).toBe(0);
    expect(report.problems.join(" ")).toContain("disk is full");
  });
});
