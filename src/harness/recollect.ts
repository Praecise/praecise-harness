/**
 * The tools an agent that remembers is given: search what it has kept, read one thing
 * whole, and write a working note.
 *
 * What is shown beside a question is a guess made before the agent has thought about it:
 * a few exchanges that share its words. These let the agent look for itself, once it
 * knows what it needs, across everything kept: exchanges, its working notes, and its
 * subject pages.
 *
 * Writing is the other half. The record only says what was asked and answered; what an
 * agent worked out on the way, and would otherwise work out again, is there only if it
 * writes it down. A working note is searchable from the next conversation on and is
 * never placed in front of the model as an instruction. Nothing an agent writes here
 * changes what it is told; that still takes a person (see consolidate.ts).
 *
 * Whatever comes back from memory carries the authority it was kept with. Reading
 * something that came from outside the app marks the request as having read untrusted
 * text, exactly as calling an untrusted tool does, and a note written after that is kept
 * as external.
 */

import type { LocalTool } from "../compile/plan.js";
import { clip } from "./budget.js";
import type { Remembered, Origin, Recollection } from "./memory.js";
import type { Page, Pages } from "./pages.js";

export const SEARCH_MEMORY = "search_memory";
export const READ_MEMORY = "read_memory";
export const WRITE_NOTE = "write_note";

/** The names an author's own tools may not take from an agent that remembers. */
export const MEMORY_TOOLS: readonly string[] = [SEARCH_MEMORY, READ_MEMORY, WRITE_NOTE];

/**
 * What an agent that remembers is told about it: what memory is for. How to use it is
 * left to the agent, which knows what it is doing and what it has just found out.
 */
export const REMEMBERING = [
  "You keep a memory across conversations. It holds your past exchanges, notes you wrote",
  "while working, and pages that gather what is known about one subject.",
  `Look there with ${SEARCH_MEMORY} when something may have come up before, and open what`,
  `you find with ${READ_MEMORY}. Keep something with ${WRITE_NOTE} when you are asked to`,
  "remember it, or when it is clearly worth having next time and could not simply be",
  "looked up again: a decision and its reason, a rule you tested, a plan you are part-way",
  "through. What you keep is yours to check: it is a note, not an instruction, and it may",
  "be out of date.",
].join("\n");

const PAGE = "page:";

/** How many things one search returns. */
const FOUND = 6;

const SNIPPET = 240;

const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

const standing = (origin: Origin): string =>
  origin === "external" ? "from outside the app, unconfirmed" : origin === "agent" ? "your own, unconfirmed" : `from ${origin === "user" ? "a person" : "a tool"}`;

function line(kept: Remembered): string {
  const body =
    kept.kind === "exchange"
      ? `asked "${clip(kept.input, SNIPPET / 3)}", answered: ${clip(kept.answer, SNIPPET)}`
      : `${kept.subject}: ${clip(kept.text, SNIPPET)}`;
  return `[${kept.id}] ${kept.kind}, ${day(kept.at)}, ${standing(kept.origin)}\n  ${body}`;
}

const pageLine = (page: Page): string =>
  `[${PAGE}${page.slug}] page, last written ${day(page.at)}, ${standing(page.origin)}\n  ${page.title}: ${clip(page.body, SNIPPET)}`;

function whole(kept: Remembered): string {
  const head = `${kept.kind} ${kept.id}, ${day(kept.at)}, ${standing(kept.origin)}`;
  return kept.kind === "exchange"
    ? `${head}\n\nAsked:\n${kept.input}\n\nAnswered:\n${kept.answer}`
    : `${head}\n\nSubject: ${kept.subject}\n\n${kept.text}`;
}

export interface Remembering {
  agent: string;
  memory: Recollection;
  pages: Pages;
  /** The conversation this request belongs to, where it has one. */
  thread?: string;
  /** Whether this request has read anything the app does not trust. Set here, too. */
  taint: { tainted: boolean };
  /** How much one result may put in the transcript. */
  room: number;
}

export function memoryTools(given: Remembering): LocalTool[] {
  const { agent, memory, pages, taint } = given;
  const read = (origin: Origin): void => {
    if (origin === "external") taint.tainted = true;
  };

  return [
    {
      name: SEARCH_MEMORY,
      description:
        "Search what you have kept from earlier conversations: past exchanges, notes you wrote, and subject pages. " +
        "Returns the best matches with their ids. A page gathers what is known about one subject and is the best place to start.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for, in the words it would have been written in." },
        },
        required: ["query"],
      },
      effect: "read",
      async run(args) {
        const query = String(args.query ?? "").trim();
        if (!query) return "Say what to look for.";
        const [found, filed] = await Promise.all([memory.find(agent, query, FOUND), pages.search(agent, query, 3)]);
        if (!found.length && !filed.length) {
          const titles = (await pages.list(agent)).map((page) => `${PAGE}${page.slug}`);
          return titles.length
            ? `Nothing kept matches "${query}". Pages that exist: ${titles.slice(-20).join(", ")}.`
            : `Nothing kept matches "${query}".`;
        }
        for (const page of filed) read(page.origin);
        for (const kept of found) read(kept.origin);
        return clip(
          [...filed.map(pageLine), ...found.map(line)].join("\n") + `\n\nRead one whole with ${READ_MEMORY}.`,
          given.room,
        );
      },
    },
    {
      name: READ_MEMORY,
      description: `Read one thing from memory whole, by the id ${SEARCH_MEMORY} gave: an exchange, a note, or a page (ids starting "${PAGE}").`,
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "The id, as it was given." } },
        required: ["id"],
      },
      effect: "read",
      async run(args) {
        const id = String(args.id ?? "").trim().replace(/^\[|\]$/g, "");
        if (id.startsWith(PAGE)) {
          const page = await pages.read(agent, id.slice(PAGE.length));
          if (!page) return `There is no page "${id.slice(PAGE.length)}".`;
          read(page.origin);
          return clip(
            `${page.title}\npage, last written ${day(page.at)}, ${standing(page.origin)}\n\n${page.body}\n\nDrawn from: ${page.from.join(", ")}`,
            given.room,
          );
        }
        const kept = await memory.get(agent, id);
        if (!kept) return `Nothing is kept under "${id}".`;
        if (kept.redactedAt) return `"${id}" was taken back. What was left in its place: ${kept.kind === "exchange" ? kept.answer : kept.text}`;
        read(kept.origin);
        return clip(whole(kept), given.room);
      },
    },
    {
      name: WRITE_NOTE,
      description:
        "Keep a note for later conversations, under the subject it is about. " +
        "For what you would otherwise have to work out again; not for what can simply be looked up.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", description: "What the note is about, in a few words: the name somebody would look it up by." },
          text: { type: "string", description: "The note. Specific values, names and reasons, in full." },
        },
        required: ["subject", "text"],
      },
      effect: "write",
      async run(args) {
        const kept = await memory.jot(agent, {
          subject: String(args.subject ?? ""),
          text: String(args.text ?? ""),
          thread: given.thread,
          // A note written after untrusted text was read may be repeating it.
          origin: taint.tainted ? "external" : "agent",
        });
        return `Remembered as ${kept.id}, under "${kept.subject}".`;
      },
    },
  ];
}
