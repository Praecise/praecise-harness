/**
 * Cross-conversation memory. Stored as one JSON file per agent under the
 * project's state directory, so it survives a restart with no database to run.
 *
 * Recall is lexical overlap decayed by age. That is deliberately modest: it
 * costs nothing, needs no embedding credential, and is enough for "we talked
 * about this before". An agent that needs more points its memory at a store,
 * which is the same two operations against a real index — same shape, so
 * nothing above has to know which one answered.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Item, Store } from "../stores/types.js";
import { DIR_MODE, FILE_MODE } from "../private.js";
import { budgetFor, clip } from "./budget.js";

export interface Episode {
  id: string;
  /** Conversation this came from, when the caller supplied one. */
  thread?: string;
  input: string;
  answer: string;
  /** Epoch milliseconds. */
  at: number;
  /** When it was taken back, if it was. What it says now is the note. */
  redactedAt?: number;
}

/** Remembering, however it is kept. */
export interface Recollection {
  recall(agent: string, query: string, limit?: number): Promise<Episode[]>;
  record(agent: string, episode: Omit<Episode, "id" | "at">): Promise<void>;
  /** The record itself, oldest first. For reading over, not for answering with. */
  all(agent: string, limit?: number): Promise<Episode[]>;
  /**
   * Take back one of these, leaving the note where it was.
   *
   * It stays in the record, at the time it happened, and stops being something
   * the agent can answer from. Deleting it would answer a different question —
   * "this never happened" rather than "this should not be used" — and the
   * second is nearly always the one being asked.
   */
  redact(agent: string, id: string, note: string): Promise<boolean>;
}

/** Recency half-life: a week-old episode counts half as much as a fresh one. */
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EPISODES = 500;
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been",
  "to", "of", "in", "on", "for", "with", "as", "at", "by", "from", "it", "this",
  "that", "i", "you", "we", "they", "do", "does", "did", "can", "could", "would",
  "should", "what", "how", "why", "when", "which", "my", "your",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

/**
 * How much a long episode is forgiven for being long. BM25's `b`, and its value —
 * length matters, but an episode is not disqualified for being thorough.
 */
const LENGTH_WEIGHT = 0.75;

/** A stand-in average when there is nothing to average over yet. */
const TYPICAL_TERMS = 60;

/**
 * How well an episode answers the query, decayed by age.
 *
 * The term count matters and used to be ignored. Counting only what fraction of the
 * QUERY was found measures recall and nothing else, so a long episode wins by
 * containing more words: a wrong but wordy neighbour scored more than twice the right
 * short one on a real store. That is not a small mis-ranking, it is a machine for
 * producing near-miss distractors — and near-misses are the ones that do the damage.
 * Topically-adjacent wrong context measurably drags an answer off course, while
 * genuinely unrelated text is close to harmless, so a recall-only score is optimising
 * for the single worst thing it could retrieve.
 *
 * The fix is the standard one: divide by how long the episode is relative to the
 * others, so a term found in a short episode counts for more than the same term
 * buried in a long one. `b` softens that, because an episode that is long BECAUSE it
 * is thorough should not be punished as hard as one that is long because it rambles.
 */
function score(query: Set<string>, episode: Episode, now: number, averageTerms: number): number {
  if (!query.size) return 0;
  const terms = tokenize(`${episode.input} ${episode.answer}`);
  let hits = 0;
  for (const term of query) if (terms.has(term)) hits++;
  if (!hits) return 0;

  const relative = terms.size / (averageTerms || TYPICAL_TERMS);
  const lengthPenalty = 1 - LENGTH_WEIGHT + LENGTH_WEIGHT * relative;
  const overlap = hits / query.size / lengthPenalty;
  const recency = Math.pow(2, -(now - episode.at) / HALF_LIFE_MS);
  return overlap * (0.6 + 0.4 * recency);
}

/** Mean term count across the episodes being searched, for the length penalty above. */
export function averageTermsOf(episodes: Episode[]): number {
  if (!episodes.length) return TYPICAL_TERMS;
  const total = episodes.reduce((sum, e) => sum + tokenize(`${e.input} ${e.answer}`).size, 0);
  return total / episodes.length;
}

export class Memory implements Recollection {
  private readonly cache = new Map<string, Episode[]>();

  constructor(private readonly dir: string) {}

  private file(agent: string): string {
    return join(this.dir, `${agent.replace(/[^\w.-]/g, "_")}.json`);
  }

  private async load(agent: string): Promise<Episode[]> {
    const cached = this.cache.get(agent);
    if (cached) return cached;
    let episodes: Episode[] = [];
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file(agent), "utf8"));
      if (Array.isArray(parsed)) episodes = parsed as Episode[];
    } catch {
      // No file yet, or it was corrupted — start clean rather than fail the run.
    }
    this.cache.set(agent, episodes);
    return episodes;
  }

  /** The most relevant prior exchanges, best first. */
  async recall(agent: string, query: string, limit = 3, minScore = 0.15): Promise<Episode[]> {
    const episodes = await this.load(agent);
    if (!episodes.length) return [];
    const now = Date.now();
    const terms = tokenize(query);
    const live = episodes.filter((episode) => !episode.redactedAt);
    // The penalty is relative to THIS agent's own episodes: what counts as a long
    // exchange differs between an agent that answers in a line and one that writes
    // reports, and a fixed constant would mis-rank whichever it was not tuned for.
    const average = averageTermsOf(live);
    return live
      .map((episode) => ({ episode, value: score(terms, episode, now, average) }))
      .filter(({ value }) => value >= minScore)
      .sort((a, b) => b.value - a.value)
      .slice(0, limit)
      .map(({ episode }) => episode);
  }

  /** Everything kept for this agent, oldest first. */
  async all(agent: string, limit = MAX_EPISODES): Promise<Episode[]> {
    return (await this.load(agent)).slice(-limit);
  }

  async record(agent: string, episode: Omit<Episode, "id" | "at">): Promise<void> {
    const episodes = await this.load(agent);
    episodes.push({
      ...episode,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
    });
    // Oldest first out, so the file stays bounded without a compaction pass.
    if (episodes.length > MAX_EPISODES) episodes.splice(0, episodes.length - MAX_EPISODES);
    await this.flush(agent, episodes);
  }

  async redact(agent: string, id: string, note: string): Promise<boolean> {
    const episodes = await this.load(agent);
    const episode = episodes.find((kept) => kept.id === id);
    if (!episode) return false;
    episode.input = note;
    episode.answer = note;
    episode.redactedAt = Date.now();
    await this.flush(agent, episodes);
    return true;
  }

  private async flush(agent: string, episodes: Episode[]): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    const target = this.file(agent);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(episodes, null, 2), { encoding: "utf8", mode: FILE_MODE });
    await rename(temp, target);
  }
}

/**
 * The same two operations against a declared store.
 *
 * An agent's name is the scope, so one store holds every agent's memory without
 * any of them seeing another's. The exchange is kept as one piece of text
 * because that is what a text index and a vector index both search; the two
 * halves are kept beside it so recall can hand back what was actually said
 * rather than the concatenation of it.
 */
export class StoredMemory implements Recollection {
  constructor(private readonly open: () => Promise<Store>) {}

  async recall(agent: string, query: string, limit = 3): Promise<Episode[]> {
    const store = await this.open();
    const found = await store.recall(query, { scope: agent, limit });
    return found.map(toEpisode);
  }

  async all(agent: string, limit = 200): Promise<Episode[]> {
    const store = await this.open();
    const found = await store.history({ scope: agent, limit });
    return found.map(toEpisode).reverse();
  }

  async record(agent: string, episode: Omit<Episode, "id" | "at">): Promise<void> {
    // Written as the agent, so what is in the store says which agent put it
    // there whether or not anything else in the row happens to mention it.
    const store = (await this.open()).as(agent);
    await store.remember({
      scope: agent,
      text: `${episode.input}\n\n${episode.answer}`,
      meta: { thread: episode.thread, input: episode.input, answer: episode.answer },
    });
  }

  async redact(agent: string, id: string, note: string): Promise<boolean> {
    const store = await this.open();
    return (await store.redact({ scope: agent, id }, note)) > 0;
  }
}

function toEpisode(item: Item): Episode {
  const meta = item.meta ?? {};
  const half = item.text.indexOf("\n\n");
  return {
    id: item.id,
    thread: typeof meta.thread === "string" ? meta.thread : undefined,
    input: typeof meta.input === "string" ? meta.input : item.text.slice(0, Math.max(0, half)),
    answer: typeof meta.answer === "string" ? meta.answer : item.text.slice(half + 2),
    at: item.at,
    redactedAt: item.redactedAt,
  };
}

/**
 * Render recalled episodes as an instruction block.
 *
 * The room is shared out between them rather than each one taking a fixed cut,
 * so three short exchanges come back whole where one long one is trimmed.
 */
export function renderRecall(episodes: Episode[], budget = budgetFor().recall): string {
  if (!episodes.length) return "";
  const each = Math.max(40, Math.floor(budget / episodes.length));
  const lines = episodes
    .map((episode) => {
      // The question is the smaller half of what makes an exchange findable
      // again, and the answer is the part worth having.
      const asked = clip(episode.input, Math.floor(each / 3));
      const said = clip(episode.answer, each - Math.floor(each / 3));
      return `- Earlier, asked "${asked}" — you answered: ${said}`;
    })
    .join("\n");
  return `Relevant things from earlier conversations. Use them if they help, ignore them if not:\n${lines}`;
}
