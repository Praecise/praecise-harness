/**
 * What an agent keeps between conversations, and how it is found again.
 *
 * Two things are kept here, and they are different on purpose:
 *
 *   exchanges      what was asked and what was answered, written by the runtime after
 *                  every answer. The record. Nothing here is the agent's opinion.
 *   working notes  what the agent chose to write down while it worked: a subject and a
 *                  few lines under it. Its own, unreviewed, and labelled as such.
 *
 * Neither is carried into a conversation as an instruction. A handful of exchanges that
 * share words with the question are shown beside it, and the rest is there to be
 * searched, by the agent, with a tool. What an agent is *told* on every request is a
 * third thing kept elsewhere (see consolidate.ts), and reaches it only after a person
 * agreed to it.
 *
 * By default all of it is files under the project's state directory, so it survives a
 * restart with no database to run. Recall over files is by shared words, weighted by
 * length and age. An agent that needs more points its memory at a store, which is the
 * same operations against a real index.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { Embedder } from "./embed.js";
import type { Found, Item, Store } from "../stores/types.js";
import { readState, updateState, type StateCipher } from "../private.js";
import { budgetFor, clip } from "./budget.js";

/**
 * Where something kept came from, and therefore how much it may weigh.
 *
 * A list of sources says where a claim passed through and not whether it was ever
 * entitled to be believed, so the label travels with the claim: what a person said
 * outranks what a tool returned, which outranks what the agent concluded, which
 * outranks anything that arrived from outside the app.
 */
export type Origin = "user" | "tool" | "agent" | "external";

/** Highest authority wins. */
export const RANK: Record<Origin, number> = { user: 3, tool: 2, agent: 1, external: 0 };

/**
 * The authority something drawn from these sources may carry: the lowest of them.
 *
 * A summary of one trusted source and one untrusted one is untrusted, because the claim
 * it makes may rest entirely on the untrusted half and nothing downstream can tell
 * which. Summarising must not be the step that raises what a claim is worth.
 */
export function authorityOf(sources: Origin[]): Origin {
  if (!sources.length) return "external";
  return sources.reduce((lowest, next) => (RANK[next] < RANK[lowest] ? next : lowest));
}

/** One exchange: what was asked, and what was answered. */
export interface Episode {
  id: string;
  /** Conversation this came from, when the caller supplied one. */
  thread?: string;
  input: string;
  answer: string;
  /** Epoch milliseconds. */
  at: number;
  /** When it was taken back, if it was. What it says now is the note left in its place. */
  redactedAt?: number;
  /**
   * `"external"` when anything the app does not trust was read while answering,
   * `"agent"` otherwise. A caller writing to the record itself says what it knows.
   */
  origin: Origin;
}

/** One working note: something the agent wrote down, under the subject it is about. */
export interface Jotting {
  id: string;
  subject: string;
  text: string;
  thread?: string;
  at: number;
  redactedAt?: number;
  origin: Origin;
}

/** Either kind, told apart. */
export type Remembered = ({ kind: "exchange" } & Episode) | ({ kind: "note" } & Jotting);

export type NewEpisode = Omit<Episode, "id" | "at">;
export type NewJotting = Omit<Jotting, "id" | "at">;

/** Remembering, however it is kept. */
export interface Recollection {
  /** The exchanges most relevant to a question, best first. What is shown beside it. */
  recall(agent: string, query: string, limit?: number): Promise<Episode[]>;
  record(agent: string, episode: NewEpisode): Promise<Episode>;
  /** The exchanges themselves, oldest first. For reading over, not for answering with. */
  all(agent: string, limit?: number): Promise<Episode[]>;
  /** Keep a working note. */
  jot(agent: string, note: NewJotting): Promise<Jotting>;
  /** The working notes, oldest first. */
  jotted(agent: string, limit?: number): Promise<Jotting[]>;
  /** Exchanges and working notes that answer a search, best first. */
  find(agent: string, query: string, limit?: number): Promise<Remembered[]>;
  /** One exchange or working note, whole. */
  get(agent: string, id: string): Promise<Remembered | undefined>;
  /**
   * Take back an exchange or a working note, leaving a note where it was.
   *
   * It stays in the record, at the time it happened, and stops being something the
   * agent can answer from. Deleting it would answer a different question ("this never
   * happened" where what is meant is "this should not be used").
   */
  redact(agent: string, id: string, note: string): Promise<boolean>;
  /** Everything kept for this agent, gone. */
  drop(agent: string): Promise<void>;
}

/** Recency half-life: a week-old exchange counts half as much as a fresh one. */
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** The most exchanges a file holds. The oldest go first. */
export const MAX_EPISODES = 500;

/**
 * The most working notes a file holds. The oldest go first: a working note that still
 * matters has been filed on a subject page or proposed as something to carry by then.
 */
export const MAX_JOTTINGS = 200;

const SUBJECT_LENGTH = 120;
const JOTTING_LENGTH = 2_000;

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been",
  "to", "of", "in", "on", "for", "with", "as", "at", "by", "from", "it", "this",
  "that", "i", "you", "we", "they", "do", "does", "did", "can", "could", "would",
  "should", "what", "how", "why", "when", "which", "my", "your",
]);

const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });

/** Anything that is not a letter, a digit, or a mark belonging to one. */
const BETWEEN = /[^\p{L}\p{N}\p{M}]+/u;

const SHORT_LATIN = /^[a-z0-9]{1,2}$/;

/**
 * The words of a piece of text, in whatever script it is written.
 *
 * Words are found the way the script itself separates them, so text with no spaces
 * between words is still split into them, and a letter keeps the marks written on it.
 * One- and two-character Latin words are dropped as noise; a single character of a
 * script that writes a word in one character is kept.
 */
export function termsOf(text: string): Set<string> {
  const terms = new Set<string>();
  for (const part of WORDS.segment(text.normalize("NFKC").toLowerCase())) {
    if (!part.isWordLike) continue;
    for (const word of part.segment.split(BETWEEN)) {
      if (!word || STOP_WORDS.has(word) || SHORT_LATIN.test(word)) continue;
      terms.add(word);
    }
  }
  return terms;
}

/** How much a long text is forgiven for being long. */
const LENGTH_WEIGHT = 0.75;

/** A stand-in average when there is nothing to average over yet. */
const TYPICAL_TERMS = 60;

/**
 * How well a text answers the query, decayed by age.
 *
 * The share of the query's words that were found, divided by how long the text is
 * relative to the others. Without that division a long text wins by containing more
 * words, and what it wins with is the near miss: the wordy neighbour on the same topic,
 * which is the worst thing to put in front of a model. The weight softens the penalty,
 * because a text that is long for being thorough should lose less than one that rambles.
 */
function score(query: Set<string>, text: string, at: number, now: number, averageTerms: number): number {
  if (!query.size) return 0;
  const terms = termsOf(text);
  let hits = 0;
  for (const term of query) if (terms.has(term)) hits++;
  if (!hits) return 0;

  const relative = terms.size / (averageTerms || TYPICAL_TERMS);
  const lengthPenalty = 1 - LENGTH_WEIGHT + LENGTH_WEIGHT * relative;
  const overlap = hits / query.size / lengthPenalty;
  const recency = Math.pow(2, -(now - at) / HALF_LIFE_MS);
  return overlap * (0.6 + 0.4 * recency);
}

const exchangeText = (episode: Episode): string => `${episode.input} ${episode.answer}`;
const jottingText = (note: Jotting): string => `${note.subject} ${note.text}`;

/** Mean word count across the texts being searched, for the length penalty above. */
function meanTerms(texts: string[]): number {
  if (!texts.length) return TYPICAL_TERMS;
  return texts.reduce((sum, text) => sum + termsOf(text).size, 0) / texts.length;
}

/** Best first, by how well each answers the query. */
export function rank<T>(
  query: string,
  entries: T[],
  textOf: (entry: T) => string,
  atOf: (entry: T) => number,
  floor: number,
): { entry: T; value: number }[] {
  const terms = termsOf(query);
  const now = Date.now();
  // The penalty is relative to what is being searched: what counts as long differs
  // between an agent that answers in a line and one that writes reports.
  const average = meanTerms(entries.map(textOf));
  return entries
    .map((entry) => ({ entry, value: score(terms, textOf(entry), atOf(entry), now, average) }))
    .filter(({ value }) => value > 0 && value >= floor)
    .sort((a, b) => b.value - a.value);
}

const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The folder everything kept for one agent lives in. */
export function memoryDir(dir: string, agent: string): string {
  return join(dir, "memory", agent.replace(/[^\w.-]/g, "_"));
}

/** What `jot` is given, made fit to keep. */
function tidy(note: NewJotting): NewJotting {
  const subject = note.subject.trim().slice(0, SUBJECT_LENGTH);
  const text = note.text.trim().slice(0, JOTTING_LENGTH);
  if (!subject) throw new Error("a working note is kept under a subject: say what it is about");
  if (!text) throw new Error("a working note says something: there was nothing to keep");
  return { ...note, subject, text };
}

export class Memory implements Recollection {
  private readonly dir: string;
  private readonly cipher?: StateCipher;

  constructor(
    dir: string,
    /** Seals each agent's files. With one set, a file that is not sealed is refused, not read. */
    cipher?: StateCipher,
  ) {
    this.dir = dir;
    this.cipher = cipher;
  }

  private file(agent: string, kind: "exchanges" | "working"): string {
    return join(memoryDir(this.dir, agent), `${kind}.json`);
  }

  private async exchanges(agent: string): Promise<Episode[]> {
    return (await readState<Episode[]>(this.file(agent, "exchanges"), this.cipher)) ?? [];
  }

  private async working(agent: string): Promise<Jotting[]> {
    return (await readState<Jotting[]>(this.file(agent, "working"), this.cipher)) ?? [];
  }

  async recall(agent: string, query: string, limit = 3, minScore = 0.15): Promise<Episode[]> {
    const live = (await this.exchanges(agent)).filter((episode) => !episode.redactedAt);
    return rank(query, live, exchangeText, (episode) => episode.at, minScore)
      .slice(0, limit)
      .map(({ entry }) => entry);
  }

  async all(agent: string, limit = MAX_EPISODES): Promise<Episode[]> {
    return (await this.exchanges(agent)).slice(-limit);
  }

  async record(agent: string, episode: NewEpisode): Promise<Episode> {
    const kept: Episode = { ...episode, id: newId("e"), at: Date.now() };
    await updateState<Episode[]>(this.file(agent, "exchanges"), this.cipher, () => [], (held) => {
      held.push(kept);
      // Oldest first out, so the file stays bounded.
      if (held.length > MAX_EPISODES) held.splice(0, held.length - MAX_EPISODES);
      return held;
    });
    return kept;
  }

  async jot(agent: string, note: NewJotting): Promise<Jotting> {
    const kept: Jotting = { ...tidy(note), id: newId("n"), at: Date.now() };
    await updateState<Jotting[]>(this.file(agent, "working"), this.cipher, () => [], (held) => {
      held.push(kept);
      if (held.length > MAX_JOTTINGS) held.splice(0, held.length - MAX_JOTTINGS);
      return held;
    });
    return kept;
  }

  async jotted(agent: string, limit = MAX_JOTTINGS): Promise<Jotting[]> {
    return (await this.working(agent)).slice(-limit);
  }

  async find(agent: string, query: string, limit = 5): Promise<Remembered[]> {
    const [exchanges, working] = await Promise.all([this.exchanges(agent), this.working(agent)]);
    const all: Remembered[] = [
      ...exchanges.map((episode) => ({ kind: "exchange" as const, ...episode })),
      ...working.map((note) => ({ kind: "note" as const, ...note })),
    ].filter((kept) => !kept.redactedAt);
    return rank(
      query,
      all,
      (kept) => (kept.kind === "exchange" ? exchangeText(kept) : jottingText(kept)),
      (kept) => kept.at,
      0,
    )
      .slice(0, limit)
      .map(({ entry }) => entry);
  }

  async get(agent: string, id: string): Promise<Remembered | undefined> {
    const episode = (await this.exchanges(agent)).find((kept) => kept.id === id);
    if (episode) return { kind: "exchange", ...episode };
    const note = (await this.working(agent)).find((kept) => kept.id === id);
    return note ? { kind: "note", ...note } : undefined;
  }

  async redact(agent: string, id: string, note: string): Promise<boolean> {
    let done = false;
    const at = Date.now();
    await updateState<Episode[]>(this.file(agent, "exchanges"), this.cipher, () => [], (held) => {
      const episode = held.find((kept) => kept.id === id);
      if (!episode) return undefined;
      episode.input = note;
      episode.answer = note;
      episode.redactedAt = at;
      done = true;
      return held;
    });
    if (done) return true;
    await updateState<Jotting[]>(this.file(agent, "working"), this.cipher, () => [], (held) => {
      const jotting = held.find((kept) => kept.id === id);
      if (!jotting) return undefined;
      jotting.text = note;
      jotting.redactedAt = at;
      done = true;
      return held;
    });
    return done;
  }

  async drop(agent: string): Promise<void> {
    await rm(this.file(agent, "exchanges"), { force: true });
    await rm(this.file(agent, "working"), { force: true });
  }
}

/** The scope an agent's working notes are kept under, beside its exchanges. */
const notesScope = (agent: string): string => `${agent}/notes`;

const originOf = (value: unknown): Origin =>
  value === "user" || value === "tool" || value === "agent" || value === "external" ? value : "external";

/**
 * The same operations against a declared store.
 *
 * An agent's name is the scope, so one store holds every agent's memory without any of
 * them seeing another's; its working notes sit under a scope of their own beside it. An
 * exchange is kept as one piece of text because that is what a text index and a vector
 * index both search, with the two halves beside it so recall hands back what was said.
 */
export class StoredMemory implements Recollection {
  private readonly open: () => Promise<Store>;
  private readonly embed?: Embedder;
  constructor(
    open: () => Promise<Store>,
    /** Turns text into a vector, where the app has an endpoint that does. */
    embed?: Embedder,
  ) {
    this.open = open;
    this.embed = embed;
  }

  /**
   * The vector for a piece of text, or nothing.
   *
   * Nothing when there is no embedder, when the store holds no vectors, and when the
   * embedding could not be had. The last is deliberate: an endpoint being down is a
   * reason to recall by words this once, not a reason to recall nothing.
   */
  private async vectorFor(store: Store, text: string): Promise<number[] | undefined> {
    if (!this.embed || !store.capabilities.vectors) return undefined;
    try {
      return (await this.embed([text]))[0];
    } catch {
      return undefined;
    }
  }

  /** Asked by meaning and by words at once where there is a vector, by words where not. */
  private async near(store: Store, scope: string, query: string, limit: number): Promise<Found[]> {
    const vector = await this.vectorFor(store, query);
    if (vector) {
      try {
        const near = await store.recall({ text: query, vector }, { scope, limit });
        if (near.length) return near;
      } catch {
        // A store that will not take this vector still has the words.
      }
    }
    return store.recall(query, { scope, limit });
  }

  async recall(agent: string, query: string, limit = 3): Promise<Episode[]> {
    const store = await this.open();
    return (await this.near(store, agent, query, limit)).map(toEpisode);
  }

  async all(agent: string, limit = 200): Promise<Episode[]> {
    const store = await this.open();
    return (await store.history({ scope: agent, limit })).map(toEpisode).reverse();
  }

  async record(agent: string, episode: NewEpisode): Promise<Episode> {
    // Written as the agent, so what is in the store says which agent put it there.
    const store = (await this.open()).as(agent);
    const text = `${episode.input}\n\n${episode.answer}`;
    const vector = await this.vectorFor(store, text);
    const at = Date.now();
    const [id] = await store.remember({
      scope: agent,
      text,
      at,
      meta: { thread: episode.thread, input: episode.input, answer: episode.answer, origin: episode.origin },
      ...(vector ? { vector } : {}),
    });
    return { ...episode, id: id!, at };
  }

  async jot(agent: string, note: NewJotting): Promise<Jotting> {
    const tidied = tidy(note);
    const store = (await this.open()).as(agent);
    const text = `${tidied.subject}\n\n${tidied.text}`;
    const vector = await this.vectorFor(store, text);
    const at = Date.now();
    const [id] = await store.remember({
      scope: notesScope(agent),
      text,
      at,
      meta: { thread: tidied.thread, subject: tidied.subject, text: tidied.text, origin: tidied.origin },
      ...(vector ? { vector } : {}),
    });
    return { ...tidied, id: id!, at };
  }

  async jotted(agent: string, limit = MAX_JOTTINGS): Promise<Jotting[]> {
    const store = await this.open();
    return (await store.history({ scope: notesScope(agent), limit })).map(toJotting).reverse();
  }

  async find(agent: string, query: string, limit = 5): Promise<Remembered[]> {
    const store = await this.open();
    const [exchanges, notes] = await Promise.all([
      this.near(store, agent, query, limit),
      this.near(store, notesScope(agent), query, limit),
    ]);
    return [
      ...exchanges.map((found) => ({ score: found.score, kept: { kind: "exchange" as const, ...toEpisode(found) } })),
      ...notes.map((found) => ({ score: found.score, kept: { kind: "note" as const, ...toJotting(found) } })),
    ]
      .filter(({ kept }) => !kept.redactedAt)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ kept }): Remembered => kept);
  }

  async get(agent: string, id: string): Promise<Remembered | undefined> {
    const store = await this.open();
    const [episode] = await store.history({ scope: agent, id, limit: 1 });
    if (episode) return { kind: "exchange", ...toEpisode(episode) };
    const [note] = await store.history({ scope: notesScope(agent), id, limit: 1 });
    return note ? { kind: "note", ...toJotting(note) } : undefined;
  }

  async redact(agent: string, id: string, note: string): Promise<boolean> {
    const store = await this.open();
    if ((await store.redact({ scope: agent, id }, note)) > 0) return true;
    return (await store.redact({ scope: notesScope(agent), id }, note)) > 0;
  }

  async drop(agent: string): Promise<void> {
    const store = await this.open();
    await store.forget({ scope: agent });
    await store.forget({ scope: notesScope(agent) });
  }
}

function toEpisode(item: Item): Episode {
  const meta = item.meta ?? {};
  const half = item.text.indexOf("\n\n");
  // A redacted row says what was left in its place, and nothing of what it said before.
  const redacted = item.redactedAt !== undefined;
  return {
    id: item.id,
    thread: typeof meta.thread === "string" ? meta.thread : undefined,
    input: !redacted && typeof meta.input === "string" ? meta.input : half < 0 ? item.text : item.text.slice(0, half),
    answer: !redacted && typeof meta.answer === "string" ? meta.answer : half < 0 ? item.text : item.text.slice(half + 2),
    at: item.at,
    redactedAt: item.redactedAt,
    origin: originOf(meta.origin),
  };
}

function toJotting(item: Item): Jotting {
  const meta = item.meta ?? {};
  const half = item.text.indexOf("\n\n");
  const redacted = item.redactedAt !== undefined;
  return {
    id: item.id,
    thread: typeof meta.thread === "string" ? meta.thread : undefined,
    subject: typeof meta.subject === "string" ? meta.subject : half < 0 ? "" : item.text.slice(0, half),
    text: !redacted && typeof meta.text === "string" ? meta.text : half < 0 ? item.text : item.text.slice(half + 2),
    at: item.at,
    redactedAt: item.redactedAt,
    origin: originOf(meta.origin),
  };
}

/**
 * Render recalled exchanges as an instruction block.
 *
 * The room is shared out between them, so three short exchanges come back whole where
 * one long one is trimmed.
 */
export function renderRecall(episodes: Episode[], budget = budgetFor().recall): string {
  if (!episodes.length) return "";
  const each = Math.max(40, Math.floor(budget / episodes.length));
  const lines = episodes
    .map((episode) => {
      // The question is the smaller half of what makes an exchange findable again, and
      // the answer is the part worth having.
      const asked = clip(episode.input, Math.floor(each / 3));
      const said = clip(episode.answer, each - Math.floor(each / 3));
      return `- Earlier, asked "${asked}" — you answered: ${said}`;
    })
    .join("\n");
  return `Relevant things from earlier conversations. Use them if they help, ignore them if not:\n${lines}`;
}
