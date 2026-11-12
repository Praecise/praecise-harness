/**
 * Writers for the containers the format readers read, so their tests can build a file
 * in memory and not commit one.
 *
 * Each is the smallest writer that produces a valid file of its kind, written from the
 * same specification the reader was, and independent of the reader's code: a test that
 * round-trips through one implementation proves only that it agrees with itself.
 */
import { deflateRawSync } from "node:zlib";

import type { Attachment } from "../src/harness/types.js";

/** Bytes written in order, little-endian. */
export class Bytes {
  private parts: Buffer[] = [];

  get length(): number {
    return this.parts.reduce((total, part) => total + part.length, 0);
  }
  raw(bytes: Uint8Array | string): this {
    this.parts.push(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes));
    return this;
  }
  u8(value: number): this {
    return this.raw(Buffer.from([value & 0xff]));
  }
  u16(value: number): this {
    const out = Buffer.alloc(2);
    out.writeUInt16LE(value);
    return this.raw(out);
  }
  u32(value: number): this {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(value >>> 0);
    return this.raw(out);
  }
  i32(value: number): this {
    const out = Buffer.alloc(4);
    out.writeInt32LE(value);
    return this.raw(out);
  }
  u64(value: number | bigint): this {
    const out = Buffer.alloc(8);
    out.writeBigUInt64LE(BigInt(value));
    return this.raw(out);
  }
  f32(value: number): this {
    const out = Buffer.alloc(4);
    out.writeFloatLE(value);
    return this.raw(out);
  }
  f64(value: number): this {
    const out = Buffer.alloc(8);
    out.writeDoubleLE(value);
    return this.raw(out);
  }
  /** A string with a 32-bit length before it, as MCAP and ROS write one. */
  str(text: string): this {
    const body = Buffer.from(text, "utf8");
    return this.u32(body.length).raw(body);
  }
  done(): Buffer {
    return Buffer.concat(this.parts);
  }
}

export const attachment = (bytes: Uint8Array | string, mime: string, name?: string): Attachment => ({
  mime,
  data: Buffer.from(bytes).toString("base64"),
  ...(name ? { name } : {}),
});

// ── Compression, written the long way ───────────────────────────────────────

/** An LZ4 block that is one run of literals: valid, and the size of what it holds. */
export function lz4Literals(data: Uint8Array): Buffer {
  const out = new Bytes();
  if (data.length < 15) out.u8(data.length << 4);
  else {
    out.u8(0xf0);
    let rest = data.length - 15;
    while (rest >= 255) {
      out.u8(255);
      rest -= 255;
    }
    out.u8(rest);
  }
  return out.raw(data).done();
}

/** An LZ4 frame around blocks that are already LZ4 blocks. */
export function lz4Frame(blocks: Uint8Array[], options: { stored?: boolean } = {}): Buffer {
  // FLG: version 01, blocks independent. BD: 4 MB blocks. Then the header checksum, which readers of a sample do not verify.
  const out = new Bytes().u32(0x184d2204).u8(0x60).u8(0x70).u8(0x00);
  for (const block of blocks) out.u32(options.stored ? (block.length | 0x80000000) >>> 0 : block.length).raw(block);
  return out.u32(0).done();
}

/** LZF that is runs of literals, at most 32 to a run. */
export function lzfLiterals(data: Uint8Array): Buffer {
  const out = new Bytes();
  for (let at = 0; at < data.length; at += 32) {
    const run = data.subarray(at, at + 32);
    out.u8(run.length - 1).raw(run);
  }
  return out.done();
}

// ── zip ─────────────────────────────────────────────────────────────────────

export function zip(files: { name: string; data: Uint8Array; deflate?: boolean }[]): Buffer {
  const out = new Bytes();
  const directory = new Bytes();
  for (const file of files) {
    const body = file.deflate ? deflateRawSync(file.data) : Buffer.from(file.data);
    const method = file.deflate ? 8 : 0;
    const offset = out.length;
    const name = Buffer.from(file.name, "utf8");
    out.u32(0x04034b50).u16(20).u16(0).u16(method).u16(0).u16(0).u32(0).u32(body.length).u32(file.data.length).u16(name.length).u16(0).raw(name).raw(body);
    directory
      .u32(0x02014b50).u16(20).u16(20).u16(0).u16(method).u16(0).u16(0).u32(0).u32(body.length).u32(file.data.length)
      .u16(name.length).u16(0).u16(0).u16(0).u16(0).u32(0).u32(offset).raw(name);
  }
  const start = out.length;
  const central = directory.done();
  return out.raw(central).u32(0x06054b50).u16(0).u16(0).u16(files.length).u16(files.length).u32(central.length).u32(start).u16(0).done();
}

// ── MCAP ────────────────────────────────────────────────────────────────────

export const MCAP_MAGIC = Buffer.from([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a]);

export const mcapRecord = (op: number, body: Bytes | Uint8Array): Buffer => {
  const content = body instanceof Bytes ? body.done() : Buffer.from(body);
  return new Bytes().u8(op).u64(content.length).raw(content).done();
};

export interface McapMessage {
  channel: number;
  time: bigint;
  data: Uint8Array | string;
}

export interface McapInput {
  profile?: string;
  schemas: { id: number; name: string; encoding: string; data: string }[];
  channels: { id: number; schema: number; topic: string; encoding: string }[];
  /** Each inner list is one chunk. */
  chunks: McapMessage[][];
  /** What the chunks are compressed with, and the function that does it. */
  compression?: { name: string; pack: (data: Buffer) => Buffer };
  attachments?: { name: string; media: string; data: string }[];
  metadata?: { name: string; pairs: Record<string, string> }[];
  /** Leave the summary section out, as a writer that only streams does. */
  summary?: boolean;
  /** Leave the per-channel counts out of the statistics. */
  channelCounts?: boolean;
  /** Stop after the data section: no footer, no closing magic. */
  finished?: boolean;
}

const mcapMap = (pairs: Record<string, string>): Buffer => {
  const out = new Bytes();
  for (const [key, value] of Object.entries(pairs)) out.str(key).str(value);
  const body = out.done();
  return new Bytes().u32(body.length).raw(body).done();
};

/** A whole MCAP file, laid out as the specification's "with chunk indices" diagram. */
export function mcapFile(input: McapInput): Buffer {
  const out = new Bytes().raw(MCAP_MAGIC);
  out.raw(mcapRecord(0x01, new Bytes().str(input.profile ?? "").str("formats-helpers")));

  const schemaRecords = input.schemas.map((schema) => mcapRecord(0x03, new Bytes().u16(schema.id).str(schema.name).str(schema.encoding).str(schema.data)));
  const channelRecords = input.channels.map((channel) =>
    mcapRecord(0x04, new Bytes().u16(channel.id).u16(channel.schema).str(channel.topic).str(channel.encoding).raw(mcapMap({}))),
  );
  const compression = input.compression ?? { name: "", pack: (data: Buffer) => data };

  const counts = new Map<number, number>();
  const all = input.chunks.flat();
  const indexes: Buffer[] = [];
  input.chunks.forEach((messages, index) => {
    const inner = new Bytes();
    // Schemas and channels are declared in the first chunk, before the messages that use them.
    if (index === 0) for (const record of [...schemaRecords, ...channelRecords]) inner.raw(record);
    for (const message of messages) {
      counts.set(message.channel, (counts.get(message.channel) ?? 0) + 1);
      inner.raw(mcapRecord(0x05, new Bytes().u16(message.channel).u32(0).u64(message.time).u64(message.time).raw(message.data)));
    }
    const records = inner.done();
    const packed = compression.pack(records);
    const times = messages.map((message) => message.time);
    const first = times.length ? times.reduce((a, b) => (a < b ? a : b)) : 0n;
    const last = times.length ? times.reduce((a, b) => (a > b ? a : b)) : 0n;
    const chunk = mcapRecord(0x06, new Bytes().u64(first).u64(last).u64(records.length).u32(0).str(compression.name).u64(packed.length).raw(packed));
    indexes.push(
      mcapRecord(
        0x08,
        new Bytes().u64(first).u64(last).u64(out.length).u64(chunk.length).u32(0).u64(0).str(compression.name).u64(packed.length).u64(records.length),
      ),
    );
    out.raw(chunk);
  });

  const attachmentIndexes: Buffer[] = [];
  for (const each of input.attachments ?? []) {
    const record = mcapRecord(0x09, new Bytes().u64(1).u64(1).str(each.name).str(each.media).u64(Buffer.byteLength(each.data)).raw(each.data).u32(0));
    attachmentIndexes.push(mcapRecord(0x0a, new Bytes().u64(out.length).u64(record.length).u64(1).u64(1).u64(Buffer.byteLength(each.data)).str(each.name).str(each.media)));
    out.raw(record);
  }
  const metadataIndexes: Buffer[] = [];
  for (const each of input.metadata ?? []) {
    const record = mcapRecord(0x0c, new Bytes().str(each.name).raw(mcapMap(each.pairs)));
    metadataIndexes.push(mcapRecord(0x0d, new Bytes().u64(out.length).u64(record.length).str(each.name)));
    out.raw(record);
  }
  if (input.finished === false) return out.done();

  out.raw(mcapRecord(0x0f, new Bytes().u32(0)));
  let summaryStart = 0;
  if (input.summary !== false) {
    summaryStart = out.length;
    for (const record of [...schemaRecords, ...channelRecords, ...indexes, ...attachmentIndexes, ...metadataIndexes]) out.raw(record);
    const perChannel = new Bytes();
    if (input.channelCounts !== false) for (const [channel, total] of counts) perChannel.u16(channel).u64(total);
    const times = all.map((message) => message.time);
    out.raw(
      mcapRecord(
        0x0b,
        new Bytes()
          .u64(all.length).u16(input.schemas.length).u32(input.channels.length).u32(input.attachments?.length ?? 0)
          .u32(input.metadata?.length ?? 0).u32(input.chunks.length)
          .u64(times.length ? times.reduce((a, b) => (a < b ? a : b)) : 0n)
          .u64(times.length ? times.reduce((a, b) => (a > b ? a : b)) : 0n)
          .u32(perChannel.length).raw(perChannel.done()),
      ),
    );
  }
  out.raw(mcapRecord(0x02, new Bytes().u64(summaryStart).u64(0).u32(0)));
  return out.raw(MCAP_MAGIC).done();
}

// ── ROS 1 bag ───────────────────────────────────────────────────────────────

type BagField = [name: string, value: Uint8Array | string];

const bagHeader = (fields: BagField[]): Buffer => {
  const out = new Bytes();
  for (const [name, value] of fields) {
    const body = Buffer.concat([Buffer.from(`${name}=`, "latin1"), Buffer.from(value)]);
    out.u32(body.length).raw(body);
  }
  return out.done();
};

const bagRecord = (fields: BagField[], data: Uint8Array): Buffer => {
  const header = bagHeader(fields);
  return new Bytes().u32(header.length).raw(header).u32(data.length).raw(data).done();
};

const op = (code: number): Buffer => Buffer.from([code]);
const le32 = (value: number): Buffer => new Bytes().u32(value).done();
const le64 = (value: number): Buffer => new Bytes().u64(value).done();
/** A ROS time: seconds, then nanoseconds. */
const rosTime = (seconds: number, nanoseconds = 0): Buffer => new Bytes().u32(seconds).u32(nanoseconds).done();

export interface BagInput {
  connections: { id: number; topic: string; type: string; definition: string; caller?: string }[];
  /** Each inner list is one chunk of messages. */
  chunks: { conn: number; seconds: number; data: Uint8Array }[][];
  compression?: { name: string; pack: (data: Buffer) => Buffer };
  /** Write the bag as one still being recorded: no index, `index_pos` zero. */
  indexed?: boolean;
}

export function bagFile(input: BagInput): Buffer {
  const compression = input.compression ?? { name: "none", pack: (data: Buffer) => data };
  const connection = (each: BagInput["connections"][number]): Buffer =>
    bagRecord(
      [["op", op(0x07)], ["conn", le32(each.id)], ["topic", each.topic]] as BagField[],
      bagHeader([["topic", each.topic], ["type", each.type], ["md5sum", "0".repeat(32)], ["message_definition", each.definition], ...(each.caller ? [["callerid", each.caller] as BagField] : [])]),
    );

  const body = new Bytes();
  const infos: Buffer[] = [];
  // The bag header record is padded to 4096 bytes, so the chunks start at a known place.
  const dataAt = 13 + 4096;
  input.chunks.forEach((messages, index) => {
    const inner = new Bytes();
    if (index === 0) for (const each of input.connections) inner.raw(connection(each));
    const offsets = new Map<number, { seconds: number; offset: number }[]>();
    for (const message of messages) {
      const list = offsets.get(message.conn) ?? [];
      list.push({ seconds: message.seconds, offset: inner.length });
      offsets.set(message.conn, list);
      inner.raw(bagRecord([["op", op(0x02)], ["conn", le32(message.conn)], ["time", rosTime(message.seconds)]], message.data));
    }
    const records = inner.done();
    const position = dataAt + body.length;
    body.raw(bagRecord([["op", op(0x05)], ["compression", compression.name], ["size", le32(records.length)]], compression.pack(records)));
    const perConn = new Bytes();
    for (const [conn, list] of offsets) {
      const entries = new Bytes();
      for (const entry of list) entries.raw(rosTime(entry.seconds)).u32(entry.offset);
      body.raw(bagRecord([["op", op(0x04)], ["ver", le32(1)], ["conn", le32(conn)], ["count", le32(list.length)]], entries.done()));
      perConn.u32(conn).u32(list.length);
    }
    const seconds = messages.map((message) => message.seconds);
    infos.push(
      bagRecord(
        [["op", op(0x06)], ["ver", le32(1)], ["chunk_pos", le64(position)], ["start_time", rosTime(Math.min(...seconds))], ["end_time", rosTime(Math.max(...seconds))], ["count", le32(offsets.size)]],
        perConn.done(),
      ),
    );
  });

  const chunks = body.done();
  const indexed = input.indexed !== false;
  const fields: BagField[] = [["op", op(0x03)], ["index_pos", le64(indexed ? dataAt + chunks.length : 0)], ["conn_count", le32(indexed ? input.connections.length : 0)], ["chunk_count", le32(indexed ? input.chunks.length : 0)]];
  const header = bagHeader(fields);
  const padding = Buffer.alloc(4096 - 8 - header.length, 0x20);
  const out = new Bytes().raw("#ROSBAG V2.0\n").u32(header.length).raw(header).u32(padding.length).raw(padding).raw(chunks);
  if (indexed) {
    for (const each of input.connections) out.raw(connection(each));
    for (const info of infos) out.raw(info);
  }
  return out.done();
}

// ── Thrift compact protocol ─────────────────────────────────────────────────

export type Thrift =
  | { i: number | bigint }
  | { s: string }
  | { b: Uint8Array }
  | { bool: boolean }
  | { list: Thrift[] }
  | { struct: Record<number, Thrift | undefined> };

const varint = (value: bigint): Buffer => {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80n) {
    out.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  out.push(Number(rest));
  return Buffer.from(out);
};

const zigzag = (value: number | bigint): bigint => {
  const big = BigInt(value);
  return big >= 0n ? big * 2n : -big * 2n - 1n;
};

const thriftType = (value: Thrift): number => ("i" in value ? 6 : "s" in value || "b" in value ? 8 : "bool" in value ? (value.bool ? 1 : 2) : "list" in value ? 9 : 12);

function thriftValue(value: Thrift): Buffer {
  if ("i" in value) return varint(zigzag(value.i));
  if ("s" in value) return Buffer.concat([varint(BigInt(Buffer.byteLength(value.s))), Buffer.from(value.s)]);
  if ("b" in value) return Buffer.concat([varint(BigInt(value.b.length)), Buffer.from(value.b)]);
  if ("bool" in value) return Buffer.alloc(0);
  if ("list" in value) {
    const element = value.list[0] ? thriftType(value.list[0]) : 12;
    const header = value.list.length < 15 ? Buffer.from([(value.list.length << 4) | element]) : Buffer.concat([Buffer.from([0xf0 | element]), varint(BigInt(value.list.length))]);
    return Buffer.concat([header, ...value.list.map((each) => ("bool" in each ? Buffer.from([each.bool ? 1 : 2]) : thriftValue(each)))]);
  }
  return thriftStruct(value.struct);
}

/** One struct in the compact protocol, its fields in ascending order of number. */
export function thriftStruct(fields: Record<number, Thrift | undefined>): Buffer {
  const parts: Buffer[] = [];
  let last = 0;
  for (const id of Object.keys(fields).map(Number).sort((a, b) => a - b)) {
    const value = fields[id];
    if (!value) continue;
    const delta = id - last;
    parts.push(delta <= 15 ? Buffer.from([(delta << 4) | thriftType(value)]) : Buffer.concat([Buffer.from([thriftType(value)]), varint(zigzag(id))]));
    parts.push(thriftValue(value));
    last = id;
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** A Parquet file with this footer and no pages: what a footer reader needs and nothing else. */
export const parquetFile = (footer: Record<number, Thrift | undefined>): Buffer => {
  const meta = thriftStruct(footer);
  return new Bytes().raw("PAR1").raw(Buffer.alloc(16)).raw(meta).u32(meta.length).raw("PAR1").done();
};

// ── FlatBuffers ─────────────────────────────────────────────────────────────

export type Flat =
  | { u8: number }
  | { bool: boolean }
  | { i16: number }
  | { i32: number }
  | { i64: number }
  | { str: string }
  | { table: FlatTable }
  | { tables: FlatTable[] }
  | { structs: Uint8Array; count: number };

/** A table's fields by their position in the schema; a hole is a field left at its default. */
export type FlatTable = (Flat | undefined)[];

/**
 * Serialise a table as a FlatBuffers buffer.
 *
 * Laid out front to back, each table directly after its vtable and everything it points
 * at after itself, which is not how the official builder orders a buffer and is every
 * bit as valid: offsets to tables, strings and vectors only ever point forward.
 */
export function flatbuffer(root: FlatTable): Buffer {
  let out = Buffer.alloc(4);
  const append = (bytes: Buffer): number => {
    const at = out.length;
    out = Buffer.concat([out, bytes]);
    return at;
  };
  const pad = (): void => {
    if (out.length % 8) append(Buffer.alloc(8 - (out.length % 8)));
  };
  /** Write `value` here and make the offset at `from` point at it. */
  const point = (from: number, write: () => number): void => {
    pad();
    const to = write();
    out.writeUInt32LE(to - from, from);
  };

  const table = (fields: FlatTable): number => {
    // Every field gets eight bytes, so nothing needs aligning.
    const vtable = Buffer.alloc(4 + fields.length * 2);
    vtable.writeUInt16LE(vtable.length, 0);
    vtable.writeUInt16LE(4 + fields.length * 8, 2);
    fields.forEach((field, index) => vtable.writeUInt16LE(field ? 4 + index * 8 : 0, 4 + index * 2));
    const vtableAt = append(vtable);
    const at = append(Buffer.alloc(4 + fields.length * 8));
    out.writeInt32LE(at - vtableAt, at);
    const later: (() => void)[] = [];
    fields.forEach((field, index) => {
      const slot = at + 4 + index * 8;
      if (!field) return;
      if ("u8" in field) out.writeUInt8(field.u8, slot);
      else if ("bool" in field) out.writeUInt8(field.bool ? 1 : 0, slot);
      else if ("i16" in field) out.writeInt16LE(field.i16, slot);
      else if ("i32" in field) out.writeInt32LE(field.i32, slot);
      else if ("i64" in field) out.writeBigInt64LE(BigInt(field.i64), slot);
      else if ("str" in field) {
        later.push(() => point(slot, () => append(Buffer.concat([new Bytes().str(field.str).done(), Buffer.from([0])]))));
      } else if ("table" in field) later.push(() => point(slot, () => table(field.table)));
      else if ("structs" in field) later.push(() => point(slot, () => append(Buffer.concat([new Bytes().u32(field.count).done(), Buffer.from(field.structs)]))));
      else {
        later.push(() => {
          let start = 0;
          point(slot, () => (start = append(Buffer.alloc(4 + field.tables.length * 4))));
          out.writeUInt32LE(field.tables.length, start);
          field.tables.forEach((each, element) => point(start + 4 + element * 4, () => table(each)));
        });
      }
    });
    for (const run of later) run();
    return at;
  };

  // The root's vtable comes first, so the root offset is patched once the table's place is known.
  const rootAt = table(root);
  out.writeUInt32LE(rootAt, 0);
  pad();
  return out;
}

// ── Arrow ───────────────────────────────────────────────────────────────────

/** A field of an Arrow schema: name, nullable, type (as the union's number and its table), dictionary, children. */
export const arrowField = (name: string, type: number, detail: FlatTable, options: { nullable?: boolean; children?: FlatTable[]; dictionary?: boolean } = {}): FlatTable => [
  { str: name },
  { bool: options.nullable ?? true },
  { u8: type },
  { table: detail },
  options.dictionary ? { table: [{ i64: 0 }] } : undefined,
  options.children ? { tables: options.children } : undefined,
];

export const arrowSchema = (fields: FlatTable[], metadata: Record<string, string> = {}): FlatTable => [
  undefined,
  { tables: fields },
  Object.keys(metadata).length ? { tables: Object.entries(metadata).map(([key, value]): FlatTable => [{ str: key }, { str: value }]) } : undefined,
];

/** One message as it sits in a stream: the marker, the header's length, the header, the body. */
export function arrowMessage(kind: number, header: FlatTable, body = Buffer.alloc(0)): Buffer {
  const meta = flatbuffer([{ i16: 4 }, { u8: kind }, { table: header }, { i64: body.length }]);
  return new Bytes().u32(0xffffffff).i32(meta.length).raw(meta).raw(body).done();
}

export const arrowBatch = (rows: number, compressed?: "lz4" | "zstd"): Buffer =>
  arrowMessage(3, [{ i64: rows }, undefined, undefined, compressed ? { table: [compressed === "zstd" ? { u8: 1 } : undefined] } : undefined], Buffer.alloc(16));

export function arrowStream(schema: FlatTable, batches: number[]): Buffer {
  const out = new Bytes().raw(arrowMessage(1, schema));
  for (const rows of batches) out.raw(arrowBatch(rows));
  return out.u32(0xffffffff).u32(0).done();
}

export function arrowFile(schema: FlatTable, batches: number[], options: { closed?: boolean; compressed?: "lz4" | "zstd" } = {}): Buffer {
  const out = new Bytes().raw("ARROW1\0\0").raw(arrowMessage(1, schema));
  const blocks = new Bytes();
  for (const rows of batches) {
    const message = arrowBatch(rows, options.compressed);
    // A block: where the message is, how long its header is (with the eight bytes before it), how long its body is.
    blocks.u64(out.length).i32(message.length - 16).u32(0).u64(16);
    out.raw(message);
  }
  if (options.closed === false) return out.done();
  out.u32(0xffffffff).u32(0);
  const footer = flatbuffer([{ i16: 4 }, { table: schema }, undefined, { structs: blocks.done(), count: batches.length }]);
  return out.raw(footer).i32(footer.length).raw("ARROW1").done();
}

// ── NumPy ───────────────────────────────────────────────────────────────────

/** An `.npy` file, format 1.0: the header padded with spaces so the data starts on a multiple of 64. */
export function npyFile(descr: string, shape: number[], data: Uint8Array, options: { fortran?: boolean } = {}): Buffer {
  const tuple = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(", ")})`;
  let header = `{'descr': ${descr.startsWith("[") ? descr : `'${descr}'`}, 'fortran_order': ${options.fortran ? "True" : "False"}, 'shape': ${tuple}, }`;
  header += " ".repeat(63 - ((10 + header.length) % 64));
  header += "\n";
  return new Bytes().raw(Buffer.from([0x93])).raw("NUMPY").u8(1).u8(0).u16(header.length).raw(header).raw(data).done();
}

export const float32s = (values: number[]): Buffer => Buffer.from(new Float32Array(values).buffer);
export const float64s = (values: number[]): Buffer => Buffer.from(new Float64Array(values).buffer);
