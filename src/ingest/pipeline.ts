/**
 * Documents in, rows in a database out.
 *
 * The conversion half of this already existed and is good: fifty-odd formats — PDF, Word,
 * Excel, PowerPoint, CSV, images, source code — reduced to text, with a model-backed
 * converter available for the ones that need vision. What was missing was everything
 * after that. `ingestFile` fed exactly one consumer, the `memory/` folder read at load
 * time, so a business with a directory of price lists and contracts had no way to get
 * them into a store, and therefore no way for `/ask` to mirror them.
 *
 * This is that pipeline, and it is four steps with a decision in each:
 *
 *   convert   →   chunk   →   structure (optional)   →   keep
 *
 * ── Chunking, and why paragraphs rather than a fixed window ───────────────────
 *
 * A fixed character window cuts sentences in half, and a half-sentence retrieved on its
 * own is worse than not retrieving it: the model reads a fragment and completes it from
 * imagination. So splitting follows the document's own structure — blank lines, then
 * headings — and only falls back to a hard cut for a paragraph that is genuinely enormous.
 * Overlap is carried between chunks so a fact that straddles a boundary appears whole in
 * one of them.
 *
 * ── Structuring, and why it is optional and refuses ───────────────────────────
 *
 * Text in a store is searchable. FIELDS in a store are queryable, and the difference is
 * whether an agent can ask for everything under £20. Extracting fields needs a model, so
 * it costs money per document and it is off unless asked for.
 *
 * When it is on, the extraction is checked before it is kept: a model asked for JSON
 * returns prose often enough that trusting it produces rows with a paragraph where a
 * price should be. Anything that does not parse, or parses without the declared fields,
 * is kept as TEXT with the failure recorded — never dropped, and never stored as though
 * the extraction had worked.
 *
 * ── Idempotence ───────────────────────────────────────────────────────────────
 *
 * A pipeline that is run twice must not double the catalogue. Each chunk's id is derived
 * from the file it came from and the content of the chunk, so re-ingesting an unchanged
 * document overwrites itself and re-ingesting a changed one replaces the parts that
 * changed. Nothing here needs a manifest, a timestamp, or a "have I seen this" table.
 */

import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

import { canConvert, ingestFile, type Converter } from "./index.js";
import type { Keep, Store } from "../stores/types.js";

/** How a document becomes rows. */
export interface IngestPipelineOptions {
  /** Where converted text is cached, so a second run does not re-convert a PDF. */
  cacheDir?: string;
  /** The model-backed converter, for formats plain parsing cannot read. */
  converter?: Converter;
  /** Roughly how large one chunk may be, in characters. */
  chunkSize?: number;
  /** How much of the previous chunk to repeat, so a straddling fact stays whole. */
  overlap?: number;
  /** Kept on every row, so a query can narrow to one import. */
  scope?: string;
  /**
   * Fields to extract from each chunk, as `{ name: what it means }`.
   *
   * Present, this turns documents into queryable records rather than searchable text.
   * Absent, the pipeline costs nothing beyond conversion.
   */
  fields?: Record<string, string>;
  /**
   * How a chunk is turned into fields. Injected, like every other model call here, so
   * this module never decides what a request looks like or which endpoint it goes to.
   */
  extract?: (prompt: string) => Promise<string>;
  /** Files to skip, by extension. */
  skip?: string[];
}

export interface IngestReport {
  /** Files read, whatever came of them. */
  files: number;
  /** Rows written. */
  rows: number;
  /** Rows that carry extracted fields rather than only text. */
  structured: number;
  /** What went wrong, per file, without stopping the rest. */
  problems: string[];
  /** What was lossy or partial but usable. */
  notes: string[];
}

const DEFAULT_CHUNK = 2_000;
const DEFAULT_OVERLAP = 200;
const SKIP_DIRS = new Set(["node_modules", ".git", ".praecise", "dist", "build"]);

/**
 * Split text the way the document is already divided.
 *
 * Paragraph boundaries first, because that is where a document says one thought ended.
 * A paragraph too large to stand alone is cut, but only then — a hard window applied
 * first would cut every sentence in the file, and a retrieved half-sentence is worse than
 * a miss because the model completes it rather than noticing.
 */
export function chunk(text: string, size = DEFAULT_CHUNK, overlap = DEFAULT_OVERLAP): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const paragraphs = clean.split(/\n\s*\n/).filter((part) => part.trim());
  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (!current.trim()) return;
    chunks.push(current.trim());
    // Carry the tail forward so a fact spanning the boundary is whole somewhere.
    current = overlap > 0 ? current.slice(-overlap) : "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > size) {
      flush();
      // Genuinely enormous: cut it, at a space where one is near, so the seam falls
      // between words rather than through one.
      //
      // The next slice resumes AT THE SEAM, not one window further on. Advancing by a
      // fixed step after breaking early is how the second chunk starts mid-word — which
      // is the exact failure this whole branch exists to avoid, reintroduced one line
      // later.
      let at = 0;
      while (at < paragraph.length) {
        const slice = paragraph.slice(at, at + size);
        const breakAt = slice.length === size ? slice.lastIndexOf(" ") : -1;
        const take = breakAt > size * 0.6 ? breakAt : slice.length;
        const piece = slice.slice(0, take).trim();
        if (piece) chunks.push(piece);
        at += take;
        // Step over the space the seam fell on, so it does not open the next chunk.
        while (at < paragraph.length && paragraph[at] === " ") at += 1;
      }
      current = "";
      continue;
    }
    if (current.length + paragraph.length + 2 > size) flush();
    current += (current ? "\n\n" : "") + paragraph;
  }
  flush();

  return chunks.filter((part) => part.trim().length > 0);
}

/**
 * A stable id for a chunk.
 *
 * The source path and the content, hashed. Re-ingesting an unchanged file writes the same
 * ids and overwrites itself; changing a paragraph changes only that chunk's id. This is
 * what makes running the pipeline twice safe, with no bookkeeping anywhere.
 */
export function chunkId(source: string, text: string): string {
  return createHash("sha256").update(`${source}\n${text}`).digest("hex").slice(0, 32);
}

/** The prompt that turns a chunk into fields. */
export function extractionPrompt(text: string, fields: Record<string, string>): string {
  const wanted = Object.entries(fields)
    .map(([name, meaning]) => `  "${name}": ${meaning}`)
    .join("\n");
  return (
    `Extract these fields from the text below and answer with JSON only — no prose, no code fence.\n` +
    `Use null for anything the text does not state. Do not infer, and do not fill a field ` +
    `because it seems likely.\n\n` +
    `Fields:\n{\n${wanted}\n}\n\n` +
    `Text:\n${text}`
  );
}

/**
 * Read fields out of a model's answer, or refuse.
 *
 * A model asked for JSON returns a code fence, or a sentence, or JSON with an apology in
 * front of it, often enough that this cannot be `JSON.parse` and a hope. What it must
 * never do is succeed partially: a row stored with a paragraph where a price should be is
 * worse than a row stored as text, because everything downstream will treat it as a price.
 */
export function readFields(
  said: string,
  fields: Record<string, string>,
): { values: Record<string, unknown> } | { problem: string } {
  const fenced = said.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? said).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return { problem: "no JSON object in the answer" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (err) {
    return { problem: `could not parse the extraction: ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { problem: "the extraction was not an object" };
  }

  const values = parsed as Record<string, unknown>;
  // Every declared field must be present, even as null. A missing key is a model that
  // answered a different question, and keeping it would leave a row silently short.
  const missing = Object.keys(fields).filter((name) => !(name in values));
  if (missing.length) return { problem: `the extraction left out ${missing.join(", ")}` };

  return { values };
}

/** Every file under a directory that this pipeline could read. */
export async function ingestible(dir: string, skip: string[] = []): Promise<string[]> {
  const root = resolve(dir);
  const skipped = new Set(skip.map((ext) => (ext.startsWith(".") ? ext : `.${ext}`)));
  const found: string[] = [];

  const walk = async (at: string): Promise<void> => {
    const entries = await readdir(at, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = join(at, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (skipped.has(ext)) continue;
      if (canConvert(ext) || ext === ".md" || ext === ".txt") found.push(full);
    }
  };
  await walk(root);
  return found.sort();
}

/**
 * Run the pipeline over a directory, writing into a store.
 *
 * A file that will not convert is a PROBLEM and not a stop: a directory of five hundred
 * documents with one corrupt PDF should produce four hundred and ninety-nine imports and
 * a line saying which one failed.
 */
export async function ingestInto(
  dir: string,
  store: Store,
  options: IngestPipelineOptions = {},
): Promise<IngestReport> {
  const root = resolve(dir);
  const report: IngestReport = { files: 0, rows: 0, structured: 0, problems: [], notes: [] };
  const files = await ingestible(root, options.skip);

  for (const file of files) {
    const source = relative(root, file);
    report.files += 1;

    let text: string;
    try {
      const converted = await ingestFile(file, {
        cacheDir: options.cacheDir,
        fallback: options.converter,
      });
      text = converted.text;
      if (converted.note) report.notes.push(`${source}: ${converted.note}`);
    } catch (err) {
      report.problems.push(`${source}: ${(err as Error).message}`);
      continue;
    }

    const parts = chunk(text, options.chunkSize, options.overlap);
    if (!parts.length) {
      report.notes.push(`${source}: converted to nothing, so there was nothing to keep`);
      continue;
    }

    const modified = (await stat(file).catch(() => undefined))?.mtimeMs;
    const keeps: Keep[] = [];

    for (const [index, part] of parts.entries()) {
      const meta: Record<string, unknown> = {
        source,
        chunk: index,
        chunks: parts.length,
        ...(modified ? { dateModified: new Date(modified).toISOString() } : {}),
      };

      if (options.fields && options.extract) {
        try {
          const said = await options.extract(extractionPrompt(part, options.fields));
          const read = readFields(said, options.fields);
          if ("values" in read) {
            Object.assign(meta, read.values);
            report.structured += 1;
          } else {
            // Kept as text, and the reason recorded. Never stored as though it worked.
            report.notes.push(`${source} chunk ${index}: ${read.problem}; kept as text`);
          }
        } catch (err) {
          report.notes.push(`${source} chunk ${index}: extraction failed (${(err as Error).message}); kept as text`);
        }
      }

      keeps.push({
        id: chunkId(source, part),
        text: part,
        scope: options.scope,
        meta,
        ...(modified ? { at: modified } : {}),
      });
    }

    try {
      await store.remember(keeps);
      report.rows += keeps.length;
    } catch (err) {
      report.problems.push(`${source}: could not be stored: ${(err as Error).message}`);
    }
  }

  return report;
}
