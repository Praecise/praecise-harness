/**
 * Knowledge that does not fit, still reachable.
 *
 * Everything in `memory/` goes into an agent's instructions, in order, until the
 * budget is spent. An app with more knowledge than fits used to lose whichever
 * files sorted last, with a warning and no way for the model to reach them.
 *
 * When the folder overflows, the model is instead given an outline of every
 * document (its name and its headings) and one tool to read a document or a
 * section of it. Documents that fit whole still go in whole. When everything
 * fits, none of this runs and the instructions are exactly what they were.
 *
 * The tool accepts only names and headings that exist. A name that does not
 * exist is answered with the names that do, never with a guess.
 */

import type { Doc } from "../project/load.js";
import { tokens } from "../harness/budget.js";

export const READ_KNOWLEDGE = "read_knowledge";

/** Share of the knowledge room the outline may take. */
const OUTLINE_SHARE = 0.25;

export interface Heading {
  level: number;
  title: string;
  /** Index of the heading's line in the document. */
  line: number;
}

/** ATX headings outside fenced code. */
export function headingsOf(content: string): Heading[] {
  const found: Heading[] = [];
  let fence: string | undefined;
  content.split(/\r?\n/).forEach((text, line) => {
    const mark = /^\s*(`{3,}|~{3,})/.exec(text);
    if (mark) {
      if (!fence) fence = mark[1]![0];
      else if (mark[1]![0] === fence) fence = undefined;
      return;
    }
    if (fence) return;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
    if (h) found.push({ level: h[1]!.length, title: h[2]!.trim(), line });
  });
  return found;
}

/** The text of one section: its heading to the next heading of the same or a higher level. */
export function sectionOf(content: string, title: string): string | undefined {
  const heads = headingsOf(content);
  const wanted = title.trim().toLowerCase();
  const at = heads.findIndex((h) => h.title.toLowerCase() === wanted);
  if (at < 0) return undefined;
  const lines = content.split(/\r?\n/);
  const start = heads[at]!;
  const end = heads.slice(at + 1).find((h) => h.level <= start.level);
  return lines.slice(start.line, end ? end.line : lines.length).join("\n").trim();
}

function outlineEntry(doc: Doc, withHeadings: boolean): string {
  const heads = headingsOf(doc.content);
  const size = `~${tokens(doc.content).toLocaleString()} tokens`;
  if (!withHeadings || !heads.length) return `- ${doc.name} (${size})`;
  const lines = heads.map((h) => `${"  ".repeat(h.level)}- ${h.title}`);
  return [`- ${doc.name} (${size})`, ...lines].join("\n");
}

export interface Packed {
  /** The reference material text, ready to place in the instructions. */
  text: string;
  /** Set when some documents are outline-only and the read tool is needed. */
  outlined: boolean;
  /** Documents left out entirely, when even the outline would not fit. */
  omitted: string[];
}

/**
 * Pack documents into `left` tokens. Whole while they fit; past that, whole for
 * the ones that still fit and outline-only for the rest.
 */
export function packKnowledge(docs: Doc[], left: number): Packed {
  const total = docs.reduce((sum, d) => sum + tokens(d.content), 0);
  if (total <= left) {
    return {
      text: docs.map((d) => `--- ${d.name} ---\n${d.content.trim()}`).join("\n\n"),
      outlined: false,
      omitted: [],
    };
  }

  // Outline of every document. Headings go in while they fit; names alone are the floor.
  const limit = Math.max(0, Math.floor(left * OUTLINE_SHARE));
  let entries = docs.map((d) => outlineEntry(d, true));
  if (tokens(entries.join("\n")) > limit) entries = docs.map((d) => outlineEntry(d, false));
  const shown: string[] = [];
  const omitted: string[] = [];
  let spent = 0;
  docs.forEach((d, i) => {
    const cost = tokens(entries[i]!);
    if (spent + cost > limit) omitted.push(d.name);
    else {
      shown.push(entries[i]!);
      spent += cost;
    }
  });

  // Whole documents, in order, into what the outline left. One that does not fit whole is
  // read through the tool instead of being cut mid-sentence.
  let room = left - spent;
  const whole: string[] = [];
  const inline = new Set<string>();
  for (const d of docs) {
    const cost = tokens(d.content);
    if (omitted.includes(d.name) || cost > room) continue;
    room -= cost;
    whole.push(`--- ${d.name} ---\n${d.content.trim()}`);
    inline.add(d.name);
  }

  const toRead = shown.length - [...inline].filter((n) => !omitted.includes(n)).length;
  const parts = [
    `Documents (${docs.length}). Those below under "Read in full" are already here; ` +
      `for any other, call ${READ_KNOWLEDGE} with its name, and a heading to read one section:`,
    shown.join("\n"),
  ];
  if (whole.length) parts.push("Read in full:", whole.join("\n\n"));
  return { text: parts.join("\n\n"), outlined: toRead > 0 || omitted.length > 0, omitted };
}

/** The tool that reads a document or one section of it. */
export function knowledgeTool(docs: Doc[]) {
  const byName = new Map(docs.map((d) => [d.name, d]));
  const names = [...byName.keys()];
  return {
    name: READ_KNOWLEDGE,
    description:
      "Read one of this app's documents, or one section of it by heading. " +
      "Only names from the document list exist.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", enum: names, description: "The document to read." },
        section: {
          type: "string",
          description: "A heading in that document, to read only that section.",
        },
      },
      required: ["name"],
    },
    effect: "read" as const,
    trust: "trusted" as const,
    run(args: Record<string, unknown>): string {
      const name = String(args.name ?? "");
      const doc = byName.get(name);
      if (!doc) return `No document named "${name}". Documents: ${names.join(", ")}.`;
      const section = typeof args.section === "string" ? args.section.trim() : "";
      if (!section) return doc.content.trim();
      const found = sectionOf(doc.content, section);
      if (found !== undefined) return found;
      const heads = headingsOf(doc.content).map((h) => h.title);
      return `"${name}" has no heading "${section}". Headings: ${heads.length ? heads.join("; ") : "none"}.`;
    },
  };
}
