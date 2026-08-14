/**
 * A backend that keeps nothing past the process.
 *
 * Every test that wanted a store used to write its own version of this, and no
 * two of them agreed: one forgot that redaction clears the vector, another
 * handed back the row it was holding so a caller could edit the store by
 * editing what it had been given. Those are not test bugs. They are the same
 * mistakes a real driver makes, made where nothing would ever catch them.
 *
 * So it ships instead, and it is a driver like any other: the same interface,
 * the same rules, and the conformance suite runs against it. It is also worth
 * having on its own — a store declared `url: "memory:"` is a scratch store that
 * needs no file, no daemon and no cleanup, which is what an example wants.
 *
 * It has no text index, and says so, which means the store above it falls back
 * to scanning. That is the honest answer and the useful one: it is the path a
 * backend without a text index takes, and it gets exercised here.
 */

import type {
  Capabilities,
  ConnectOptions,
  Connection,
  Driver,
  Item,
  Ranked,
  ResultSet,
  Window,
} from "./types.js";

const CAPABILITIES: Capabilities = {
  // No statement and no bind values, so the only reason for a ceiling here is
  // to keep the store's batching path exercised rather than skipped.
  maxBindValues: 600,
  fullText: false,
  vectors: true,
  returning: true,
  // Rows, their metadata, their time and their vectors — the same four shapes
  // the file and the server hold, held in a list. Not `graph`: there is nothing
  // here to be an edge, and a store declaring one should hear that at the point
  // it declares it rather than get a list back and no warning.
  serves: ["sql", "vector", "document", "timeseries"],
  vectorSearch: "scan",
  detail:
    "kept in the process and gone with it; vectors are compared here, and `query` has no " +
    "language to answer in",
};

interface Held {
  item: Item;
  vector?: number[];
}

/** Cosine similarity, mapped from -1..1 onto 0..1 so every rank reads the same way. */
function cosine(a: readonly number[], b: readonly number[]): number {
  const width = Math.min(a.length, b.length);
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < width; i++) {
    dot += a[i]! * b[i]!;
    left += a[i]! * a[i]!;
    right += b[i]! * b[i]!;
  }
  if (!left || !right) return 0;
  return (dot / Math.sqrt(left * right) + 1) / 2;
}

/**
 * A copy, so that what a caller does with a row it was handed cannot reach the
 * row itself. A driver over a database gets this for free — the row crossed a
 * socket — and one that shares its objects would be the only place in the
 * framework where reading something is a way of writing it.
 */
const copy = (item: Item): Item => ({ ...item, meta: item.meta ? { ...item.meta } : undefined });

const within =
  (window: Window) =>
  (held: Held): boolean =>
    (window.id === undefined || held.item.id === window.id) &&
    (window.scope === undefined || held.item.scope === window.scope) &&
    (window.since === undefined || held.item.at >= window.since) &&
    (window.by === undefined || held.item.by === window.by);

/** A negative limit means the whole window, the same as it does in SQL. */
const bounded = <T>(rows: T[], limit: number): T[] => (limit < 0 ? rows : rows.slice(0, limit));

class MemoryConnection implements Connection {
  readonly capabilities = CAPABILITIES;

  private rows: Held[] = [];
  private readonly readOnly: boolean;

  constructor(options: ConnectOptions) {
    this.readOnly = options.readOnly ?? false;
  }

  private refuseWrites(): void {
    if (this.readOnly) throw new Error("this store is open read-only");
  }

  async install(): Promise<void> {}

  async put(items: Item[], vectors: (number[] | undefined)[]): Promise<void> {
    this.refuseWrites();
    items.forEach((item, index) => {
      const held: Held = { item: copy(item), vector: vectors[index]?.slice() };
      const at = this.rows.findIndex((known) => known.item.id === item.id);
      if (at >= 0) this.rows[at] = held;
      else this.rows.push(held);
    });
  }

  /** Newest first, and ties broken by what arrived later, so an order exists. */
  private narrow(window: Window): Held[] {
    return this.rows
      .map((held, index) => ({ held, index }))
      .filter(({ held }) => within(window)(held))
      .sort((a, b) => b.held.item.at - a.held.item.at || b.index - a.index)
      .map(({ held }) => held);
  }

  async list(window: Window): Promise<Item[]> {
    return bounded(this.narrow(window), window.limit).map(({ item }) => copy(item));
  }

  /**
   * There is no index here, which is why `fullText` is false and the store
   * above never calls this. It answers anyway rather than throwing: something
   * reaching a driver directly should get the honest scan, not an exception
   * about a capability it can already see is absent.
   */
  async match(terms: string, window: Window): Promise<Ranked[]> {
    const wanted = (terms.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (word) => word.length > 2,
    );
    if (!wanted.length) return [];
    const ranked: Ranked[] = [];
    for (const { item } of this.narrow(window)) {
      const text = item.text.toLowerCase();
      const hits = wanted.filter((word) => text.includes(word)).length;
      if (hits) ranked.push({ ...copy(item), rank: hits / wanted.length });
    }
    ranked.sort((a, b) => b.rank - a.rank);
    return bounded(ranked, window.limit);
  }

  async near(vector: number[], window: Window): Promise<Ranked[]> {
    const ranked = this.narrow(window)
      .filter((held) => held.vector?.length)
      .map((held) => ({ ...copy(held.item), rank: cosine(vector, held.vector!) }))
      .sort((a, b) => b.rank - a.rank);
    return bounded(ranked, window.limit);
  }

  async drop(window: Window): Promise<number> {
    this.refuseWrites();
    const going = new Set(bounded(this.narrow(window), window.limit));
    this.rows = this.rows.filter((held) => !going.has(held));
    return going.size;
  }

  async redact(window: Window, note: string, at: number): Promise<number> {
    this.refuseWrites();
    const taken = bounded(this.narrow(window), window.limit);
    for (const held of taken) {
      // The vector goes with the text, and so does the metadata. A row that can
      // still be found by what it used to say has not been taken back.
      held.item = { ...held.item, text: note, meta: undefined, redactedAt: at };
      held.vector = undefined;
    }
    return taken.length;
  }

  /**
   * There is no query language here and inventing one would be a worse answer
   * than saying so. Nothing the framework does goes through `run`; it is the
   * author's own statement, and an author who needs one wants a real backend.
   */
  async run(): Promise<ResultSet> {
    throw new Error(
      'a "memory" store has no query language — point it at a file or a server to use `query`',
    );
  }

  /** All of it or none of it, which here is a matter of keeping the old list. */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    const before = this.rows.map((held) => ({ ...held }));
    try {
      return await work();
    } catch (error) {
      this.rows = before;
      throw error;
    }
  }

  async close(): Promise<void> {
    this.rows = [];
  }
}

export const memoryDriver: Driver = {
  name: "memory",
  async connect(options: ConnectOptions): Promise<Connection> {
    const connection = new MemoryConnection(options);
    await connection.install();
    return connection;
  },
};
