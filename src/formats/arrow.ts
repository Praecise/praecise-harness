/**
 * Arrow IPC: a table as it sits in memory, written to a file or a stream.
 *
 * Both forms are a run of messages, each a FlatBuffers header and then a body of raw
 * column buffers. The first message is the schema; each record batch after it says how
 * many rows it holds. The file form (`.arrow`, Feather V2) wraps the run in the magic
 * `ARROW1` and ends with a footer that repeats the schema and lists where every batch
 * is, so its rows are counted from the footer; a stream is counted by walking it.
 *
 * What is read is the headers: the schema with nested and dictionary types, the batches
 * and their row counts, and any metadata the writer attached. The column buffers are
 * not decoded, and the rendering says so.
 *
 * Table layouts from `Schema.fbs`, `Message.fbs` and `File.fbs` in apache/arrow, and the
 * framing from the Arrow columnar format's IPC section, read on 2026-11-13.
 */

import type { Format } from "./bytes.js";
import { clip, count, size, some, startsWith, viewOf } from "./bytes.js";
import type { Table } from "./flatbuffers.js";
import { rootOf } from "./flatbuffers.js";
import { lerobotTable } from "./lerobot.js";

const MAGIC = "ARROW1";
/** Feather's first version, which is a different format under the same extension. */
const FEATHER1 = "FEA1";

// The `MessageHeader` union.
const SCHEMA = 1;
const DICTIONARY = 2;
const BATCH = 3;

const UNITS = ["s", "ms", "us", "ns"];
const LISTED = 80;

/** A field's type, written the way Arrow's own tools print one. Numbers are positions in the `Type` union. */
function typeOf(field: Table, depth = 0): string {
  // Children that point back at their parent would nest without end.
  if (depth > 32) return "…";
  const kind = field.u8(2);
  const type = field.table(3);
  const children = field.tables(5);
  const child = (index: number): string => (children[index] ? typeOf(children[index], depth + 1) : "?");
  switch (kind) {
    case 1:
      return "null";
    case 2:
      return `${type?.bool(1) ? "int" : "uint"}${type?.i32(0) ?? 0}`;
    case 3:
      return ["float16", "float32", "float64"][type?.i16(0) ?? 0] ?? "float";
    case 4:
      return "binary";
    case 5:
      return "string";
    case 6:
      return "bool";
    case 7:
      return `decimal${type?.i32(2, 128) ?? 128}(${type?.i32(0) ?? 0}, ${type?.i32(1) ?? 0})`;
    case 8:
      return (type?.i16(0, 1) ?? 1) === 0 ? "date32" : "date64";
    case 9:
      return `time${type?.i32(1, 32) ?? 32}[${UNITS[type?.i16(0, 1) ?? 1]}]`;
    case 10: {
      const zone = type?.string(1);
      return `timestamp[${UNITS[type?.i16(0) ?? 0]}${zone ? `, ${zone}` : ""}]`;
    }
    case 11:
      return `interval[${["year_month", "day_time", "month_day_nano"][type?.i16(0) ?? 0]}]`;
    case 12:
      return `list<${child(0)}>`;
    case 13:
      return `struct<${children.map((each) => `${each.string(0) ?? ""}: ${typeOf(each, depth + 1)}`).join(", ")}>`;
    case 14:
      return `union<${children.map((each) => `${each.string(0) ?? ""}: ${typeOf(each, depth + 1)}`).join(", ")}>`;
    case 15:
      return `fixed_size_binary[${type?.i32(0) ?? 0}]`;
    case 16:
      return `fixed_size_list<${child(0)}>[${type?.i32(0) ?? 0}]`;
    case 17:
      return `map<${children[0] ? children[0].tables(5).map((each) => typeOf(each, depth + 1)).join(", ") : "?"}>`;
    case 18:
      return `duration[${UNITS[type?.i16(0, 1) ?? 1]}]`;
    case 19:
      return "large_binary";
    case 20:
      return "large_string";
    case 21:
      return `large_list<${child(0)}>`;
    case 22:
      return `run_end_encoded<${child(0)}, ${child(1)}>`;
    case 23:
      return "binary_view";
    case 24:
      return "string_view";
    case 25:
      return `list_view<${child(0)}>`;
    case 26:
      return `large_list_view<${child(0)}>`;
    default:
      return `type ${kind}`;
  }
}

interface Field {
  name: string;
  type: string;
  nullable: boolean;
  dictionary: boolean;
}

interface Schema {
  fields: Field[];
  metadata: Map<string, string>;
  bigEndian: boolean;
}

const pairs = (table: Table, field: number): Map<string, string> =>
  new Map(table.tables(field).map((pair) => [pair.string(0) ?? "", pair.string(1) ?? ""]));

function schemaOf(table: Table): Schema {
  return {
    bigEndian: table.i16(0) === 1,
    fields: table.tables(1).map((field) => ({
      name: field.string(0) ?? "",
      type: typeOf(field),
      nullable: field.bool(1),
      dictionary: field.table(4) !== undefined,
    })),
    metadata: pairs(table, 2),
  };
}

interface Counted {
  batches: number;
  rows: number;
  dictionaries: number;
  compression: Set<string>;
  body: number;
}

/** Count a record batch's rows from its header. */
function batchIn(message: Table, into: Counted): void {
  const kind = message.u8(1);
  const header = message.table(2);
  into.body += message.i64(3);
  if (kind === DICTIONARY) into.dictionaries++;
  if (kind !== BATCH || !header) return;
  into.batches++;
  into.rows += header.i64(0);
  const compression = header.table(3);
  if (compression) into.compression.add(compression.u8(0) === 1 ? "zstd" : "lz4");
}

/**
 * The message that starts at `at`, and where the next one starts.
 *
 * A message is prefixed by its header's length, and since Arrow 0.15 by a marker of
 * 0xFFFFFFFF before that; a length of zero is the end of a stream.
 */
function messageAt(bytes: Uint8Array, at: number): { message: Table; next: number } | undefined {
  const view = viewOf(bytes);
  if (at + 4 > bytes.length) return undefined;
  let length = view.getInt32(at, true);
  let start = at + 4;
  if (length === -1) {
    if (start + 4 > bytes.length) return undefined;
    length = view.getInt32(start, true);
    start += 4;
  }
  if (length <= 0 || start + length > bytes.length) return undefined;
  const message = rootOf(bytes.subarray(start, start + length));
  // A body length that is negative would send a reader backwards for ever.
  return { message, next: start + length + Math.max(0, message.i64(3)) };
}

function render(kind: string, bytes: Uint8Array, schema: Schema, counted: Counted, notes: string[]): string {
  const lines = [
    `${kind}: ${count(counted.rows)} row(s), ${count(schema.fields.length)} column(s), ${count(counted.batches)} record batch(es); ${size(bytes.length)}.`,
  ];
  if (counted.compression.size) lines.push(`Column buffers are compressed with ${[...counted.compression].join(", ")}.`);
  if (schema.bigEndian) lines.push("Its buffers are big-endian.");
  const part = lerobotTable(schema.fields.map((field) => field.name));
  if (part) lines.push(part);
  const { shown, rest } = some(schema.fields, LISTED, "more column(s)");
  lines.push("Columns:");
  for (const field of shown) {
    lines.push(`  ${field.name}: ${field.type}${field.dictionary ? ", dictionary-encoded" : ""}${field.nullable ? "" : ", not null"}`);
  }
  if (rest) lines.push(`  ${rest}`);
  if (schema.metadata.size) {
    lines.push(`Schema metadata keys: ${[...schema.metadata.keys()].join(", ")}.`);
    // Written by the Hugging Face `datasets` library, whose cache files are Arrow streams.
    const hub = schema.metadata.get("huggingface");
    if (hub) lines.push(`huggingface: ${clip(hub, 800)}`);
  }
  lines.push(`Not read: ${["the column values (only the schema and the batch headers are decoded)", ...notes].join("; ")}.`);
  return lines.join("\n");
}

const empty = (): Counted => ({ batches: 0, rows: 0, dictionaries: 0, compression: new Set(), body: 0 });

function readFile(bytes: Uint8Array): string {
  const view = viewOf(bytes);
  const notes: string[] = [];
  const counted = empty();
  let schema: Schema | undefined;

  const closed = bytes.length > 22 && startsWith(bytes, MAGIC, bytes.length - 6);
  if (closed) {
    const length = view.getInt32(bytes.length - 10, true);
    const start = bytes.length - 10 - length;
    if (length <= 0 || start < 8) throw new Error("its footer is longer than the file");
    const footer = rootOf(bytes.subarray(start, start + length));
    const declared = footer.table(1);
    if (declared) schema = schemaOf(declared);
    // A `Block` is an offset (8 bytes), a header length (4, then 4 of padding) and a body length (8).
    counted.dictionaries = footer.length(2);
    for (const block of footer.structs(3, 24)) {
      const offset = Number(footer.raw.getBigInt64(block, true));
      const found = messageAt(bytes, offset);
      if (found) batchIn(found.message, counted);
      else notes.push(`the record batch at offset ${count(offset)} is missing or cut short`);
    }
  }
  if (!schema) {
    // Not closed: the messages after the opening magic are a stream, and are read as one.
    const walked = walk(bytes, 8, counted);
    schema = walked.schema;
    notes.push("the file has no footer, so it was not closed; its batches were counted by reading it from the front");
    if (walked.cut) notes.push("its last message is cut short");
  }
  if (!schema) throw new Error("it has no schema message");
  return render("An Arrow table (IPC file)", bytes, schema, counted, notes);
}

/** Read messages one after another from `from`. */
function walk(bytes: Uint8Array, from: number, counted: Counted): { schema?: Schema; cut: boolean } {
  const view = viewOf(bytes);
  let schema: Schema | undefined;
  let at = from;
  for (;;) {
    const found = messageAt(bytes, at);
    if (!found) {
      // Either the end marker (a length of zero), the end of the bytes, or a message that runs past them.
      const marker = at + 8 <= bytes.length && view.getInt32(at, true) === -1 && view.getInt32(at + 4, true) === 0;
      const zero = at + 4 <= bytes.length && view.getInt32(at, true) === 0;
      return { schema, cut: !(marker || zero || at >= bytes.length) };
    }
    if (found.message.u8(1) === SCHEMA) {
      const header = found.message.table(2);
      if (header && !schema) schema = schemaOf(header);
    } else batchIn(found.message, counted);
    at = found.next;
  }
}

function readStream(bytes: Uint8Array): string {
  const counted = empty();
  const { schema, cut } = walk(bytes, 0, counted);
  if (!schema) throw new Error("it has no schema message");
  return render("An Arrow table (IPC stream)", bytes, schema, counted, cut ? ["its last message is cut short, so the stream was not finished"] : []);
}

/** Whether these bytes open with a schema message, which is how a stream starts. */
function opensAsStream(bytes: Uint8Array, declared: boolean): boolean {
  try {
    // Without the marker a stream begins with a bare length, which could be anything; that is believed only of a file that said it was Arrow.
    if (!declared && !startsWith(bytes, [0xff, 0xff, 0xff, 0xff])) return false;
    return messageAt(bytes, 0)?.message.u8(1) === SCHEMA;
  } catch {
    return false;
  }
}

export const arrow: Format = {
  name: "an Arrow table",
  mimes: ["application/vnd.apache.arrow.file", "application/vnd.apache.arrow.stream", "application/x-apache-arrow-file", "application/x-apache-arrow-stream"],
  extensions: ["arrow", "arrows", "feather", "ipc"],
  sniff: (bytes, declared) => startsWith(bytes, MAGIC) || (declared && startsWith(bytes, FEATHER1)) || opensAsStream(bytes, declared),
  read: (bytes) => {
    if (startsWith(bytes, MAGIC)) return readFile(bytes);
    if (startsWith(bytes, FEATHER1)) {
      return `A Feather version 1 file; ${size(bytes.length)}.\nNot read: Feather V1 is an older format than Arrow IPC (Feather V2), and its schema is not decoded here.`;
    }
    return readStream(bytes);
  },
};
