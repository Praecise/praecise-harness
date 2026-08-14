/**
 * Any file in, text out.
 *
 * A model reads text, so everything else has to become text first. This does
 * that for the formats a project is actually likely to contain, keeps the
 * original as the source of truth, and writes each conversion to a cache keyed
 * by the file's content — so a document is converted once, and editing it
 * converts it again while leaving the old entry harmless.
 *
 * Four ways to convert, in the order they are tried: built in (here), a model
 * (for images, and for anything the built-ins decline), an MCP server you point
 * at, and the hosted service. Only the first needs no configuration.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { pdfToText } from "./pdf.js";
import { unzip } from "./unzip.js";

export interface Converted {
  text: string;
  /** Set when the conversion was lossy, empty, or fell back to something else. */
  note?: string;
}

/** Formats read verbatim — no conversion, and no cache entry needed. */
const VERBATIM = new Set([".md", ".markdown", ".txt", ".text", ".rst", ".adoc", ".log"]);

/** Source files, read verbatim but worth fencing so a model sees the language. */
const CODE = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".cs", ".php", ".sh", ".sql",
]);

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff"]);

export function isTextFormat(ext: string): boolean {
  return VERBATIM.has(ext) || CODE.has(ext);
}

/** Every extension something here knows how to read. */
export function canConvert(ext: string): boolean {
  return (
    isTextFormat(ext) ||
    IMAGE.has(ext) ||
    [
      ".json", ".jsonl", ".ndjson", ".csv", ".tsv", ".html", ".htm", ".xml",
      ".yaml", ".yml", ".toml", ".ini", ".pdf", ".docx", ".xlsx", ".pptx",
      ".vtt", ".srt",
    ].includes(ext)
  );
}

// ── Built-in converters ────────────────────────────────────────────────────

function stripTags(xml: string, blockTags: RegExp): string {
  return xml
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(blockTags, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToText(html: string): string {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  return stripTags(body, /<\/(?:p|div|li|tr|h[1-6]|section|article|br)\s*\/?>|<br\s*\/?>/gi);
}

/** A row per line, `column: value` — readable by a model without the header drift. */
function delimitedToText(raw: string, separator: string): string {
  const rows = parseDelimited(raw, separator);
  const header = rows.shift();
  if (!header) return "";
  if (!rows.length) return header.join(", ");
  return rows
    .map((row) => header.map((name, at) => `${name}: ${row[at] ?? ""}`).join(", "))
    .join("\n");
}

/** Split delimited text, honouring quoted fields and embedded newlines. */
function parseDelimited(raw: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let at = 0; at < raw.length; at++) {
    const char = raw[at]!;
    if (quoted) {
      if (char !== '"') field += char;
      else if (raw[at + 1] === '"') {
        field += '"';
        at++;
      }
      else quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === separator) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    }
    else if (char !== "\r") field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((value) => value !== ""));
}

function officeToText(ext: string, buf: Buffer): Converted {
  const files = unzip(buf);
  if (!files.size) return { text: "", note: "could not read the archive" };

  const read = (name: string): string => files.get(name)?.toString("utf8") ?? "";

  if (ext === ".docx") {
    const xml = read("word/document.xml");
    return { text: stripTags(xml, /<\/w:p>|<w:br\s*\/?>|<\/w:tr>/g) };
  }

  if (ext === ".pptx") {
    const slides = [...files.keys()]
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    const text = slides
      .map((name, at) => `--- slide ${at + 1} ---\n${stripTags(read(name), /<\/a:p>/g)}`)
      .join("\n\n");
    return { text };
  }

  // .xlsx — cells reference a shared string table by index.
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    stripTags(m[1]!, /<\/a:p>/g),
  );
  const sheets = [...files.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  const out: string[] = [];

  for (const name of sheets.sort()) {
    const rows = [...read(name).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
      [...row[1]!.matchAll(/<c[^>]*?(?:\st="(\w+)")?[^>]*>(?:<v>([\s\S]*?)<\/v>)?/g)]
        .map(([, type, value]) =>
          value === undefined ? "" : type === "s" ? (shared[Number(value)] ?? "") : value,
        )
        .join("\t"),
    );
    const filled = rows.filter((row) => row.replace(/\t/g, "").trim());
    if (filled.length) out.push(delimitedToText(filled.join("\n"), "\t"));
  }

  return { text: out.join("\n\n") };
}

/** Subtitle tracks: drop the cue numbers and timings, keep what was said. */
function captionsToText(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:\d+|WEBVTT|NOTE\b)/.test(line) && !line.includes("-->"))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function builtin(ext: string, buf: Buffer): Converted | undefined {
  if (VERBATIM.has(ext)) return { text: buf.toString("utf8") };
  if (CODE.has(ext)) return { text: `\`\`\`${ext.slice(1)}\n${buf.toString("utf8")}\n\`\`\`` };

  const raw = (): string => buf.toString("utf8");

  switch (ext) {
    case ".json":
      try {
        return { text: JSON.stringify(JSON.parse(raw()), null, 2) };
      } catch {
        return { text: raw(), note: "not valid JSON; included as text" };
      }
    case ".jsonl":
    case ".ndjson":
      return { text: raw() };
    case ".yaml":
    case ".yml":
    case ".toml":
    case ".ini":
      return { text: raw() };
    case ".csv":
      return { text: delimitedToText(raw(), ",") };
    case ".tsv":
      return { text: delimitedToText(raw(), "\t") };
    case ".html":
    case ".htm":
      return { text: htmlToText(raw()) };
    case ".xml":
      return { text: stripTags(raw(), /<\/(?:item|entry|record|row|p)>/gi) };
    case ".vtt":
    case ".srt":
      return { text: captionsToText(raw()) };
    case ".pdf": {
      const text = pdfToText(buf);
      return text
        ? { text }
        : { text: "", note: "no extractable text — the pages are probably scanned images" };
    }
    case ".docx":
    case ".xlsx":
    case ".pptx":
      return officeToText(ext, buf);
    default:
      return undefined;
  }
}

// ── The pipeline ───────────────────────────────────────────────────────────

/** Describes a file to whatever is doing the converting. */
export interface ConvertRequest {
  path: string;
  ext: string;
  bytes: Buffer;
}

/** A converter the built-ins hand off to: a model, an MCP server, the cloud. */
export type Converter = (request: ConvertRequest) => Promise<Converted>;

export interface IngestOptions {
  /** Directory for cached conversions. Omitted ⇒ convert every time. */
  cacheDir?: string;
  /** Consulted for images, and for anything the built-ins cannot read. */
  fallback?: Converter;
}

const hashOf = (buf: Buffer): string =>
  createHash("sha256").update(buf).digest("hex").slice(0, 32);

/**
 * Convert one file.
 *
 * The cache is keyed by content, not by path, so the same document under two
 * names is converted once and an edited document never reads a stale entry.
 */
export async function ingestFile(file: string, options: IngestOptions = {}): Promise<Converted> {
  const ext = extname(file).toLowerCase();
  const bytes = await readFile(file);

  // Text formats are already the answer; caching them would only cost a stat.
  if (isTextFormat(ext)) return builtin(ext, bytes)!;

  const cached = options.cacheDir
    ? await readFile(join(options.cacheDir, `${hashOf(bytes)}.txt`), "utf8").catch(() => undefined)
    : undefined;
  if (cached !== undefined) return { text: cached };

  let result = builtin(ext, bytes);

  const emptyOrImage = !result || (!result.text.trim() && IMAGE.has(ext));
  if ((emptyOrImage || IMAGE.has(ext)) && options.fallback) {
    const handed = await options
      .fallback({ path: file, ext, bytes })
      .catch((err: Error) => ({ text: "", note: `converter failed: ${err.message}` }));
    if (handed.text.trim()) result = handed;
    else if (!result) result = handed;
  }

  if (!result) {
    return { text: "", note: `no converter for "${ext}"` };
  }

  if (options.cacheDir && result.text) {
    await mkdir(options.cacheDir, { recursive: true }).catch(() => {});
    await writeFile(join(options.cacheDir, `${hashOf(bytes)}.txt`), result.text).catch(() => {});
  }

  return result;
}

export { pdfToText } from "./pdf.js";
export { unzip } from "./unzip.js";
