/**
 * ROS 1 bags, format 2.0: what `rosbag record` writes.
 *
 * After a version line the file is records, each a header of `name=value` fields and a
 * body. Messages are inside chunk records; after the chunks comes an index: one
 * connection record per topic stream, and one chunk-info record per chunk giving its
 * time range and how many messages of each connection it holds. The bag header at the
 * front points at that index, so topics, types, counts and the time range all come from
 * the end of the file and no chunk has to be opened.
 *
 * A bag that was still being recorded has no index (`index_pos` is zero; `rosbag
 * reindex` is what repairs it). Then the chunks are walked: the index-data records that
 * follow each chunk give the counts and times, and the connections are read out of the
 * chunks that can be opened. bzip2 chunks cannot be, and that is said.
 *
 * Message bodies are in ROS's own serialization, which is only readable through the
 * message definition. The definition is shown; the bodies are not decoded.
 *
 * ROS 2 does not write this format: its bags are MCAP (read by the MCAP reader here) or
 * SQLite `.db3` files, which nothing here reads.
 *
 * Layout from wiki.ros.org/Bags/Format/2.0, read on 2026-11-13. That page lists `none`
 * and `bz2` as chunk compressions; `lz4` was added to rosbag later and is taken here to
 * be an LZ4 frame, which is what roslz4 writes.
 */

import type { Format } from "./bytes.js";
import { clip, count, Cursor, latin1, range, size, some, startsWith } from "./bytes.js";
import { unpack, unpacks, whyNot } from "./unpack.js";

const VERSION = "#ROSBAG V2.0\n";

const MESSAGE = 0x02;
const BAG_HEADER = 0x03;
const INDEX_DATA = 0x04;
const CHUNK = 0x05;
const CHUNK_INFO = 0x06;
const CONNECTION = 0x07;

const LISTED = 40;

type Fields = Map<string, Uint8Array>;

/** A record header, or a connection header: length-prefixed `name=value` fields. */
function fieldsOf(cursor: Cursor): Fields {
  const fields: Fields = new Map();
  while (cursor.left >= 4) {
    const field = cursor.take(cursor.u32());
    const equals = field.indexOf(0x3d);
    if (equals < 0) throw new Error("a record header field has no name");
    fields.set(latin1(field.subarray(0, equals)), field.subarray(equals + 1));
  }
  return fields;
}

const u32 = (fields: Fields, name: string): number | undefined => {
  const value = fields.get(name);
  return value && value.length >= 4 ? new Cursor(value).u32() : undefined;
};

const u64 = (fields: Fields, name: string): number | undefined => {
  const value = fields.get(name);
  return value && value.length >= 8 ? new Cursor(value).size() : undefined;
};

/** A ROS time: seconds and nanoseconds, each 32 bits. */
function timeOf(cursor: Cursor): bigint {
  const seconds = cursor.u32();
  return BigInt(seconds) * 1_000_000_000n + BigInt(cursor.u32());
}

const time = (fields: Fields, name: string): bigint | undefined => {
  const value = fields.get(name);
  return value && value.length >= 8 ? timeOf(new Cursor(value)) : undefined;
};

const str = (fields: Fields, name: string): string => {
  const value = fields.get(name);
  return value ? latin1(value) : "";
};

interface BagRecord {
  op: number;
  fields: Fields;
  data: Cursor;
  start: number;
}

/** Each record from an offset on. Stops at one that runs past the end, and says where. */
function* records(bytes: Uint8Array, from: number, to: number, cut?: (at: number) => void): Generator<BagRecord> {
  let at = from;
  while (at + 8 <= to) {
    try {
      const cursor = new Cursor(bytes, at, to);
      const fields = fieldsOf(cursor.sub(cursor.u32()));
      const data = cursor.sub(cursor.u32());
      const op = fields.get("op")?.[0];
      if (op === undefined) throw new Error("a record has no op");
      yield { op, fields, data, start: at };
      at = cursor.at;
    } catch {
      cut?.(at);
      return;
    }
  }
}

interface Connection {
  id: number;
  topic: string;
  type: string;
  definition: string;
  caller: string;
  latching: boolean;
}

function connectionOf(record: BagRecord): Connection {
  const header = fieldsOf(record.data);
  return {
    id: u32(record.fields, "conn") ?? -1,
    topic: str(record.fields, "topic") || str(header, "topic"),
    type: str(header, "type"),
    definition: str(header, "message_definition"),
    caller: str(header, "callerid"),
    latching: str(header, "latching") === "1",
  };
}

/** The message's own fields, without the nested types that follow the line of equals signs. */
function definitionOf(definition: string): string {
  const own = definition.split(/\n=+\n/)[0]!;
  return clip(
    own
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, "").trim())
      .filter(Boolean)
      .join("; "),
    360,
  );
}

function read(bytes: Uint8Array): string {
  const lines: string[] = [];
  const unread: string[] = [];
  const connections = new Map<number, Connection>();
  const counts = new Map<number, number>();
  const compressions = new Map<string, { chunks: number; packed: number; unpacked: number }>();
  let first: bigint | undefined;
  let last: bigint | undefined;
  const seen = (start: bigint | undefined, end: bigint | undefined): void => {
    if (start !== undefined && (first === undefined || start < first)) first = start;
    if (end !== undefined && (last === undefined || end > last)) last = end;
  };
  const chunkSeen = (record: BagRecord): string => {
    const compression = str(record.fields, "compression") || "none";
    const entry = compressions.get(compression) ?? { chunks: 0, packed: 0, unpacked: 0 };
    entry.chunks++;
    entry.packed += record.data.left;
    entry.unpacked += u32(record.fields, "size") ?? 0;
    compressions.set(compression, entry);
    return compression;
  };

  const header = records(bytes, VERSION.length, bytes.length).next().value;
  if (!header || header.op !== BAG_HEADER) throw new Error("it has no bag header record");
  const indexAt = u64(header.fields, "index_pos") ?? 0;
  const declaredConnections = u32(header.fields, "conn_count") ?? 0;
  const declaredChunks = u32(header.fields, "chunk_count") ?? 0;
  const dataAt = header.data.end;

  const indexed = indexAt > 0 && indexAt < bytes.length;
  if (indexed) {
    for (const record of records(bytes, indexAt, bytes.length)) {
      if (record.op === CONNECTION) {
        const connection = connectionOf(record);
        connections.set(connection.id, connection);
      } else if (record.op === CHUNK_INFO) {
        seen(time(record.fields, "start_time"), time(record.fields, "end_time"));
        while (record.data.left >= 8) {
          const id = record.data.u32();
          counts.set(id, (counts.get(id) ?? 0) + record.data.u32());
        }
        // The chunk's own header says how it is compressed; its body is not touched.
        const at = u64(record.fields, "chunk_pos");
        const chunk = at === undefined ? undefined : records(bytes, at, bytes.length).next().value;
        if (chunk && chunk.op === CHUNK) chunkSeen(chunk);
      }
    }
  } else {
    // Not closed: walk the chunk section. Counts and times come from the index-data
    // records after each chunk, which are never compressed.
    let cutAt: number | undefined;
    for (const record of records(bytes, dataAt, bytes.length, (at) => (cutAt = at))) {
      if (record.op === CHUNK) {
        const compression = chunkSeen(record);
        if (!unpacks(compression)) continue;
        try {
          const inner = unpack(compression, record.data.take(record.data.left), u32(record.fields, "size"));
          for (const each of records(inner, 0, inner.length)) {
            if (each.op !== CONNECTION) continue;
            const connection = connectionOf(each);
            connections.set(connection.id, connection);
          }
        } catch {
          unread.push(`a chunk at offset ${count(record.start)} could not be unpacked`);
        }
      } else if (record.op === INDEX_DATA) {
        const id = u32(record.fields, "conn") ?? -1;
        const messages = u32(record.fields, "count") ?? 0;
        counts.set(id, (counts.get(id) ?? 0) + messages);
        for (let index = 0; index < messages && record.data.left >= 12; index++) {
          const at = timeOf(record.data);
          record.data.skip(4);
          seen(at, at);
        }
      } else if (record.op === CONNECTION) {
        const connection = connectionOf(record);
        connections.set(connection.id, connection);
      } else if (record.op === MESSAGE) {
        const id = u32(record.fields, "conn") ?? -1;
        counts.set(id, (counts.get(id) ?? 0) + 1);
        const at = time(record.fields, "time");
        seen(at, at);
      }
    }
    if (cutAt !== undefined && cutAt < bytes.length) {
      unread.push(`the record at offset ${count(cutAt)} runs past the end of the file, so the recording was cut off there`);
    }
  }

  const messages = [...counts.values()].reduce((total, each) => total + each, 0);
  const chunks = [...compressions.values()].reduce((total, each) => total + each.chunks, 0);
  lines.push(
    `A ROS 1 bag (format 2.0): ${count(messages)} message(s) on ${count(connections.size || declaredConnections)} connection(s) ` +
      `in ${count(indexed ? declaredChunks : chunks)} chunk(s); ${size(bytes.length)}.`,
  );
  if (!indexed) {
    lines.push("The bag has no index: it was not closed (it would need `rosbag reindex`), so what follows was counted from the records found.");
  }
  if (first !== undefined && last !== undefined && messages > 0) lines.push(`Time: ${range(first, last)}.`);
  if (compressions.size) {
    lines.push(
      `Chunks: ${[...compressions].map(([name, entry]) => `${count(entry.chunks)} ${name === "none" ? "uncompressed" : `compressed with ${name}`} (${size(entry.packed)} stored, ${size(entry.unpacked)} unpacked)`).join("; ")}.`,
    );
    if (!indexed) {
      for (const name of compressions.keys()) {
        if (!unpacks(name)) unread.push(`chunks compressed with ${name} were not opened (${whyNot(name)}), so connections first named inside them are missing`);
      }
    }
  }

  // One topic may be recorded over several connections (several publishers); a model is asked about topics.
  const topics = new Map<string, { types: Set<string>; messages: number; connections: number; callers: Set<string>; latching: boolean }>();
  for (const connection of connections.values()) {
    const entry = topics.get(connection.topic) ?? { types: new Set(), messages: 0, connections: 0, callers: new Set(), latching: false };
    entry.types.add(connection.type);
    entry.messages += counts.get(connection.id) ?? 0;
    entry.connections++;
    if (connection.caller) entry.callers.add(connection.caller);
    entry.latching ||= connection.latching;
    topics.set(connection.topic, entry);
  }
  const seconds = first !== undefined && last !== undefined ? Number(last - first) / 1e9 : 0;
  if (topics.size) {
    const { shown, rest } = some([...topics].sort(([a], [b]) => a.localeCompare(b)), LISTED, "more topic(s)");
    lines.push("Topics:");
    for (const [topic, entry] of shown) {
      const rate = entry.messages > 1 && seconds > 0 ? `, about ${Number(((entry.messages - 1) / seconds).toPrecision(3))} per second` : "";
      lines.push(
        `  ${topic} [${[...entry.types].join(", ")}]: ${count(entry.messages)} message(s)${rate}` +
          (entry.connections > 1 ? `, over ${entry.connections} connections` : "") +
          (entry.callers.size ? `, from ${[...entry.callers].join(", ")}` : "") +
          (entry.latching ? ", latched" : ""),
      );
    }
    if (rest) lines.push(`  ${rest}`);
  }
  const orphans = [...counts.keys()].filter((id) => !connections.has(id));
  if (orphans.length) {
    lines.push(`  ${count(orphans.reduce((total, id) => total + (counts.get(id) ?? 0), 0))} message(s) are on ${orphans.length} connection(s) whose topic could not be read.`);
  }

  const types = new Map<string, string>();
  for (const connection of connections.values()) {
    if (connection.definition && !types.has(connection.type)) types.set(connection.type, definitionOf(connection.definition));
  }
  if (types.size) {
    const { shown, rest } = some([...types], 12, "more type(s)");
    lines.push("Message types:");
    for (const [type, definition] of shown) lines.push(`  ${type}: ${definition}`);
    if (rest) lines.push(`  ${rest}`);
  }

  unread.push("message bodies are in ROS serialization and were not decoded");
  lines.push(`Not read: ${unread.join("; ")}.`);
  return lines.join("\n");
}

export const rosbag: Format = {
  name: "a ROS bag",
  mimes: ["application/x-rosbag", "application/vnd.ros.bag", "application/rosbag"],
  extensions: ["bag"],
  sniff: (bytes) => startsWith(bytes, VERSION),
  read,
};

/** How every SQLite file begins; the sixteenth byte is a NUL. */
const SQLITE = "SQLite format 3\u0000";

/**
 * A ROS 2 bag in its SQLite form (`.db3`), recognised and not read.
 *
 * Reading it means reading SQLite's b-tree pages, which is a database engine and not a
 * container format. What can be said honestly is what the file is, how large its
 * database is, and whether it has the tables rosbag2 creates, whose definitions are
 * stored as plain text in the schema page.
 */
function readDb3(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const page = bytes.length >= 18 ? view.getUint16(16, false) || 65536 : 0;
  const pages = bytes.length >= 32 ? view.getUint32(28, false) : 0;
  const head = latin1(bytes.subarray(0, Math.min(bytes.length, 1 << 20)));
  const rosbag2 = /CREATE TABLE\s*"?topics"?/i.test(head) && /CREATE TABLE\s*"?messages"?/i.test(head);
  return [
    `A SQLite database of ${count(pages)} page(s) of ${count(page)} bytes; ${size(bytes.length)}.`,
    rosbag2
      ? "It has the `topics` and `messages` tables that a ROS 2 bag in SQLite form (rosbag2 .db3) has."
      : "It was sent as a ROS 2 bag. One in SQLite form has `topics` and `messages` tables, and their definitions were not found in its first megabyte.",
    "Not read: SQLite pages are not decoded here, so its topics, message counts and time range are unknown. " +
      "ROS 2 bags recorded as MCAP are read; `ros2 bag convert` writes one from a .db3 bag.",
  ].join("\n");
}

export const rosbag2: Format = {
  name: "a ROS 2 bag",
  mimes: ["application/x-rosbag2", "application/vnd.ros.bag2"],
  extensions: ["db3"],
  sniff: (bytes, declared) => declared && startsWith(bytes, SQLITE),
  read: readDb3,
};
