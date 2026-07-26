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
}

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

/** Something kept in a store. */
export interface Item {
  id: string;
  /** What it says. Every family can search this, whatever else it holds. */
  text: string;
  /** Whose it is — a conversation, a customer, a run. */
  scope?: string;
  /** Anything else worth keeping alongside it. */
  meta?: Record<string, unknown>;
  /** When it happened, in milliseconds. */
  at: number;
}

/** Something to keep. Anything the store can decide for itself is optional. */
export interface Keep {
  id?: string;
  text: string;
  scope?: string;
  meta?: Record<string, unknown>;
  at?: number;
  /**
   * A precomputed embedding. Supplied rather than derived, because deriving one
   * costs a credential the framework does not require you to have.
   */
  vector?: number[];
}

/** Something found, and how well it matched. */
export interface Found extends Item {
  /** 0 to 1, comparable within one result and not across two. */
  score: number;
}

/** Which things to look at. Every verb narrows the same way. */
export interface Query {
  /** Only within this scope. */
  scope?: string;
  /** Only things at least this recent, in milliseconds. */
  since?: number;
  /**
   * At most this many. Clamped rather than refused: a caller that asks for a
   * million rows wants as many as it can have, not an error.
   */
  limit?: number;
}

/** A query with its limit already settled, which is what a driver is given. */
export interface Window extends Query {
  limit: number;
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
  /** The author's own statement. Not something an agent reaches. */
  run(sql: string, params?: readonly unknown[]): Promise<ResultSet>;
  /** Run several as one, undoing all of them if any of them fails. */
  transaction<T>(work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** How a connection is opened. */
export interface ConnectOptions {
  /** Where the data lives — a path, a URL, or `:memory:`. */
  url: string;
  /** Refuse anything that would change something. */
  readOnly?: boolean;
  /** Vector width, for a store that holds them. */
  dimensions?: number;
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
export interface Store {
  readonly name: string;
  readonly of: StoreKind;
  readonly capabilities: Capabilities;
  /** Keep something. Answers with the ids it was kept under. */
  remember(items: Keep | Keep[]): Promise<string[]>;
  /** What is relevant to this, recent things counting for more. */
  recall(about: string | number[], query?: Query): Promise<Found[]>;
  /** What contains these terms. Precise, and indifferent to age. */
  search(terms: string, query?: Query): Promise<Found[]>;
  /** What happened, newest first. */
  history(query?: Query): Promise<Item[]>;
  /** Forget. Answers with how many went. */
  forget(query: Query): Promise<number>;
  /** The native surface, for the author rather than the agent. */
  query(sql: string, params?: readonly unknown[]): Promise<ResultSet>;
  close(): Promise<void>;
}
