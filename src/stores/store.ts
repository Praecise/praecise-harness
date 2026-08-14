/**
 * What the four verbs mean, written once for every backend.
 *
 * The distinction worth keeping is between `recall` and `search`. `search` is a
 * question about text: it answers with what contains these words and does not
 * care when they were written. `recall` is a question about relevance, and
 * relevance decays — something said this morning is more likely to be what you
 * meant than the same sentence from a year ago. One is a lookup, the other is a
 * judgement, and flattening them into one verb makes the lookup imprecise and
 * the judgement inexplicable.
 *
 * Scores are normalised here rather than in the driver, because a backend's own
 * ranking has whatever range it has. Normalising against the best row in the
 * same answer makes a score readable within one result, and deliberately
 * meaningless across two.
 *
 * Redaction divides the verbs the same way. Something taken back is kept for
 * the record and never used to answer, so `history` still shows it and neither
 * `recall` nor `search` will hand it to anything. That is one rule written
 * here, and every backend gets it without being asked.
 */

import type { StoreKind } from "../define.js";
import type {
  Capabilities,
  Connection,
  Found,
  Item,
  Keep,
  Query,
  Ranked,
  ResultSet,
  Store,
  Window,
} from "./types.js";

/** How many a caller gets when it does not say. */
const DEFAULT_LIMIT = 20;
/** How many it can have at most, however many it asks for. */
const MAX_LIMIT = 500;
/**
 * How much wider than the answer the candidate pool is. Age is applied after
 * the backend has ranked, so the row that wins on recency has to be in the pool
 * to win at all.
 */
const POOL = 5;
/** A week-old thing counts half as much as a fresh one, when age counts. */
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been",
  "to", "of", "in", "on", "for", "with", "as", "at", "by", "from", "it", "this",
  "that", "i", "you", "we", "they", "do", "does", "did", "can", "could", "would",
  "should", "what", "how", "why", "when", "which", "my", "your",
]);

function tokenize(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((word) => word.length > 2 && !STOP_WORDS.has(word)));
}

/** Share of the asked-for terms this text contains. */
function overlap(wanted: Set<string>, text: string): number {
  if (!wanted.size) return 0;
  const present = tokenize(text);
  let hits = 0;
  for (const term of wanted) if (present.has(term)) hits++;
  return hits / wanted.size;
}

/** 1 for now, ½ for a week ago, and never quite 0. */
const recency = (at: number, now: number): number =>
  Math.pow(2, -Math.max(0, now - at) / HALF_LIFE_MS);

const clamp = (limit: number | undefined): number =>
  Math.min(Math.max(Math.trunc(limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);

const windowFor = (query: Query | undefined, limit: number): Window => ({ ...query, limit });

let counter = 0;
const newId = (): string =>
  `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Best row becomes 1, the rest are read against it. */
function normalise(ranked: Ranked[]): Found[] {
  const best = ranked.reduce((high, row) => Math.max(high, row.rank), 0);
  return ranked.map(({ rank, ...item }) => ({ ...item, score: best > 0 ? rank / best : 0 }));
}

const byScore = (a: Found, b: Found): number => b.score - a.score;

export class Kept implements Store {
  readonly name: string;
  readonly of: StoreKind;
  private readonly connection: Connection;
  /** Who this store is speaking as, where it is speaking as anyone. */
  private readonly writer?: string;

  constructor(name: string, of: StoreKind, connection: Connection, writer?: string) {
    this.name = name;
    this.of = of;
    this.connection = connection;
    this.writer = writer;
  }

  get capabilities(): Capabilities {
    return this.connection.capabilities;
  }

  as(who: string): Store {
    return new Kept(this.name, this.of, this.connection, who);
  }

  async remember(items: Keep | Keep[]): Promise<string[]> {
    const batch = Array.isArray(items) ? items : [items];
    if (!batch.length) return [];

    const carries = batch.some((item) => item.vector?.length);
    if (carries && !this.capabilities.vectors) {
      throw new Error(
        `store "${this.name}" cannot hold vectors — declare it \`of: "vector"\` against a ` +
          `backend that can, or leave the vector off`,
      );
    }

    const now = Date.now();
    const kept: Item[] = batch.map((item) => ({
      id: item.id ?? newId(),
      text: item.text,
      scope: item.scope,
      meta: item.meta,
      at: item.at ?? now,
      by: this.writer,
    }));

    // One statement can only carry so many values, and a caller handing over a
    // day of transcripts should not have to know that.
    const perItem = 6;
    const chunk = Math.max(1, Math.floor(this.capabilities.maxBindValues / perItem));
    for (let start = 0; start < kept.length; start += chunk) {
      const slice = kept.slice(start, start + chunk);
      await this.connection.put(
        slice,
        batch.slice(start, start + chunk).map((item) => item.vector),
      );
    }
    return kept.map((item) => item.id);
  }

  async recall(about: string | number[], query?: Query): Promise<Found[]> {
    const limit = clamp(query?.limit);
    const pool = Math.min(limit * POOL, MAX_LIMIT);
    const now = Date.now();

    const candidates =
      typeof about === "string"
        ? await this.likeText(about, windowFor(query, pool))
        : await this.likeVector(about, windowFor(query, pool));

    return candidates
      .map((found) => ({ ...found, score: found.score * (0.6 + 0.4 * recency(found.at, now)) }))
      .filter((found) => found.score > 0 && !found.redactedAt)
      .sort(byScore)
      .slice(0, limit);
  }

  async search(terms: string, query?: Query): Promise<Found[]> {
    const limit = clamp(query?.limit);
    const found = await this.likeText(terms, windowFor(query, limit));
    return found
      .filter((row) => row.score > 0 && !row.redactedAt)
      .sort(byScore)
      .slice(0, limit);
  }

  async history(query?: Query): Promise<Item[]> {
    return this.connection.list(windowFor(query, clamp(query?.limit)));
  }

  async forget(query: Query): Promise<number> {
    // Forgetting is asked for, not stumbled into: no limit means the whole
    // window, because a caller naming a scope means that scope.
    return this.connection.drop({ ...query, limit: query.limit ?? -1 });
  }

  async redact(query: Query, note: string): Promise<number> {
    if (!note.trim()) throw new Error("redacting leaves a note behind: say what to leave");
    return this.connection.redact({ ...query, limit: query.limit ?? -1 }, note, Date.now());
  }

  async query(sql: string, params?: readonly unknown[]): Promise<ResultSet> {
    return this.connection.run(sql, params);
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  /** The text index where there is one, and an honest scan where there is not. */
  private async likeText(terms: string, window: Window): Promise<Found[]> {
    if (this.capabilities.fullText) return normalise(await this.connection.match(terms, window));
    const wanted = tokenize(terms);
    const rows = await this.connection.list({ ...window, limit: MAX_LIMIT });
    return rows
      .map((item) => ({ ...item, score: overlap(wanted, item.text) }))
      .sort(byScore)
      .slice(0, window.limit);
  }

  private async likeVector(vector: number[], window: Window): Promise<Found[]> {
    if (!this.capabilities.vectors) {
      throw new Error(
        `store "${this.name}" cannot compare vectors — recall it by text, or point it at a ` +
          `backend that holds them`,
      );
    }
    // A cosine is already a 0-to-1 reading, so it is kept rather than
    // normalised: rescaling it against the best row would make a store holding
    // one poor match look like a store holding a perfect one.
    return (await this.connection.near(vector, window)).map(({ rank, ...item }) => ({
      ...item,
      score: rank,
    }));
  }
}
