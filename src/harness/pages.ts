/**
 * Subject pages: one page for each thing an agent keeps coming back to.
 *
 * Exchanges and working notes are kept in the order they happened, which is the right
 * order for a record and the wrong one for a question about a subject: everything known
 * about one customer is spread across forty entries, and a search returns the five that
 * share the most words with the question. A page gathers it. One subject, one page,
 * written from the entries that mention it and saying which they were.
 *
 * A page is something to be found and read, with a tool. It is never placed in front of
 * the model as an instruction, so writing one needs nobody's agreement, and it carries
 * the lowest authority of anything it was drawn from.
 *
 * One page is one document, and a page has one writer at a time. Whoever writes says which
 * revision they read; if the page has moved on since, the write is refused and nothing
 * is lost. Many subjects in one shared document would be the opposite arrangement: two
 * writers each replace the whole of it, and the second removes what the first added.
 */

import type { AgentPlan } from "../compile/plan.js";
import { authorityOf, type Remembered, type Origin } from "./memory.js";
import { Conflict, type Shelf } from "./shelf.js";
import type { Harness } from "./types.js";

export interface Page {
  /** The page's name in its folder: lowercase words joined by hyphens. */
  slug: string;
  title: string;
  body: string;
  /** The exchanges and working notes it was drawn from, most recently used last. */
  from: string[];
  /** The lowest authority of anything it was drawn from. */
  origin: Origin;
  /** When it was last written. */
  at: number;
  /** How many times it has been written. A writer says which one it read. */
  revision: number;
}

export type PageSummary = Pick<Page, "slug" | "title" | "origin" | "at" | "revision">;

/** What a writer hands over: the page as it should be. */
export type PageDraft = Pick<Page, "slug" | "title" | "body" | "from" | "origin">;

/** A page that changed between being read and being written. */
export class PageConflict extends Error {
  constructor(slug: string, read: number, why: string) {
    super(`the page "${slug}" was not written from revision ${read}: ${why}`);
    this.name = "PageConflict";
  }
}

/** The longest a page may be. Past this it is a second record, not a page. */
export const PAGE_LENGTH = 6_000;

/** The most sources a page lists. The oldest are let go first. */
const MOST_SOURCES = 60;

const TITLE_LENGTH = 120;

/** A name a page can be filed under, from whatever it was called. */
export function slugOf(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** What is kept of a page. Its revision is the document's own. */
type Stored = Omit<Page, "revision">;

const keyOf = (slug: string): string => {
  const safe = slugOf(slug);
  if (!safe) throw new Error("a page needs a name with a letter or a digit in it");
  return `pages/${safe}`;
};

export class Pages {
  private readonly shelf: Shelf;

  constructor(shelf: Shelf) {
    this.shelf = shelf;
  }

  async read(agent: string, slug: string): Promise<Page | undefined> {
    const held = await this.shelf.read<Stored>(agent, keyOf(slug));
    return held ? { ...held.value, revision: held.revision } : undefined;
  }

  /** Every page, oldest written first. */
  async all(agent: string): Promise<Page[]> {
    const pages: Page[] = [];
    for (const key of await this.shelf.keys(agent, "pages")) {
      const held = await this.shelf.read<Stored>(agent, key);
      if (held) pages.push({ ...held.value, revision: held.revision });
    }
    return pages.sort((a, b) => a.at - b.at || a.slug.localeCompare(b.slug));
  }

  async list(agent: string): Promise<PageSummary[]> {
    return (await this.all(agent)).map(({ slug, title, origin, at, revision }) => ({ slug, title, origin, at, revision }));
  }

  /**
   * Write a page, having read revision `read` of it (0 for a page that is new).
   *
   * Refused with `PageConflict` when the page is not at that revision any more.
   */
  async write(agent: string, draft: PageDraft, read: number): Promise<Page> {
    const slug = slugOf(draft.slug);
    const title = draft.title.trim().slice(0, TITLE_LENGTH);
    const body = draft.body.trim();
    if (!title) throw new Error(`the page "${slug}" needs a title`);
    if (!body) throw new Error(`the page "${slug}" has nothing on it`);
    if (body.length > PAGE_LENGTH) {
      throw new Error(`the page "${slug}" is ${body.length} characters; the most a page holds is ${PAGE_LENGTH}`);
    }
    if (!draft.from.length) throw new Error(`the page "${slug}" cites nothing, so nothing on it could be checked`);

    const page: Stored = {
      slug,
      title,
      body,
      from: [...new Set(draft.from)].slice(-MOST_SOURCES),
      origin: draft.origin,
      at: Date.now(),
    };
    try {
      const revision = await this.shelf.write(agent, keyOf(slug), page, read, `${title}\n${body}`);
      return { ...page, revision };
    } catch (err) {
      if (err instanceof Conflict) throw new PageConflict(slug, read, err.message);
      throw err;
    }
  }

  /** Pages that answer a search, best first. */
  async search(agent: string, query: string, limit = 5): Promise<Page[]> {
    const pages: Page[] = [];
    for (const key of await this.shelf.search(agent, "pages", query, limit)) {
      const held = await this.shelf.read<Stored>(agent, key);
      if (held) pages.push({ ...held.value, revision: held.revision });
    }
    return pages;
  }

  async remove(agent: string, slug: string): Promise<void> {
    await this.shelf.remove(agent, keyOf(slug));
  }

  /** The time of the last entry that has been filed. Everything after it is still to do. */
  async filedThrough(agent: string): Promise<number> {
    return (await this.shelf.read<{ at: number }>(agent, "filed"))?.value.at ?? 0;
  }

  /** Move the mark forward. It never goes back, whoever else is moving it. */
  async markFiled(agent: string, at: number): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const held = await this.shelf.read<{ at: number }>(agent, "filed");
      if (held && held.value.at >= at) return;
      try {
        await this.shelf.write(agent, "filed", { at }, held?.revision ?? 0);
        return;
      } catch (err) {
        if (!(err instanceof Conflict) || attempt >= 5) throw err;
      }
    }
  }
}

// ── Filing: turning what is new in the record into pages ───────────────────

/** The most subjects one pass files under. What is left over waits for the next. */
const MOST_SUBJECTS = 8;

/** The most entries one pass reads. */
const MOST_ENTRIES = 120;

const ENTRY_LENGTH = 1_200;

const SORTING = [
  "You are filing a record. Below are entries (exchanges an assistant had, and notes it",
  "wrote while working), each with an id, and the pages that already exist.",
  "",
  "Say which subjects these entries belong under. A subject is one thing somebody would",
  "look up by name: a customer, a system, a contract, a recurring task. Use an existing",
  "page where one fits, by its slug; name a new one only where several entries, or one",
  "entry with something lasting in it, are about a subject that has no page.",
  "",
  "Most entries belong under no subject, and an empty list is a correct answer. Do not",
  "file an entry under a subject it only mentions in passing.",
].join("\n");

const WRITING = [
  "You keep one page of a reference, about one subject. Below is the page as it stands",
  "(empty if it is new) and the entries that are to be filed on it, each with an id.",
  "",
  "Write the page as it should now read, whole. Keep what the page already says unless",
  "an entry shows it has changed; where one has, say what is true now and what it was",
  "before. Give names, numbers, dates and terms in the words the entries use: copy them,",
  "do not paraphrase them. Say only what the page or the entries say. After a statement",
  "taken from an entry, put that entry's id in square brackets.",
  "",
  "A page is shorter than what it was drawn from. Leave out the back and forth, and",
  "anything that is only true of one conversation.",
].join("\n");

/** Strip a plan down to something that only reads what it is handed. */
function clerk(plan: AgentPlan, name: string, instructions: string, returns: AgentPlan["returns"]): AgentPlan {
  return {
    ...plan,
    name: `${plan.name}:${name}`,
    description: "Files an agent's record onto subject pages.",
    instructions,
    services: [],
    locals: [],
    delegates: undefined,
    memory: false,
    memoryStore: undefined,
    memoryRecall: undefined,
    self: undefined,
    greeting: undefined,
    quality: "best",
    returns,
  };
}

const sorter = (plan: AgentPlan): AgentPlan =>
  clerk(plan, "file", SORTING, {
    subjects:
      'a list of { "slug": an existing page\'s slug or a short new name, "title": what the page is called, "entries": the ids filed under it }',
  });

const writer = (plan: AgentPlan): AgentPlan =>
  clerk(plan, "page", WRITING, { body: "the page as it should now read, as plain text" });

function renderEntry(kept: Remembered): string {
  const when = new Date(kept.at).toISOString().slice(0, 10);
  const trust = kept.origin === "external" ? ", carries text from outside the app" : "";
  if (kept.kind === "exchange") {
    return `[${kept.id}] exchange, ${when}${trust}\nasked: ${kept.input.slice(0, ENTRY_LENGTH)}\nanswered: ${kept.answer.slice(0, ENTRY_LENGTH)}`;
  }
  return `[${kept.id}] note, ${when}${trust}\nsubject: ${kept.subject}\n${kept.text.slice(0, ENTRY_LENGTH)}`;
}

export interface Filed {
  /** The pages written in this pass. */
  pages: PageSummary[];
  /** How many entries were read. */
  read: number;
  /** What went wrong, or was left for the next pass. */
  problems: string[];
  /**
   * The time of the last entry this pass dealt with, where it dealt with all it read.
   * Absent when something failed: the same entries are read again next time.
   */
  through?: number;
}

/**
 * File what is new in the record onto subject pages.
 *
 * One request sorts the entries into subjects, and then each page is written by a
 * request of its own that is shown that page and the entries filed on it in full. So a
 * page is never rewritten by something that was not shown it, and two subjects never
 * share a writer. Entries are handed over oldest first.
 */
export async function file(harness: Harness, plan: AgentPlan, pages: Pages, entries: Remembered[]): Promise<Filed> {
  const unread = entries.filter((kept) => !kept.redactedAt).sort((a, b) => a.at - b.at);
  const fresh = unread.slice(0, MOST_ENTRIES);
  const problems: string[] = [];
  if (!fresh.length) return { pages: [], read: 0, problems };
  if (unread.length > fresh.length) {
    problems.push(`${unread.length - fresh.length} newer entries were left for the next pass`);
  }
  let complete = true;

  const agent = plan.memoryAs ?? plan.name;
  const known = new Map(fresh.map((kept) => [kept.id, kept]));
  const existing = await pages.list(agent);
  const index = existing.length
    ? existing.map((page) => `- ${page.slug}: ${page.title}`).join("\n")
    : "(there are no pages yet)";

  let sorted: unknown;
  try {
    const answer = await harness.ask(
      sorter(plan),
      `Pages that exist:\n${index}\n\nEntries:\n\n${fresh.map(renderEntry).join("\n\n")}`,
    );
    sorted = (answer.data as { subjects?: unknown } | undefined)?.subjects;
  } catch (err) {
    return { pages: [], read: fresh.length, problems: [...problems, `could not sort the record: ${(err as Error).message}`] };
  }

  const subjects = new Map<string, { title: string; ids: string[] }>();
  for (const entry of Array.isArray(sorted) ? sorted : []) {
    if (!entry || typeof entry !== "object") continue;
    const { slug, title, entries: ids } = entry as { slug?: unknown; title?: unknown; entries?: unknown };
    if (typeof slug !== "string" || !slugOf(slug)) continue;
    const cited = (Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === "string" && known.has(id));
    // A subject nothing was filed under is one the model named and could not point to.
    if (!cited.length) continue;
    const key = slugOf(slug);
    const held = subjects.get(key) ?? { title: typeof title === "string" && title.trim() ? title.trim() : slug, ids: [] };
    held.ids.push(...cited);
    subjects.set(key, held);
  }
  if (subjects.size > MOST_SUBJECTS) {
    problems.push(`${subjects.size - MOST_SUBJECTS} subjects were not filed in this pass; the same entries are read again next time`);
    complete = false;
  }

  const written: PageSummary[] = [];
  for (const [slug, subject] of [...subjects].slice(0, MOST_SUBJECTS)) {
    const ids = [...new Set(subject.ids)];
    const filed = ids.map((id) => known.get(id)!);
    try {
      const current = await pages.read(agent, slug);
      const answer = await harness.ask(
        writer(plan),
        [
          `Subject: ${current?.title ?? subject.title}`,
          `The page as it stands:\n${current?.body ?? "(new page)"}`,
          `Entries to file:\n\n${filed.map(renderEntry).join("\n\n")}`,
        ].join("\n\n"),
      );
      const body = (answer.data as { body?: unknown } | undefined)?.body;
      if (typeof body !== "string" || !body.trim()) {
        problems.push(`nothing came back for the page "${slug}"; it was left as it is`);
        complete = false;
        continue;
      }
      const page = await pages.write(
        agent,
        {
          slug,
          title: current?.title ?? subject.title,
          body,
          from: [...(current?.from ?? []), ...ids],
          // A page is worth no more than the least trustworthy thing ever filed on it.
          origin: authorityOf([...(current ? [current.origin] : []), ...filed.map((kept) => kept.origin)]),
        },
        current?.revision ?? 0,
      );
      written.push({ slug: page.slug, title: page.title, origin: page.origin, at: page.at, revision: page.revision });
    } catch (err) {
      problems.push(`the page "${slug}" was not written: ${(err as Error).message}`);
      complete = false;
    }
  }

  return {
    pages: written,
    read: fresh.length,
    problems,
    ...(complete ? { through: fresh[fresh.length - 1]!.at } : {}),
  };
}
