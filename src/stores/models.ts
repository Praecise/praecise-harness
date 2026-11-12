/**
 * Three more shapes of data, kept in the one table every backend already has.
 *
 * A store answers four questions about text: remember, recall, search, forget. An agent
 * also needs to keep a value under a name, to say how two things are related and when
 * that was true, and to keep readings in order of time. Those are usually three more
 * databases. They are not three more here, because none of them needs anything a row
 * cannot hold: a row has an id, a scope, a time and a JSON object, and that is a key and
 * its value, a fact and its validity, a reading and its tags.
 *
 * So these are verbs over the operations a `Driver` already implements, and every
 * backend — the file, the server, the one in memory, and any an app brings — has all of
 * them the day it passes `conform`. Nothing new is asked of a driver.
 *
 * What that buys is said plainly, because it is not free: a walk over facts and an
 * aggregate over a series read the rows of their scope and work them out here. That is
 * correct, and it is a scan. It is the right trade for what an agent keeps — thousands of
 * facts, not billions — and the wrong one for a warehouse, which is what `query()` and a
 * backend that indexes the shape natively are for.
 *
 * There is deliberately no layer here that maps tables to classes. An agent that needs
 * a table writes SQL through `query()`, and what keeps that safe is the role the
 * connection holds and the statement being bound rather than spliced — not a type.
 */

import { createHash } from "node:crypto";

import type { Connection, Item } from "./types.js";

/** Everything in a scope, oldest first. A negative limit is the whole window, by the driver contract. */
async function all(connection: Connection, scope: string, since?: number): Promise<Item[]> {
  const rows = await connection.list({ scope, ...(since !== undefined ? { since } : {}), limit: -1 });
  return rows.filter((row) => !row.redactedAt).sort((a, b) => a.at - b.at);
}

const digest = (...parts: string[]): string =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);

// ── A value under a name ────────────────────────────────────────────────────

/** Where a value is kept: a path of names, so one store holds many tables of them. */
export type Namespace = string | readonly string[];

export interface Entry<Value = unknown> {
  key: string;
  value: Value;
  /** When it was last written, epoch milliseconds. */
  at: number;
  /** When it stops being there, where it was given a lifetime. */
  expires?: number;
}

const spaceOf = (namespace: Namespace): string =>
  `kv:${(typeof namespace === "string" ? [namespace] : namespace).join("/")}`;

const entryOf = (row: Item): Entry | undefined => {
  const meta = row.meta ?? {};
  if (typeof meta.key !== "string") return undefined;
  const expires = typeof meta.expires === "number" ? meta.expires : undefined;
  return { key: meta.key, value: meta.value, at: row.at, ...(expires ? { expires } : {}) };
};

const live = (entry: Entry | undefined, now: number): entry is Entry =>
  entry !== undefined && (entry.expires === undefined || entry.expires > now);

export class Values {
  private readonly connection: Connection;
  private readonly writer?: string;
  constructor(connection: Connection, writer?: string) {
    this.connection = connection;
    this.writer = writer;
  }

  /**
   * Keep `value` under `key`, replacing what was there. `ttl` is seconds until it is gone.
   *
   * The row's id is derived from the namespace and the key, so writing twice is one row
   * and not two — the upsert every driver already performs on a known id.
   */
  async put(namespace: Namespace, key: string, value: unknown, options: { ttl?: number } = {}): Promise<void> {
    const scope = spaceOf(namespace);
    const now = Date.now();
    await this.connection.put(
      [
        {
          id: `kv_${digest(scope, key)}`,
          scope,
          text: typeof value === "string" ? value : JSON.stringify(value ?? null),
          meta: { key, value, ...(options.ttl && options.ttl > 0 ? { expires: now + options.ttl * 1000 } : {}) },
          at: now,
          by: this.writer,
        },
      ],
      [undefined],
    );
  }

  /** What is under `key`, or nothing. A value past its lifetime is nothing, and is removed on the way. */
  async get<Value = unknown>(namespace: Namespace, key: string): Promise<Value | undefined> {
    const scope = spaceOf(namespace);
    const id = `kv_${digest(scope, key)}`;
    const [row] = await this.connection.list({ id, scope, limit: 1 });
    const entry = row && !row.redactedAt ? entryOf(row) : undefined;
    if (live(entry, Date.now())) return entry.value as Value;
    if (entry) await this.connection.drop({ id, scope, limit: 1 });
    return undefined;
  }

  /** Remove what is under `key`. True when something was there. */
  async delete(namespace: Namespace, key: string): Promise<boolean> {
    const scope = spaceOf(namespace);
    return (await this.connection.drop({ id: `kv_${digest(scope, key)}`, scope, limit: 1 })) > 0;
  }

  /** Every live entry in a namespace, most recently written first. */
  async list(namespace: Namespace, options: { limit?: number } = {}): Promise<Entry[]> {
    const now = Date.now();
    const entries = (await all(this.connection, spaceOf(namespace)))
      .map(entryOf)
      .filter((entry): entry is Entry => live(entry, now))
      .reverse();
    return options.limit && options.limit > 0 ? entries.slice(0, options.limit) : entries;
  }
}

// ── How two things are related, and when ────────────────────────────────────

/**
 * One thing known about two others.
 *
 * Two clocks, because they answer different questions. `validFrom`/`validTo` is when the
 * fact was true in the world: she worked there from March until June. `recordedAt` is
 * when this store learned it. An agent asked "where did she work in April" needs the
 * first; an auditor asked "what did the agent believe on the day it answered" needs the
 * second. A fact that stops being true is closed, never deleted — what was believed is
 * part of the record.
 */
export interface Fact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  /** When it began to be true, epoch milliseconds. Absent: as far back as is known. */
  validFrom?: number;
  /** When it stopped being true. Absent: still true. */
  validTo?: number;
  /** When this store learned it. */
  recordedAt: number;
  /** How sure whoever wrote it was, 0..1, where they said. */
  confidence?: number;
  /** Where it came from: a row id, a document, a tool. */
  source?: string;
  by?: string;
}

export interface FactOptions {
  scope?: string;
  validFrom?: number;
  validTo?: number;
  confidence?: number;
  source?: string;
}

export interface FactQuery {
  scope?: string;
  subject?: string;
  predicate?: string;
  object?: string;
  /** Only what was true at this moment. Left out: what is true now. `"ever"`: all of it. */
  asOf?: number | "ever";
  limit?: number;
}

export interface Neighbour {
  node: string;
  /** How many facts away from where the walk began. */
  depth: number;
  /** The fact that led here. */
  via: Fact;
}

/** How far a walk may go. Past three steps nearly everything is connected to nearly everything. */
export const DEEPEST = 3;

const factsScope = (scope: string | undefined): string => `facts:${scope ?? ""}`;

const factOf = (row: Item): Fact | undefined => {
  const meta = row.meta ?? {};
  if (typeof meta.subject !== "string" || typeof meta.predicate !== "string" || typeof meta.object !== "string") {
    return undefined;
  }
  const number = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
  return {
    id: row.id,
    subject: meta.subject,
    predicate: meta.predicate,
    object: meta.object,
    recordedAt: number(meta.recordedAt) ?? row.at,
    ...(number(meta.validFrom) !== undefined ? { validFrom: number(meta.validFrom) } : {}),
    ...(number(meta.validTo) !== undefined ? { validTo: number(meta.validTo) } : {}),
    ...(number(meta.confidence) !== undefined ? { confidence: number(meta.confidence) } : {}),
    ...(typeof meta.source === "string" ? { source: meta.source } : {}),
    ...(row.by ? { by: row.by } : {}),
  };
};

const trueAt = (fact: Fact, when: number): boolean =>
  (fact.validFrom === undefined || fact.validFrom <= when) && (fact.validTo === undefined || fact.validTo > when);

export class Facts {
  private readonly connection: Connection;
  private readonly writer?: string;
  constructor(connection: Connection, writer?: string) {
    this.connection = connection;
    this.writer = writer;
  }

  private async write(scope: string | undefined, fact: Fact): Promise<void> {
    const { id, by: _by, ...meta } = fact;
    await this.connection.put(
      [
        {
          id,
          scope: factsScope(scope),
          // Written as a sentence too, so a text search over the store finds facts by
          // what they say and not only by their fields.
          text: `${fact.subject} ${fact.predicate} ${fact.object}`,
          meta,
          at: fact.recordedAt,
          by: this.writer,
        },
      ],
      [undefined],
    );
  }

  /**
   * Record that `subject` stands in `predicate` to `object`.
   *
   * Saying the same thing again with the same start is the same fact, not a second one.
   */
  async relate(subject: string, predicate: string, object: string, options: FactOptions = {}): Promise<string> {
    for (const [name, value] of [["subject", subject], ["predicate", predicate], ["object", object]] as const) {
      if (!value.trim()) throw new Error(`a fact needs a ${name}: relate(subject, predicate, object)`);
    }
    if (options.validFrom !== undefined && options.validTo !== undefined && options.validTo <= options.validFrom) {
      throw new Error("a fact cannot stop being true before it starts: validTo must be after validFrom");
    }
    const id = `fact_${digest(factsScope(options.scope), subject, predicate, object, String(options.validFrom ?? ""))}`;
    await this.write(options.scope, {
      id,
      subject,
      predicate,
      object,
      recordedAt: Date.now(),
      ...(options.validFrom !== undefined ? { validFrom: options.validFrom } : {}),
      ...(options.validTo !== undefined ? { validTo: options.validTo } : {}),
      ...(options.confidence !== undefined ? { confidence: Math.min(1, Math.max(0, options.confidence)) } : {}),
      ...(options.source ? { source: options.source } : {}),
    });
    return id;
  }

  /**
   * Say a fact stopped being true, at `at` or now. It is closed, not removed: asked what
   * was true before then, the store still says so. False when there is no such fact.
   */
  async unrelate(id: string, options: { scope?: string; at?: number } = {}): Promise<boolean> {
    const [row] = await this.connection.list({ id, scope: factsScope(options.scope), limit: 1 });
    const fact = row && !row.redactedAt ? factOf(row) : undefined;
    if (!fact) return false;
    await this.write(options.scope, { ...fact, validTo: options.at ?? Date.now() });
    return true;
  }

  /** The facts matching a pattern: any of subject, predicate and object, true at a moment. */
  async facts(query: FactQuery = {}): Promise<Fact[]> {
    const when = query.asOf ?? Date.now();
    const found = (await all(this.connection, factsScope(query.scope)))
      .map(factOf)
      .filter(
        (fact): fact is Fact =>
          fact !== undefined &&
          (query.subject === undefined || fact.subject === query.subject) &&
          (query.predicate === undefined || fact.predicate === query.predicate) &&
          (query.object === undefined || fact.object === query.object) &&
          (when === "ever" || trueAt(fact, when)),
      );
    return query.limit && query.limit > 0 ? found.slice(0, query.limit) : found;
  }

  /**
   * What `node` is connected to, breadth first, nearest first, each node once.
   *
   * `direction` is which way a fact is followed: `"out"` from subject to object, `"in"`
   * the other way, `"both"` either. `depth` is how many facts away to go, three at most.
   */
  async neighbors(
    node: string,
    options: { scope?: string; predicate?: string; direction?: "out" | "in" | "both"; depth?: number; asOf?: number | "ever" } = {},
  ): Promise<Neighbour[]> {
    const direction = options.direction ?? "out";
    const depth = Math.min(DEEPEST, Math.max(1, Math.trunc(options.depth ?? 1)));
    const known = await this.facts({ scope: options.scope, predicate: options.predicate, asOf: options.asOf });

    const reached: Neighbour[] = [];
    const seen = new Set([node]);
    let frontier = [node];
    for (let step = 1; step <= depth && frontier.length; step++) {
      const next: string[] = [];
      for (const from of frontier) {
        for (const fact of known) {
          const to =
            direction !== "in" && fact.subject === from
              ? fact.object
              : direction !== "out" && fact.object === from
                ? fact.subject
                : undefined;
          if (to === undefined || seen.has(to)) continue;
          seen.add(to);
          next.push(to);
          reached.push({ node: to, depth: step, via: fact });
        }
      }
      frontier = next;
    }
    return reached;
  }
}

// ── Readings in order of time ───────────────────────────────────────────────

export interface Point {
  /** Epoch milliseconds. For a bucket, the start of it. */
  at: number;
  value: number;
  tags?: Record<string, unknown>;
}

export type Aggregate = "mean" | "min" | "max" | "sum" | "count" | "first" | "last";

export interface RangeOptions {
  /** From this moment, inclusive. */
  from?: number;
  /** To this moment, exclusive. */
  to?: number;
  /** Group readings into windows this many milliseconds wide, aligned to the epoch. */
  bucket?: number;
  /** What each window amounts to. Default `"mean"`. */
  aggregate?: Aggregate;
  /** Keep only the most recent this many points or buckets. */
  limit?: number;
}

const seriesScope = (series: string): string => `series:${series}`;

function reduce(values: number[], how: Aggregate): number {
  switch (how) {
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "sum":
      return values.reduce((total, value) => total + value, 0);
    case "count":
      return values.length;
    case "first":
      return values[0]!;
    case "last":
      return values[values.length - 1]!;
    default:
      return values.reduce((total, value) => total + value, 0) / values.length;
  }
}

export class Series {
  private readonly connection: Connection;
  private readonly writer?: string;
  constructor(connection: Connection, writer?: string) {
    this.connection = connection;
    this.writer = writer;
  }

  /**
   * Add readings to a series. One, or many at once.
   *
   * A reading is identified by its series and its time, so sending the same reading
   * again — as a sensor that retries will — replaces it rather than counting it twice.
   */
  async append(series: string, points: Point | number | (Point | number)[]): Promise<number> {
    if (!series.trim()) throw new Error("a series needs a name: append(series, points)");
    const scope = seriesScope(series);
    const now = Date.now();
    const rows = (Array.isArray(points) ? points : [points]).map((point, index): Item => {
      const reading: Point = typeof point === "number" ? { at: now + index, value: point } : point;
      if (!Number.isFinite(reading.value) || !Number.isFinite(reading.at)) {
        throw new Error(`series "${series}": a reading needs a finite value and a time in milliseconds`);
      }
      return {
        id: `pt_${digest(scope, String(reading.at))}`,
        scope,
        text: String(reading.value),
        meta: { value: reading.value, ...(reading.tags ? { tags: reading.tags } : {}) },
        at: reading.at,
        by: this.writer,
      };
    });
    const chunk = Math.max(1, Math.floor(this.connection.capabilities.maxBindValues / 6));
    for (let start = 0; start < rows.length; start += chunk) {
      const slice = rows.slice(start, start + chunk);
      await this.connection.put(slice, slice.map(() => undefined));
    }
    return rows.length;
  }

  /** The readings of a series in a span, oldest first; or what each window of them amounts to. */
  async range(series: string, options: RangeOptions = {}): Promise<Point[]> {
    const points = (await all(this.connection, seriesScope(series), options.from))
      .filter((row) => options.to === undefined || row.at < options.to)
      .flatMap((row): Point[] => {
        const value = row.meta?.value;
        if (typeof value !== "number") return [];
        const tags = row.meta?.tags as Record<string, unknown> | undefined;
        return [{ at: row.at, value, ...(tags ? { tags } : {}) }];
      });

    let out = points;
    if (options.bucket && options.bucket > 0) {
      const width = options.bucket;
      const windows = new Map<number, number[]>();
      for (const point of points) {
        const start = Math.floor(point.at / width) * width;
        const held = windows.get(start);
        if (held) held.push(point.value);
        else windows.set(start, [point.value]);
      }
      out = [...windows.entries()]
        .sort(([a], [b]) => a - b)
        .map(([at, values]) => ({ at, value: reduce(values, options.aggregate ?? "mean") }));
    }
    return options.limit && options.limit > 0 ? out.slice(-options.limit) : out;
  }

  /** The most recent reading of a series, or nothing. */
  async last(series: string): Promise<Point | undefined> {
    const points = await this.range(series, { limit: 1 });
    return points[0];
  }
}
