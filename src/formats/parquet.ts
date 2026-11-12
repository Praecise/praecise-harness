/**
 * Parquet: a table stored by column, described from its footer.
 *
 * The last eight bytes of a file are the length of its footer and the magic `PAR1`. The
 * footer is a Thrift `FileMetaData`: the schema as a flattened tree, the row count, and
 * for each row group and column the codec, the sizes and, where the writer kept them,
 * the smallest and largest value and the number of nulls. That is everything about a
 * table except its rows, and it is all this reads.
 *
 * The rows themselves are in pages compressed with Snappy, zstd or others and encoded
 * with dictionaries and run lengths. They are not decoded, and the rendering says so: a
 * model is told what the table is and what its columns range over, not shown its values.
 *
 * Field numbers from `parquet.thrift` in apache/parquet-format, read on 2026-11-13.
 */

import type { Format } from "./bytes.js";
import { clip, count, Cursor, printable, size, some, startsWith, utf8, viewOf } from "./bytes.js";
import { lerobotTable } from "./lerobot.js";
import type { Struct } from "./thrift.js";
import { bin, flag, list, num, str, structOf, structs, sub } from "./thrift.js";

const MAGIC = "PAR1";
/** The magic of a file whose footer is encrypted. */
const SEALED = "PARE";

const PHYSICAL = ["BOOLEAN", "INT32", "INT64", "INT96", "FLOAT", "DOUBLE", "BYTE_ARRAY", "FIXED_LEN_BYTE_ARRAY"];
const CONVERTED = [
  "UTF8", "MAP", "MAP_KEY_VALUE", "LIST", "ENUM", "DECIMAL", "DATE", "TIME_MILLIS", "TIME_MICROS", "TIMESTAMP_MILLIS", "TIMESTAMP_MICROS",
  "UINT_8", "UINT_16", "UINT_32", "UINT_64", "INT_8", "INT_16", "INT_32", "INT_64", "JSON", "BSON", "INTERVAL",
];
const REPETITION = ["required", "optional", "repeated"];
const CODEC = ["UNCOMPRESSED", "SNAPPY", "GZIP", "LZO", "BROTLI", "LZ4", "ZSTD", "LZ4_RAW"];
/** The `LogicalType` union, by field number. */
const LOGICAL: Record<number, string> = {
  1: "STRING", 2: "MAP", 3: "LIST", 4: "ENUM", 5: "DECIMAL", 6: "DATE", 7: "TIME", 8: "TIMESTAMP", 10: "INTEGER", 11: "UNKNOWN",
  12: "JSON", 13: "BSON", 14: "UUID", 15: "FLOAT16", 16: "VARIANT", 17: "GEOMETRY", 18: "GEOGRAPHY",
};
const UNIT: Record<number, string> = { 1: "ms", 2: "us", 3: "ns" };

const LISTED = 80;

/** How a column's values are meant to be taken, beyond the bytes they are stored as. */
function logicalOf(element: Struct): string {
  const logical = sub(element, 10);
  if (logical) {
    const [id, detail] = [...logical][0] ?? [0, undefined];
    const name = LOGICAL[id] ?? `logical type ${id}`;
    const inner = detail instanceof Map ? (detail as Struct) : undefined;
    if (name === "DECIMAL") return `DECIMAL(${num(inner, 2)}, ${num(inner, 1)})`;
    if (name === "INTEGER") return `${flag(inner, 2) === false ? "UINT" : "INT"}${num(inner, 1)}`;
    if (name === "TIMESTAMP" || name === "TIME") {
      const unit = UNIT[[...(sub(inner, 2) ?? new Map<number, unknown>()).keys()][0] ?? 0] ?? "";
      return `${name}(${unit}${flag(inner, 1) ? ", UTC" : ""})`;
    }
    return name;
  }
  const converted = num(element, 6);
  return converted === undefined ? "" : (CONVERTED[converted] ?? "");
}

interface Leaf {
  path: string;
  physical: number;
  logical: string;
  /** How it is nested: required, optional or repeated at each level down to it. */
  repetition: string;
}

/** The schema is a tree written depth-first, each node saying how many children it has. The leaves are the columns. */
function leavesOf(elements: Struct[]): Leaf[] {
  const leaves: Leaf[] = [];
  let at = 1;
  const walk = (prefix: string[], repeated: boolean, children: number): void => {
    for (let index = 0; index < children && at < elements.length; index++) {
      const element = elements[at++]!;
      const path = [...prefix, str(element, 4) ?? "?"];
      const repetition = num(element, 3) ?? 0;
      const below = num(element, 5) ?? 0;
      if (below > 0) walk(path, repeated || repetition === 2, below);
      else {
        leaves.push({
          path: path.join("."),
          physical: num(element, 1) ?? -1,
          logical: logicalOf(element),
          repetition: repeated || repetition === 2 ? "repeated" : (REPETITION[repetition] ?? "?"),
        });
      }
    }
  };
  walk([], false, num(elements[0], 5) ?? elements.length - 1);
  return leaves;
}

/** A statistic as its column's type says to read it, kept as a number where it is one so several row groups can be compared. */
function statOf(bytes: Uint8Array | undefined, leaf: Leaf): number | bigint | string | undefined {
  if (!bytes) return undefined;
  const view = viewOf(bytes);
  switch (leaf.physical) {
    case 0:
      return bytes.length >= 1 ? (bytes[0] ? "true" : "false") : undefined;
    case 1:
      return bytes.length >= 4 ? (leaf.logical.startsWith("UINT") ? view.getUint32(0, true) : view.getInt32(0, true)) : undefined;
    case 2:
      return bytes.length >= 8 ? (leaf.logical.startsWith("UINT") ? view.getBigUint64(0, true) : view.getBigInt64(0, true)) : undefined;
    case 4:
      return bytes.length >= 4 ? view.getFloat32(0, true) : undefined;
    case 5:
      return bytes.length >= 8 ? view.getFloat64(0, true) : undefined;
    default:
      return printable(bytes, 40);
  }
}

const said = (value: number | bigint | string): string =>
  typeof value === "number" ? (Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(7)))) : String(value);

interface Column {
  values: number;
  nulls?: number;
  packed: number;
  unpacked: number;
  codecs: Set<string>;
  min?: number | bigint | string;
  max?: number | bigint | string;
  /** False once a row group turns up without statistics: a range over some of the rows is not the column's range. */
  ranged: boolean;
}

function read(bytes: Uint8Array): string {
  if (startsWith(bytes, SEALED, bytes.length - 4)) {
    return `A Parquet file with an encrypted footer; ${size(bytes.length)}.\nNot read: its schema and row counts are in the footer, which cannot be read without the key.`;
  }
  if (bytes.length < 12 || !startsWith(bytes, MAGIC, bytes.length - 4)) {
    throw new Error("it begins as a Parquet file and does not end as one: it is cut short, and the footer at the end is where its schema and counts are");
  }
  const length = viewOf(bytes).getUint32(bytes.length - 8, true);
  const start = bytes.length - 8 - length;
  if (start < 4) throw new Error("its footer is longer than the file: it is cut short at the front");
  const meta = structOf(new Cursor(bytes, start, bytes.length - 8));

  const leaves = leavesOf(structs(meta, 2));
  const groups = structs(meta, 4);
  const rows = num(meta, 3) ?? 0;
  const byPath = new Map<string, Column>();
  let packed = 0;
  let unpacked = 0;
  const codecs = new Set<string>();
  const elsewhere = new Set<string>();

  for (const group of groups) {
    for (const chunk of structs(group, 1)) {
      const file = str(chunk, 1);
      if (file) elsewhere.add(file);
      const data = sub(chunk, 3);
      if (!data) continue;
      const path = list(data, 3)
        .filter((part): part is Uint8Array => part instanceof Uint8Array)
        .map(utf8)
        .join(".");
      const leaf = leaves.find((each) => each.path === path);
      const codec = CODEC[num(data, 4) ?? -1] ?? `codec ${num(data, 4)}`;
      const column = byPath.get(path) ?? { values: 0, packed: 0, unpacked: 0, codecs: new Set<string>(), ranged: true };
      column.values += num(data, 5) ?? 0;
      column.unpacked += num(data, 6) ?? 0;
      column.packed += num(data, 7) ?? 0;
      column.codecs.add(codec);
      codecs.add(codec);
      packed += num(data, 7) ?? 0;
      unpacked += num(data, 6) ?? 0;

      const stats = sub(data, 12);
      const nulls = num(stats, 3);
      if (nulls !== undefined) column.nulls = (column.nulls ?? 0) + nulls;
      // `min_value`/`max_value` are the ones with a defined order; the older pair is used only where they are missing.
      const min = leaf ? statOf(bin(stats, 6) ?? bin(stats, 2), leaf) : undefined;
      const max = leaf ? statOf(bin(stats, 5) ?? bin(stats, 1), leaf) : undefined;
      if (min === undefined || max === undefined) {
        // A group that is all nulls has no smallest value, and takes nothing away from the range.
        if (!(nulls !== undefined && nulls === (num(data, 5) ?? -1))) column.ranged = false;
      } else {
        if (column.min === undefined || (typeof min === typeof column.min && min < column.min)) column.min = min;
        if (column.max === undefined || (typeof max === typeof column.max && max > column.max)) column.max = max;
      }
      byPath.set(path, column);
    }
  }

  const version = num(meta, 1);
  const writer = str(meta, 6);
  const lines = [
    `A Parquet table: ${count(rows)} row(s), ${count(leaves.length)} column(s), ${count(groups.length)} row group(s); ${size(bytes.length)}` +
      (writer ? `, written by ${clip(writer, 80)}` : "") +
      (version !== undefined ? ` (format version ${version})` : "") +
      ".",
  ];
  if (groups.length) {
    lines.push(`Column data: ${size(packed)} stored, ${size(unpacked)} unpacked, compressed with ${[...codecs].join(", ") || "nothing"}.`);
  }
  if (groups.length > 1) {
    const sizes = groups.map((group) => num(group, 3) ?? 0);
    lines.push(`Rows per group: ${count(Math.min(...sizes))} to ${count(Math.max(...sizes))}.`);
  }
  const part = lerobotTable(leaves.map((leaf) => leaf.path));
  if (part) lines.push(part);

  const { shown, rest } = some(leaves, LISTED, "more column(s)");
  lines.push("Columns:");
  for (const leaf of shown) {
    const column = byPath.get(leaf.path);
    const type = `${PHYSICAL[leaf.physical] ?? "?"}${leaf.logical ? ` as ${leaf.logical}` : ""}, ${leaf.repetition}`;
    const facts: string[] = [];
    if (column) {
      if (leaf.repetition === "repeated" || column.values !== rows) facts.push(`${count(column.values)} values`);
      if (column.nulls !== undefined) facts.push(`${count(column.nulls)} null`);
      if (column.ranged && column.min !== undefined && column.max !== undefined) facts.push(`min ${said(column.min)}, max ${said(column.max)}`);
    }
    lines.push(`  ${leaf.path} [${type}]${facts.length ? `: ${facts.join(", ")}` : ""}`);
  }
  if (rest) lines.push(`  ${rest}`);

  const keys = structs(meta, 5);
  if (keys.length) {
    lines.push(`File metadata keys: ${keys.map((pair) => str(pair, 1)).join(", ")}.`);
    // The Hugging Face `datasets` library records its own feature types here, which say more than Parquet's (an image, an audio clip, a class label).
    const hub = keys.find((pair) => str(pair, 1) === "huggingface");
    if (hub && str(hub, 2)) lines.push(`huggingface: ${clip(str(hub, 2)!, 800)}`);
  }
  if (elsewhere.size) lines.push(`Its column data is in other files: ${[...elsewhere].slice(0, 8).join(", ")}.`);

  lines.push(
    "Not read: the rows. This is the table's footer (schema, counts, and each column's range where the writer recorded one); the values themselves are in compressed, encoded pages that are not decoded here.",
  );
  return lines.join("\n");
}

export const parquet: Format = {
  name: "a Parquet table",
  mimes: ["application/vnd.apache.parquet", "application/x-parquet", "application/parquet"],
  extensions: ["parquet", "pq"],
  sniff: (bytes) => startsWith(bytes, MAGIC) || startsWith(bytes, SEALED),
  read,
};
