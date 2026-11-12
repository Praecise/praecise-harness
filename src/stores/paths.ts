/**
 * The statements a SQL backend answers a walk and a bucketed series with.
 *
 * The data verbs keep facts and readings as ordinary rows, so on any backend they can
 * be answered by reading a scope and working it out in the process. A backend that
 * speaks SQL can do the working out itself: a recursive query follows relationships
 * without the rows leaving the database, and a `GROUP BY` buckets a series where it is
 * stored. The two dialects that ship differ only in how a placeholder is written and
 * how a field is read out of the JSON column, so the statements are written once here
 * and each driver supplies those two things.
 *
 * What these must give is what the slow path gives — `conform` compares them — so the
 * rules are the verbs' rules: a redacted row is not a fact and not a reading, a walk
 * reaches each node once at its least depth, and a window is aligned to the epoch and
 * named by its start.
 */

import type { Buckets, Walk } from "./types.js";

/** What differs between the dialects. Everything else is the same statement. */
export interface Dialect {
  /** Bind a value and answer with the placeholder that refers to it. */
  bind(params: unknown[], value: unknown): string;
  /** A string field of the JSON column, as text. */
  text(field: string): string;
  /** A number field of the JSON column, as a number. */
  number(field: string): string;
  /** Whether a field of the JSON column is a number at all. */
  isNumber(field: string): string;
  /**
   * The value at the earliest or latest time in a group, as select-list text whose
   * first column is that value. `v` and `at` are the columns it may use.
   */
  edge(which: "first" | "last"): string;
  /** The start of the window `at` falls in, given a way to bind the width. */
  start(width: () => string): string;
}

const ITEMS = "praecise_items";

/** The seven columns a row is read back as, in the order every driver's `toItem` expects. */
const columns = (alias: string): string =>
  ["id", "scope", "body", "meta", "at", "writer", "redacted"].map((column) => `${alias}.${column}`).join(", ");

export interface Statement {
  sql: string;
  params: unknown[];
}

/**
 * Every node a walk reaches, once, with its least depth and the row of a fact that led
 * there: `node, depth`, then the seven item columns.
 *
 * The recursion is bounded by depth and not by a visited set — three steps at most, so
 * a cycle costs a few repeated rows rather than a loop — and `UNION` rather than
 * `UNION ALL` drops the repeats as they are made. Which fact is named for a node
 * reached two ways at the same depth is the earliest recorded, so the answer is the
 * same on every run.
 */
export function walkStatement(dialect: Dialect, walk: Walk): Statement {
  const params: unknown[] = [];
  const subject = dialect.text("subject");
  const object = dialect.text("object");

  const edges = (here: string, other: string): string => {
    const clauses = [
      `scope = ${dialect.bind(params, walk.scope)}`,
      "redacted IS NULL",
      // Spelled exactly as the index is, so the index is what answers.
      `${subject} IS NOT NULL`,
      `${object} IS NOT NULL`,
    ];
    if (walk.predicate !== undefined) {
      clauses.push(`${dialect.text("predicate")} = ${dialect.bind(params, walk.predicate)}`);
    }
    if (walk.at !== undefined) {
      const from = dialect.number("validFrom");
      const to = dialect.number("validTo");
      clauses.push(`(${from} IS NULL OR ${from} <= ${dialect.bind(params, walk.at)})`);
      clauses.push(`(${to} IS NULL OR ${to} > ${dialect.bind(params, walk.at)})`);
    }
    return `SELECT id, at, ${here} AS here, ${other} AS other FROM ${ITEMS} WHERE ${clauses.join(" AND ")}`;
  };

  const followed: string[] = [];
  if (walk.direction !== "in") followed.push(edges(subject, object));
  if (walk.direction !== "out") followed.push(edges(object, subject));

  const start = dialect.bind(params, walk.from);
  const depth = dialect.bind(params, walk.depth);
  const origin = dialect.bind(params, walk.from);

  const sql = `
WITH RECURSIVE edges(id, at, here, other) AS (
  ${followed.join("\n  UNION ALL\n  ")}
),
reach(node, depth, id) AS (
  SELECT CAST(${start} AS text), 0, CAST(NULL AS text)
  UNION
  SELECT e.other, r.depth + 1, e.id FROM reach r JOIN edges e ON e.here = r.node WHERE r.depth < ${depth}
),
nearest AS (
  SELECT r.node AS node, r.depth AS depth, r.id AS id,
         ROW_NUMBER() OVER (PARTITION BY r.node ORDER BY r.depth, e.at, r.id) AS place
  FROM reach r JOIN ${ITEMS} e ON e.id = r.id
  WHERE r.depth > 0 AND r.node <> ${origin}
)
SELECT n.node, n.depth, ${columns("i")}
FROM nearest n JOIN ${ITEMS} i ON i.id = n.id
WHERE n.place = 1
ORDER BY n.depth, i.at, i.id`;
  return { sql, params };
}

/**
 * What each window of a series amounts to, oldest first: the window's start, then its value.
 *
 * Only rows that are readings count — a number under `value`, not taken back — which
 * is the test the slow path applies to each row it reads.
 */
export function bucketStatement(dialect: Dialect, buckets: Buckets): Statement {
  const params: unknown[] = [];
  const start = dialect.start(() => dialect.bind(params, buckets.width));
  const clauses = [
    `scope = ${dialect.bind(params, buckets.scope)}`,
    "redacted IS NULL",
    dialect.isNumber("value"),
  ];
  if (buckets.from !== undefined) clauses.push(`at >= ${dialect.bind(params, buckets.from)}`);
  if (buckets.to !== undefined) clauses.push(`at < ${dialect.bind(params, buckets.to)}`);

  const amount = ((): string => {
    switch (buckets.aggregate) {
      case "min":
        return "MIN(v)";
      case "max":
        return "MAX(v)";
      case "sum":
        return "SUM(v)";
      case "count":
        return "COUNT(*)";
      case "first":
      case "last":
        return dialect.edge(buckets.aggregate);
      default:
        return "AVG(v)";
    }
  })();

  const sql = `
SELECT bucket, ${amount}
FROM (SELECT at, ${dialect.number("value")} AS v, ${start} AS bucket FROM ${ITEMS} WHERE ${clauses.join(" AND ")}) readings
GROUP BY bucket
ORDER BY bucket`;
  return { sql, params };
}

/**
 * The start of a window by whole-number arithmetic.
 *
 * `at` is a count of milliseconds, not a timestamp, so there is nothing for `date_bin`
 * to bin: taking the remainder off is the same alignment to the epoch in one integer
 * expression every SQL database has. The remainder is made non-negative first, because
 * `%` keeps the sign of what it divides and a reading before 1970 would otherwise be
 * filed in the window after its own.
 */
export const wholeStart = (width: () => string): string => `at - (((at % ${width()}) + ${width()}) % ${width()})`;

/** The two indexes a walk is answered through: a fact found by where it starts, or where it ends. */
export const factIndexes = (dialect: Pick<Dialect, "text">): string[] => {
  const subject = dialect.text("subject");
  const object = dialect.text("object");
  return [
    `CREATE INDEX IF NOT EXISTS ${ITEMS}_subject ON ${ITEMS} (scope, ${subject}) WHERE ${subject} IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ${ITEMS}_object ON ${ITEMS} (scope, ${object}) WHERE ${subject} IS NOT NULL`,
  ];
};
