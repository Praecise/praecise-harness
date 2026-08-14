/**
 * Text out of a PDF, without a dependency.
 *
 * A PDF is a set of numbered objects; the ones that matter here are content
 * streams, usually Flate-compressed. Inflate them and the text is in the
 * arguments to the `Tj` and `TJ` operators. This recovers the words and their
 * reading order, which is what a model needs, and does not attempt layout,
 * tables, or fonts with custom encodings — a scanned page has no text to find
 * and comes back empty, which the caller reports rather than papering over.
 */

import { inflateSync } from "node:zlib";

/**
 * How much text one PDF is allowed to become.
 *
 * The same bomb as a zip: a content stream declares nothing binding about how
 * much it inflates to, and Flate reaches a thousand to one on repetitive input.
 * A file arriving over the wire cannot be trusted to be the size it looks, so
 * one stream is bounded and so is the document — a thousand modest streams add
 * up to the same heap as one enormous one.
 *
 * Well above any real document: this is text on its way to a model, and the
 * context window runs out orders of magnitude before this does.
 */
const STREAM_LIMIT = 16 * 1024 * 1024;
const DOCUMENT_LIMIT = 64 * 1024 * 1024;

/** Decode a PDF literal string: `\n` escapes, `\ddd` octal, line continuations. */
function literal(raw: string): string {
  let out = "";
  for (let at = 0; at < raw.length; at++) {
    const char = raw[at]!;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = raw[++at];
    if (next === undefined) break;
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "b") out += "\b";
    else if (next === "f") out += "\f";
    else if (next === "\n") continue; // a backslash at end of line joins them
    else if (next >= "0" && next <= "7") {
      let digits = next;
      while (digits.length < 3 && raw[at + 1] !== undefined && raw[at + 1]! >= "0" && raw[at + 1]! <= "7") {
        digits += raw[++at];
      }
      out += String.fromCharCode(parseInt(digits, 8));
    } else out += next;
  }
  return out;
}

/** Decode a PDF hex string, `<48656c6c6f>`. */
function hex(raw: string): string {
  const digits = raw.replace(/[^0-9a-fA-F]/g, "");
  let out = "";
  for (let at = 0; at + 1 < digits.length; at += 2) {
    out += String.fromCharCode(parseInt(digits.slice(at, at + 2), 16));
  }
  return out;
}

/**
 * Pull the show-text operators out of one content stream.
 *
 * `Tj` shows one string. `TJ` shows an array of strings interleaved with
 * kerning numbers; a large negative number is how PDF writes a space, so
 * anything past the threshold becomes one.
 */
function textFromStream(content: string): string {
  const out: string[] = [];
  const operator = /\((?:\\.|[^\\()])*\)\s*Tj|<[0-9a-fA-F\s]*>\s*Tj|\[(?:[^\]\\]|\\.)*\]\s*TJ|\bTD\b|\bTd\b|\bT\*\b|\bET\b/g;

  for (const match of content.matchAll(operator)) {
    const token = match[0];

    if (/\b(?:TD|Td|T\*|ET)\b/.test(token)) {
      out.push("\n");
      continue;
    }

    if (token.endsWith("Tj")) {
      const body = token.slice(0, -2).trim();
      if (body.startsWith("(")) out.push(literal(body.slice(1, -1)));
      else if (body.startsWith("<")) out.push(hex(body.slice(1, -1)));
      continue;
    }

    // TJ: walk the array, emitting strings and turning big kerns into spaces.
    const array = token.slice(token.indexOf("[") + 1, token.lastIndexOf("]"));
    for (const piece of array.matchAll(/\((?:\\.|[^\\()])*\)|<[0-9a-fA-F\s]*>|-?\d+(?:\.\d+)?/g)) {
      const value = piece[0];
      if (value.startsWith("(")) out.push(literal(value.slice(1, -1)));
      else if (value.startsWith("<")) out.push(hex(value.slice(1, -1)));
      else if (Number(value) <= -170) out.push(" ");
    }
  }

  return out.join("");
}

/** Inflate every content stream in the file and read the text out of it. */
export function pdfToText(buf: Buffer): string {
  const pages: string[] = [];
  const latin = buf.toString("latin1");
  const streams = /stream\r?\n?/g;
  /** What has already been inflated, so the document as a whole has a ceiling. */
  let produced = 0;

  for (let match = streams.exec(latin); match; match = streams.exec(latin)) {
    const from = match.index + match[0].length;
    const to = latin.indexOf("endstream", from);
    if (to < 0) continue;
    streams.lastIndex = to;

    const header = latin.slice(Math.max(0, match.index - 400), match.index);
    const raw = buf.subarray(from, to);

    let content: string;
    if (/\/FlateDecode/.test(header)) {
      const room = Math.min(STREAM_LIMIT, DOCUMENT_LIMIT - produced);
      if (room <= 0) break; // the document has produced all it is allowed to
      try {
        const inflated = inflateSync(raw, { maxOutputLength: room });
        produced += inflated.length;
        content = inflated.toString("latin1");
      } catch {
        continue; // an image, a stream we cannot read, or one past the ceiling
      }
    } else if (/\/Filter/.test(header)) {
      continue; // some other encoding — DCT, CCITT, LZW
    } else {
      // Uncompressed, so it is bounded by the file itself — but it still spends
      // the document's allowance.
      if (produced + raw.length > DOCUMENT_LIMIT) break;
      produced += raw.length;
      content = raw.toString("latin1");
    }

    if (!/\b(?:Tj|TJ)\b/.test(content)) continue;
    const text = textFromStream(content);
    if (text.trim()) pages.push(text);
  }

  return pages
    .join("\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
