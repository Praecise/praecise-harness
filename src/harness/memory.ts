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

export interface Episode {
  id: string;
  /** Conversation this came from, when the caller supplied one. */
  thread?: string;
  input: string;
  answer: string;
  /** Epoch milliseconds. */
  at: number;
}

/** Remembering, however it is kept. */
export interface Recollection {
  recall(agent: string, query: string, limit?: number): Promise<Episode[]>;
  record(agent: string, episode: Omit<Episode, "id" | "at">): Promise<void>;
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

/** Overlap of query terms present in the episode, decayed by age. */
function score(query: Set<string>, episode: Episode, now: number): number {
  if (!query.size) return 0;
  const terms = tokenize(`${episode.input} ${episode.answer}`);
  let hits = 0;
  for (const term of query) if (terms.has(term)) hits++;
  const overlap = hits / query.size;
  const recency = Math.pow(2, -(now - episode.at) / HALF_LIFE_MS);
  return overlap * (0.6 + 0.4 * recency);
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
    return episodes
      .map((episode) => ({ episode, value: score(terms, episode, now) }))
      .filter(({ value }) => value >= minScore)
      .sort((a, b) => b.value - a.value)
      .slice(0, limit)
      .map(({ episode }) => episode);
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

  private async flush(agent: string, episodes: Episode[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(agent);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(episodes, null, 2), "utf8");
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

  async record(agent: string, episode: Omit<Episode, "id" | "at">): Promise<void> {
    const store = await this.open();
    await store.remember({
      scope: agent,
      text: `${episode.input}\n\n${episode.answer}`,
      meta: { thread: episode.thread, input: episode.input, answer: episode.answer },
    });
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
  };
}

/** Render recalled episodes as an instruction block. */
export function renderRecall(episodes: Episode[]): string {
  if (!episodes.length) return "";
  const lines = episodes
    .map((e) => `- Earlier, asked "${e.input.slice(0, 200)}" — you answered: ${e.answer.slice(0, 400)}`)
    .join("\n");
  return `Relevant things from earlier conversations. Use them if they help, ignore them if not:\n${lines}`;
}
