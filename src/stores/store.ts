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
 * `recall` may be asked two ways at once. Words and vectors are scored on scales
 * that have nothing to do with each other — a text rank and a cosine cannot be
 * added — so the two answers are fused by where each row came in its own list
 * rather than by what it scored there. That is reciprocal rank fusion, and it is
 * here rather than in a driver for the reason everything else is: it is a
 * judgement, and every backend should make the same one.
 *
 * Redaction divides the verbs the same way. Something taken back is kept for
 * the record and never used to answer, so `history` still shows it and neither
 * `recall` nor `search` will hand it to anything. That is one rule written
 * here, and every backend gets it without being asked.
 */

import type { StoreKind } from "../define.js";
import { checked, type StandardSchemaV1 } from "../schema.js";
import { Facts, Series, Values } from "./models.js";
import type {
  Asked,
  Capabilities,
  Connection,
  Extras,
  Found,
  Item,
  Keep,
  Meta,
  Query,
  Ranked,
  RecallQuery,
  Reranker,
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
/**
 * How much a place in a list is worth less than the place before it.
 *
 * Sixty is the constant the method was published with and the one nearly every
 * implementation of it keeps: large enough that the first few places of either list
 * count about alike, so a row both lists found beats a row one list put first.
 */
const RRF_K = 60;

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

/** A driver is told which rows to look at and how many, and nothing about what happens after. */
const windowFor = (query: RecallQuery | undefined, limit: number): Window => {
  const { rerank: _rerank, ...which } = query ?? {};
  return { ...which, limit };
};

let counter = 0;
const newId = (): string =>
  `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Best row becomes 1, the rest are read against it. */
function normalise(ranked: Ranked[]): Found[] {
  const best = ranked.reduce((high, row) => Math.max(high, row.rank), 0);
  return ranked.map(({ rank, ...item }) => ({ ...item, score: best > 0 ? rank / best : 0 }));
}

const byScore = (a: Found, b: Found): number => b.score - a.score;

/**
 * Several orders of the same things, made one.
 *
 * Each list is best first. A row scores `1 / (k + place)` for every list it is in, so
 * what matters is where it came and not what it scored — which is what lets a text rank
 * and a cosine, numbers with nothing in common, be combined at all. The total is read
 * against the most a row could have (first in every list), so a score is still 0 to 1.
 */
export function fuse<Row extends { id: string }>(lists: readonly (readonly Row[])[], k = RRF_K): (Row & { score: number })[] {
  const total = new Map<string, { row: Row; score: number }>();
  for (const list of lists) {
    list.forEach((row, index) => {
      const held = total.get(row.id);
      const worth = 1 / (k + index + 1);
      if (held) held.score += worth;
      else total.set(row.id, { row, score: worth });
    });
  }
  const most = lists.length / (k + 1);
  return [...total.values()]
    .map(({ row, score }) => ({ ...row, score: most > 0 ? score / most : 0 }))
    .sort((a, b) => b.score - a.score);
}

/** Scores from a reranker, read against the best of them the way a backend's rank is. */
function rescaled(scores: readonly number[]): number[] {
  const best = Math.max(...scores);
  const worst = Math.min(...scores);
  // A relevance from 0 to 1 is kept in proportion. Anything else — logits, which may
  // be negative — only has an order, so it is spread between the worst and the best.
  if (worst >= 0) return scores.map((score) => (best > 0 ? score / best : 0));
  return scores.map((score) => (best > worst ? (score - worst) / (best - worst) : 1));
}

export class Kept<M extends object = Meta, In extends object = M> implements Store<M, In> {
  readonly name: string;
  readonly of: StoreKind;
  private readonly connection: Connection;
  /** Who this store is speaking as, where it is speaking as anyone. */
  private readonly writer?: string;
  private readonly schema?: StandardSchemaV1<unknown, object>;
  private readonly reranker?: Reranker;

  readonly values: Values;
  readonly facts: Facts;
  readonly series: Series;

  constructor(name: string, of: StoreKind, connection: Connection, writer?: string, extras: Extras = {}) {
    this.name = name;
    this.of = of;
    this.connection = connection;
    this.writer = writer;
    this.schema = extras.schema;
    this.reranker = extras.reranker;
    // Three more shapes of data over the same connection, written as whoever this store
    // is acting for. See models.ts for why they are verbs here and not three more backends.
    this.values = new Values(connection, writer);
    this.facts = new Facts(connection, writer);
    this.series = new Series(connection, writer);
  }

  get capabilities(): Capabilities {
    return this.connection.capabilities;
  }

  as(who: string): Store<M, In> {
    return new Kept<M, In>(this.name, this.of, this.connection, who, { schema: this.schema, reranker: this.reranker });
  }

  async remember(items: Keep<In> | Keep<In>[]): Promise<string[]> {
    const given = (Array.isArray(items) ? items : [items]) as Keep[];
    if (!given.length) return [];
    const batch = await this.checked(given);

    const carries = batch.some((item) => item.vector?.length);
    if (carries && !this.capabilities.vectors) {
      throw new Error(
        `store "${this.name}" cannot hold vectors — declare it \`of: "vector"\` against a ` +
          `backend that can, or leave the vector off`,
      );
    }

    // Where the backend makes ids of its own, the rows that came without one get
    // those, asked for once for the whole batch.
    const unnamed = batch.filter((item) => item.id === undefined).length;
    const minted =
      unnamed && this.connection.mint && this.capabilities.faster?.includes("ids")
        ? await this.connection.mint(unnamed)
        : [];

    const now = Date.now();
    const kept: Item[] = batch.map((item) => ({
      id: item.id ?? minted.shift() ?? newId(),
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

  /**
   * What the schema makes of each row's record, or the rows as they came.
   *
   * It is the record kept beside the text that is checked — `meta` — and what is kept
   * is what the validator returned, defaults and all. The whole batch is checked before
   * any of it is written, so a refusal leaves the store as it was.
   */
  private async checked(batch: Keep[]): Promise<Keep[]> {
    if (!this.schema) return batch;
    const records = await checked(
      this.schema,
      batch.map((item) => item.meta),
      `store "${this.name}"`,
    );
    return batch.map((item, index) => {
      const record = records[index];
      if (typeof record !== "object" || record === null || Array.isArray(record)) {
        throw new Error(
          `store "${this.name}": its schema returned something that is not an object, and a ` +
            `record is one — describe the record with an object schema`,
        );
      }
      return { ...item, meta: record as Meta };
    });
  }

  async recall(about: string | number[] | Asked, query?: RecallQuery): Promise<Found<M>[]> {
    const limit = clamp(query?.limit);
    const window = windowFor(query, Math.min(limit * POOL, MAX_LIMIT));
    const now = Date.now();

    const text = typeof about === "string" ? about : Array.isArray(about) ? undefined : about.text;
    const asked = Array.isArray(about) ? about : typeof about === "string" ? undefined : about.vector;
    // A vector means something only to a backend that holds them. Asked both ways of
    // one that does not, the words answer alone rather than the question being refused.
    const vector = asked?.length && (text === undefined || this.capabilities.vectors) ? asked : undefined;
    const matched = (found: Found[]): Found[] => found.filter((row) => row.score > 0 && !row.redactedAt);

    let candidates: Found[];
    if (text !== undefined && vector) {
      // One after the other, not at once: a connection inside a transaction carries
      // one statement at a time.
      const words = matched(await this.likeText(text, window)).sort(byScore);
      const meaning = matched(await this.likeVector(vector, window)).sort(byScore);
      candidates = fuse([words, meaning]);
    } else if (vector) {
      candidates = matched(await this.likeVector(vector, window));
    } else {
      candidates = matched(await this.likeText(text ?? "", window));
    }

    if (text !== undefined && this.reranker && query?.rerank !== false) {
      candidates = await this.reranked(text, candidates);
    }

    return candidates
      .map((found) => ({ ...found, score: found.score * (0.6 + 0.4 * recency(found.at, now)) }))
      .sort(byScore)
      .slice(0, limit) as Found<M>[];
  }

  /**
   * The candidates, scored again by something that reads the question and each text
   * together.
   *
   * It replaces how well each matched and nothing else: age is still weighed
   * afterwards, by the same rule. A reranker that fails, or answers with the wrong
   * number of scores, costs this one question its second opinion and not its answer.
   */
  private async reranked(text: string, candidates: Found[]): Promise<Found[]> {
    if (candidates.length < 2 || !this.reranker) return candidates;
    try {
      const scores = await this.reranker(
        text,
        candidates.map((row) => row.text),
      );
      if (scores.length !== candidates.length || scores.some((score) => !Number.isFinite(score))) return candidates;
      const read = rescaled(scores);
      return candidates.map((row, index) => ({ ...row, score: read[index]! }));
    } catch {
      return candidates;
    }
  }

  async search(terms: string, query?: Query): Promise<Found<M>[]> {
    const limit = clamp(query?.limit);
    const found = await this.likeText(terms, windowFor(query, limit));
    return found
      .filter((row) => row.score > 0 && !row.redactedAt)
      .sort(byScore)
      .slice(0, limit) as Found<M>[];
  }

  async history(query?: Query): Promise<Item<M>[]> {
    return (await this.connection.list(windowFor(query, clamp(query?.limit)))) as Item<M>[];
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
