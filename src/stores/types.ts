/**
 * Where a store's runtime is divided, and why it is divided there.
 *
 * A **driver** owns storage. It knows one backend's dialect, its bind syntax,
 * its index types, and how to make the tables this framework keeps its own
 * things in. A **store** owns meaning: what counts as relevant, how age is
 * weighed against likeness, how many rows a caller may have. Semantics are
 * written once and every backend gets them; nothing above this line knows SQL.
 *
 * The operations a driver implements are named, not textual. That is what makes
 * an agent-facing store safe by construction — a model asking to recall
 * something never composes a query, so there is no string for it to compose
 * badly. `run` is the one exception, and it is the author's escape hatch rather
 * than anything an agent reaches.
 *
 * Capabilities are declared, never inferred. A caller that wants to know
 * whether a backend can search text asks it, rather than testing which driver
 * it happens to be.
 */

import type { StoreKind } from "../define.js";

/** What one backend can do, so nothing has to guess from its name. */
export interface Capabilities {
  /** Most bound values one statement may carry. */
  maxBindValues: number;
  /** Is there a text index behind `match`, or only a scan? */
  fullText: boolean;
  /** Can it hold vectors and order by distance? */
  vectors: boolean;
  /** Can a write hand back the row it wrote? */
  returning: boolean;
  /**
   * Where the ordering by distance happens.
   *
   * `vectors` says whether a backend holds them at all; this says what it costs
   * to ask. `index` is the database doing the work behind a real index; `scan`
   * is every stored vector read and compared here, which is correct and a
   * hundred times slower once there are millions of them. The two are otherwise
   * indistinguishable from the outside, and a fallback nobody can see is the
   * kind that is discovered as a latency graph rather than as a decision.
   *
   * Absent where a driver does not say, which is not the same as `scan`.
   */
  vectorSearch?: "index" | "scan" | "none";
  /**
   * The families this backend can honestly answer for.
   *
   * A store declares a family; this is what the thing it was pointed at can
   * actually serve. Absent means the driver makes no claim, and nothing will
   * hold it to one — a brought backend written before this existed is not
   * refused for having no opinion.
   */
  serves?: readonly StoreKind[];
  /**
   * What was settled when the connection opened, in a sentence an operator can
   * act on: which path vectors take, which extension was found or was not, and
   * what installing it would change. Read it when a store is slower than it
   * looks like it should be.
   */
  detail?: string;
  /**
   * What this backend answers for itself rather than leaving to be worked out here.
   *
   * The data verbs are verbs over `list` and `put`, so every backend has them, and on
   * every backend they read a scope's rows and work the answer out in the process. A
   * backend that can do better says which of them it does better, and implements the
   * method that goes with the word:
   *
   *   "walk"     — `walk`: relationships followed by the database (recursive SQL)
   *   "buckets"  — `buckets`: a series grouped into windows by the database
   *   "ids"      — `mint`: ids the backend makes, ordered by time
   *   "validity" — a fact cannot be recorded as true over two periods that overlap,
   *                and it is the database that refuses it
   *
   * Declared, never inferred, and `conform` holds a driver to each word it uses: the
   * faster path has to give the answer the slow one gives.
   */
  faster?: readonly Faster[];
}

/** A path a backend may take over from the process. See `Capabilities.faster`. */
export type Faster = "walk" | "buckets" | "ids" | "validity";

/**
 * A result, shaped the way it arrives rather than the way it reads.
 *
 * Columns are named once instead of per row: a thousand rows is one header and
 * a thousand arrays, not a thousand objects with a thousand copies of the same
 * keys. `asObjects` puts it back the other way when a caller wants that.
 */
export interface ResultSet {
  columns: string[];
  rows: unknown[][];
  /** Rows the statement changed, where changing rows is what it did. */
  changed?: number;
}

/** A result, read as records. */
export function asObjects(result: ResultSet): Record<string, unknown>[] {
  return result.rows.map((row) =>
    Object.fromEntries(result.columns.map((column, index) => [column, row[index]])),
  );
}

/** What is kept alongside a row's text, when a store says nothing more exact. */
export type Meta = Record<string, unknown>;

/** Something kept in a store. `M` is the record a store with a schema declares. */
export interface Item<M extends object = Meta> {
  id: string;
  /** What it says. Every family can search this, whatever else it holds. */
  text: string;
  /** Whose it is — a conversation, a customer, a run. */
  scope?: string;
  /** Anything else worth keeping alongside it. */
  meta?: M;
  /** When it happened, in milliseconds. */
  at: number;
  /**
   * What put it there.
   *
   * There is no way to ask for this and no way to change it afterwards. It is
   * whoever the store was speaking as when the row was written, which is the
   * only reason it can be relied on: something asking to keep a row has no
   * field here to fill in, and so none to fill in wrongly.
   */
  by?: string;
  /** When it was taken back, if it was. What it says now is the note. */
  redactedAt?: number;
}

/** Something to keep. Anything the store can decide for itself is optional. */
export interface Keep<M extends object = Meta> {
  id?: string;
  text: string;
  scope?: string;
  meta?: M;
  at?: number;
  /**
   * A precomputed embedding. Supplied rather than derived, because deriving one
   * costs a credential the framework does not require you to have.
   */
  vector?: number[];
}

/** Something found, and how well it matched. */
export interface Found<M extends object = Meta> extends Item<M> {
  /** 0 to 1, comparable within one result and not across two. */
  score: number;
}

/** Which things to look at. Every verb narrows the same way. */
export interface Query {
  /** Only this one. */
  id?: string;
  /** Only within this scope. */
  scope?: string;
  /** Only things at least this recent, in milliseconds. */
  since?: number;
  /** Only what this one wrote. */
  by?: string;
  /**
   * At most this many. Clamped rather than refused: a caller that asks for a
   * million rows wants as many as it can have, not an error.
   */
  limit?: number;
}

/** What `recall` may also be told, beyond which rows to look at. */
export interface RecallQuery extends Query {
  /** Set false to leave the store's reranker out of this one question. */
  rerank?: boolean;
}

/**
 * A question asked both ways at once: by its words and by its meaning.
 *
 * The two find different things. Words find the exact name, the order number, the term
 * nobody paraphrases; a vector finds the exchange that said the same thing differently.
 * Asked with both, a store looks each way and fuses the two orders by rank.
 */
export interface Asked {
  text: string;
  /** The embedding of `text`. Left out, or on a store that holds none, the words answer alone. */
  vector?: number[];
}

/**
 * A second opinion on an order: the question and the candidate texts in, one score per
 * candidate out, in the same order, higher meaning more relevant.
 *
 * A function an app supplies, or the one `rerankerFor` makes from an endpoint that
 * names a rerank model. The framework names no model.
 */
export type Reranker = (query: string, documents: string[], signal?: AbortSignal) => Promise<number[]>;

/** A query with its limit already settled, which is what a driver is given. */
export interface Window extends Query {
  limit: number;
}

/**
 * A walk over facts, asked of the backend.
 *
 * A fact is a row whose `meta` holds `subject`, `predicate` and `object` as strings,
 * and `validFrom`/`validTo` as numbers where it has them — the shape `Facts` writes.
 */
export interface Walk {
  /** The scope the facts are rows of, exactly as the rows carry it. */
  scope: string;
  /** Where the walk begins. */
  from: string;
  /** How many facts away to go, already clamped. */
  depth: number;
  direction: "out" | "in" | "both";
  /** Follow only facts with this predicate. */
  predicate?: string;
  /** Follow only facts true at this moment. Left out: every fact ever recorded. */
  at?: number;
}

/** Somewhere a walk reached: the node, how far it was, and the row of the fact that led there. */
export interface Step {
  node: string;
  depth: number;
  item: Item;
}

/**
 * A series grouped into windows, asked of the backend.
 *
 * A reading is a row whose `meta.value` is a number and whose `at` is its time — the
 * shape `Series` writes. Windows are aligned to the epoch and named by their start.
 */
export interface Buckets {
  scope: string;
  /** How wide a window is, in whole milliseconds. */
  width: number;
  aggregate: "mean" | "min" | "max" | "sum" | "count" | "first" | "last";
  /** From this moment, inclusive. */
  from?: number;
  /** To this moment, exclusive. */
  to?: number;
}

export interface Bucket {
  /** The start of the window. */
  at: number;
  value: number;
}

/** What the driver hands back: the row, and the backend's own opinion of it. */
export interface Ranked extends Item {
  /** Whatever the backend scored it. Higher is better; the range is its own. */
  rank: number;
}

/**
 * One open connection to one backend.
 *
 * Everything but `run` is a named operation over the tables this framework
 * owns. `run` is the author's own SQL, passed through untouched.
 */
export interface Connection {
  readonly capabilities: Capabilities;
  /** Make the framework's own tables, if they are not there yet. */
  install(): Promise<void>;
  /** Keep these. Ids are already decided. */
  put(items: Item[], vectors: (number[] | undefined)[]): Promise<void>;
  /** Everything in the window, newest first. */
  list(window: Window): Promise<Item[]>;
  /** Things whose text matches these terms, best first. */
  match(terms: string, window: Window): Promise<Ranked[]>;
  /** Things nearest this vector. Only when `capabilities.vectors`. */
  near(vector: number[], window: Window): Promise<Ranked[]>;
  /** Forget everything in the window. Answers with how many went. */
  drop(window: Window): Promise<number>;
  /**
   * Take back what everything in the window said, leaving the note in its
   * place and the row where it was. Answers with how many were taken back.
   */
  redact(window: Window, note: string, at: number): Promise<number>;
  /** The author's own statement. Not something an agent reaches. */
  run(sql: string, params?: readonly unknown[]): Promise<ResultSet>;
  /** Run several as one, undoing all of them if any of them fails. */
  transaction<T>(work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;

  // What follows is optional, and each goes with a word in `capabilities.faster`. A
  // backend that implements none of it has every verb all the same.

  /** Each node a walk reaches, once, at its least depth, nearest first. With `"walk"`. */
  walk?(walk: Walk): Promise<Step[]>;
  /**
   * What each window of a series amounts to, oldest first. With `"buckets"`.
   *
   * Answering with nothing at all — not an empty list — means "not this time": the
   * backend could not vouch for its own answer, and the rows are worked out here.
   */
  buckets?(buckets: Buckets): Promise<Bucket[] | undefined>;
  /** This many new ids, ordered by the time they were made. With `"ids"`. */
  mint?(count: number): Promise<string[]>;
}

/** How a connection is opened. */
export interface ConnectOptions {
  /** Where the data lives — a path, a URL, or `:memory:`. */
  url: string;
  /** Refuse anything that would change something. */
  readOnly?: boolean;
  /** Vector width, for a store that holds them. */
  dimensions?: number;
  /**
   * The family the store was declared as.
   *
   * A driver is free to ignore it — the four verbs are the same either way —
   * but a backend that can shape itself to what it is holding should be told
   * what that is. It is what makes a `timeseries` store on a server that can
   * partition by time actually partition by time, rather than a word in a file.
   */
  of?: StoreKind;
  /**
   * A native extension to load into this connection, named by whoever deploys
   * it rather than by anything here.
   *
   * Loading one is running arbitrary machine code inside the process holding
   * the data, so it is never a default and never inferred: it is a path an
   * operator wrote down. Only the SQLite driver reads this today.
   */
  extension?: string;
}

/** What a store is given besides its connection. */
export interface Extras {
  /** What every row kept through `remember` is checked against. */
  schema?: import("../schema.js").StandardSchemaV1<unknown, object>;
  /** A second opinion on what `recall` found by its words. */
  reranker?: Reranker;
}

/**
 * A backend.
 *
 * One ships with the framework. Anything else is brought by the app that needs
 * it: implement this, hand it over, and the four verbs work against it
 * unchanged. That is what lets the framework speak to a database it does not
 * depend on.
 */
export interface Driver {
  readonly name: string;
  connect(options: ConnectOptions): Promise<Connection>;
}

/**
 * A store, as everything above the runtime sees it.
 *
 * The four verbs are the same whichever family you declared. `query` is not:
 * the ways you interrogate a table, a vector index and a graph have little in
 * common, and the one that flattens them is bad at all three.
 */
export interface Store<M extends object = Meta, In extends object = M> {
  readonly name: string;
  readonly of: StoreKind;
  readonly capabilities: Capabilities;
  /**
   * Keep something. Answers with the ids it was kept under.
   *
   * On a store declared with a schema, what is kept alongside the text is checked
   * first, and a batch with anything wrong in it is refused whole with a `SchemaError`.
   */
  remember(items: Keep<In> | Keep<In>[]): Promise<string[]>;
  /**
   * What is relevant to this, recent things counting for more.
   *
   * Asked with words, the text index answers; with a vector, the nearest rows; with
   * both, each is asked and the two orders are fused by reciprocal rank.
   */
  recall(about: string | number[] | Asked, query?: RecallQuery): Promise<Found<M>[]>;
  /** What contains these terms. Precise, and indifferent to age. */
  search(terms: string, query?: Query): Promise<Found<M>[]>;
  /** What happened, newest first. */
  history(query?: Query): Promise<Item<M>[]>;
  /** Forget. Answers with how many went. */
  forget(query: Query): Promise<number>;
  /**
   * Take back what these said without pretending they were never there.
   *
   * The row stays, at the time it was written, by whoever wrote it. What it
   * says becomes the note. That is the difference between an answer to "this
   * should not have been kept" and an answer to "this was never kept": the
   * first is usually what was meant, and deleting gives you the second.
   */
  redact(query: Query, note: string): Promise<number>;
  /**
   * The same store, writing as this one.
   *
   * Everything kept through the view is marked as its, and nothing can say
   * otherwise, because there is nowhere else for the mark to come from. The
   * runtime hands agents a view rather than the store, so what an agent kept is
   * a fact about the run rather than a claim the agent made.
   */
  as(who: string): Store<M, In>;
  /** A value under a name: `put`, `get`, `delete`, `list`, with an optional lifetime. */
  readonly values: import("./models.js").Values;
  /** How two things are related and when that was true: `relate`, `unrelate`, `facts`, `neighbors`. */
  readonly facts: import("./models.js").Facts;
  /** Readings in order of time: `append`, `range`, `last`. */
  readonly series: import("./models.js").Series;
  /** The native surface, for the author rather than the agent. */
  query(sql: string, params?: readonly unknown[]): Promise<ResultSet>;
  close(): Promise<void>;
}
