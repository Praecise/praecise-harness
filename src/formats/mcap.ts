/**
 * MCAP: the container robot logs are recorded in, and what ROS 2 writes by default.
 *
 * A file is a magic number, a run of records (`<opcode><length><content>`), and the
 * magic again. Messages sit in chunks, usually compressed; after them a summary section
 * repeats every schema and channel and adds statistics and an index of the chunks, and a
 * footer at the very end says where that summary starts. So a finished recording is
 * described from its last few kilobytes without touching a message, and that is what is
 * done here. A recording that was cut off has no summary, and is walked from the front
 * instead, counting what is found.
 *
 * Message bodies are in whatever encoding the channel names (`cdr`, `ros1`, `protobuf`,
 * `json`, ...). Only JSON is text; the rest need the schema's own decoder, which this is
 * not. The rendering says which channels were left as byte counts.
 *
 * Layout from the MCAP specification (mcap.dev/spec), read on 2026-11-13.
 */

import type { Format } from "./bytes.js";
import { clip, count, Cursor, range, size, some, startsWith, utf8, when } from "./bytes.js";
import { unpack, unpacks, whyNot } from "./unpack.js";

const MAGIC = [0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a];

const HEADER = 0x01;
const FOOTER = 0x02;
const SCHEMA = 0x03;
const CHANNEL = 0x04;
const MESSAGE = 0x05;
const CHUNK = 0x06;
const CHUNK_INDEX = 0x08;
const ATTACHMENT = 0x09;
const ATTACHMENT_INDEX = 0x0a;
const STATISTICS = 0x0b;
const METADATA = 0x0c;
const METADATA_INDEX = 0x0d;

/** How many messages of each channel a model is shown. */
const SAMPLES = 3;
/** How many channels, schemas and attachments are listed before the rest are counted. */
const LISTED = 40;

interface Schema {
  id: number;
  name: string;
  encoding: string;
  data: Uint8Array;
}

interface Channel {
  id: number;
  schema: number;
  topic: string;
  encoding: string;
}

interface Sample {
  time: bigint;
  data: Uint8Array;
}

interface Found {
  schemas: Map<number, Schema>;
  channels: Map<number, Channel>;
  /** Messages counted per channel, when they had to be counted by walking. */
  counts: Map<number, number>;
  samples: Map<number, Sample[]>;
  first?: bigint;
  last?: bigint;
  messages: number;
}

const text = (cursor: Cursor): string => cursor.text(cursor.u32());

/** Each record between two offsets. Stops quietly at a record that runs past the end. */
function* records(bytes: Uint8Array, from: number, to: number): Generator<{ op: number; body: Cursor; start: number; cut?: boolean }> {
  let at = from;
  while (at + 9 <= to) {
    const head = new Cursor(bytes, at, to);
    const op = head.u8();
    const length = head.size();
    if (head.at + length > to) {
      yield { op, body: new Cursor(bytes, head.at, to), start: at, cut: true };
      return;
    }
    yield { op, body: new Cursor(bytes, head.at, head.at + length), start: at };
    at = head.at + length;
  }
}

function schemaOf(body: Cursor): Schema {
  const id = body.u16();
  const name = text(body);
  const encoding = text(body);
  return { id, name, encoding, data: body.take(body.u32()) };
}

function channelOf(body: Cursor): Channel {
  const id = body.u16();
  const schema = body.u16();
  const topic = text(body);
  return { id, schema, topic, encoding: text(body) };
}

/** Take in a schema, channel or message record, wherever it was found. */
function note(found: Found, op: number, body: Cursor, counting: boolean): void {
  if (op === SCHEMA) {
    const schema = schemaOf(body);
    if (schema.id !== 0) found.schemas.set(schema.id, schema);
  } else if (op === CHANNEL) {
    const channel = channelOf(body);
    found.channels.set(channel.id, channel);
  } else if (op === MESSAGE) {
    const channel = body.u16();
    body.skip(4);
    const time = body.u64();
    body.skip(8);
    const kept = found.samples.get(channel) ?? [];
    if (kept.length < SAMPLES) {
      kept.push({ time, data: body.take(body.left) });
      found.samples.set(channel, kept);
    }
    if (counting) {
      found.messages++;
      found.counts.set(channel, (found.counts.get(channel) ?? 0) + 1);
      if (found.first === undefined || time < found.first) found.first = time;
      if (found.last === undefined || time > found.last) found.last = time;
    }
  }
}

interface Chunk {
  compression: string;
  packed: number;
  unpacked: number;
  records: Uint8Array;
}

function chunkOf(body: Cursor): Chunk {
  body.skip(16);
  const unpacked = body.size();
  body.skip(4);
  const compression = text(body);
  const packed = body.size();
  return { compression, packed, unpacked, records: body.take(Math.min(packed, body.left)) };
}

function sampleOf(channel: Channel, sample: Sample): string {
  const at = when(sample.time);
  if (channel.encoding === "json") return `at ${at}: ${clip(utf8(sample.data), 240)}`;
  return `at ${at}: ${count(sample.data.length)} bytes`;
}

/** A schema's own text, where its encoding is one a person writes. */
function schemaText(schema: Schema): string | undefined {
  if (!["ros1msg", "ros2msg", "ros2idl", "jsonschema", "omgidl"].includes(schema.encoding) || !schema.data.length) return undefined;
  // A ROS definition carries every nested type after a line of equals signs; the first block is the message itself.
  const own = utf8(schema.data).split(/\n=+\n/)[0]!;
  const lines = own.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#"));
  return clip(lines.join("; "), 360);
}

function read(bytes: Uint8Array): string {
  const lines: string[] = [];
  const unread: string[] = [];
  const found: Found = { schemas: new Map(), channels: new Map(), counts: new Map(), samples: new Map(), messages: 0 };

  let profile = "";
  let library = "";
  const first = records(bytes, MAGIC.length, bytes.length).next().value;
  if (first && first.op === HEADER && !first.cut) {
    profile = text(first.body);
    library = text(first.body);
  }

  // A finished file ends with a footer record (29 bytes) and the magic.
  const finished = bytes.length >= MAGIC.length * 2 + 29 && startsWith(bytes, MAGIC, bytes.length - MAGIC.length);
  const footerAt = bytes.length - MAGIC.length - 29;
  let summaryStart = 0;
  if (finished && bytes[footerAt] === FOOTER) {
    summaryStart = new Cursor(bytes, footerAt + 9).size();
  }

  let statistics: { messages: number; chunks: number; attachments: number; metadata: number; start: bigint; end: bigint } | undefined;
  const channelCounts = new Map<number, number>();
  const chunks: { offset: number; compression: string; packed: number; unpacked: number }[] = [];
  const attachments: string[] = [];
  const metadata: { name: string; offset: number; length: number }[] = [];
  let chunkCount = 0;
  let walked = false;

  if (summaryStart > 0 && summaryStart < footerAt) {
    for (const { op, body, cut } of records(bytes, summaryStart, footerAt)) {
      if (cut) break;
      if (op === SCHEMA || op === CHANNEL) note(found, op, body, false);
      else if (op === STATISTICS) {
        const messages = body.size();
        body.skip(6);
        const attached = body.u32();
        const meta = body.u32();
        const chunked = body.u32();
        const start = body.u64();
        const end = body.u64();
        const map = body.sub(body.u32());
        while (map.left >= 10) channelCounts.set(map.u16(), map.size());
        statistics = { messages, chunks: chunked, attachments: attached, metadata: meta, start, end };
      } else if (op === CHUNK_INDEX) {
        body.skip(16);
        const offset = body.size();
        body.skip(8);
        body.skip(body.u32());
        body.skip(8);
        const compression = text(body);
        chunks.push({ offset, compression, packed: body.size(), unpacked: body.size() });
      } else if (op === ATTACHMENT_INDEX) {
        body.skip(32);
        const bytesIn = body.size();
        const name = text(body);
        attachments.push(`${name} (${text(body) || "no media type"}, ${size(bytesIn)})`);
      } else if (op === METADATA_INDEX) {
        const offset = body.size();
        const length = body.size();
        metadata.push({ name: text(body), offset, length });
      }
    }
    chunkCount = statistics?.chunks ?? chunks.length;
  }

  // No summary, or one without statistics: the data section is walked and counted.
  // Schemas, channels and loose messages are in the open; the rest are inside chunks.
  const counting = !statistics;
  let unpackedAll = true;
  if (counting || !found.channels.size) {
    walked = true;
    const end = summaryStart > 0 ? summaryStart : finished ? footerAt : bytes.length;
    let budget = 256 * 1024 * 1024;
    for (const { op, body, start, cut } of records(bytes, MAGIC.length, end)) {
      if (cut) {
        unread.push(`the record at offset ${count(start)} runs past the end of the file, so the recording was cut off there`);
        break;
      }
      if (op === CHUNK) {
        const chunk = chunkOf(body);
        if (!chunks.some((known) => known.offset === start)) {
          chunks.push({ offset: start, compression: chunk.compression, packed: chunk.packed, unpacked: chunk.unpacked });
        }
        if (!unpacks(chunk.compression) || chunk.unpacked > budget) {
          unpackedAll = false;
          continue;
        }
        try {
          const inner = unpack(chunk.compression, chunk.records, chunk.unpacked);
          budget -= inner.length;
          for (const record of records(inner, 0, inner.length)) note(found, record.op, record.body, counting);
        } catch {
          unpackedAll = false;
        }
      } else if (op === ATTACHMENT && !statistics) {
        body.skip(16);
        const name = text(body);
        const media = text(body);
        attachments.push(`${name} (${media || "no media type"}, ${size(body.size())})`);
      } else if (op === METADATA && !statistics) {
        metadata.push({ name: text(body), offset: start, length: body.end - start });
      } else {
        note(found, op, body, counting);
      }
    }
    if (counting) chunkCount = chunks.length;
  } else if (chunks.length) {
    // A summary says everything but what a message looks like: the first chunk is opened for that.
    const head = chunks[0]!;
    try {
      const record = records(bytes, head.offset, bytes.length).next().value;
      if (record && record.op === CHUNK && !record.cut) {
        const chunk = chunkOf(record.body);
        const inner = unpack(chunk.compression, chunk.records, chunk.unpacked);
        for (const each of records(inner, 0, inner.length)) note(found, each.op, each.body, false);
      }
    } catch {
      // Said below, with the reason, where the compressions are listed.
    }
  }

  const messages = statistics?.messages ?? found.messages;
  const start = statistics?.start ?? found.first;
  const end = statistics?.end ?? found.last;
  const counts = statistics && channelCounts.size ? channelCounts : found.counts;

  const about = [profile ? `profile "${profile}"` : "", library ? `written by ${library}` : ""].filter(Boolean).join(", ");
  lines.push(
    `An MCAP recording${about ? ` (${about})` : ""}: ${count(messages)} message(s) on ${count(found.channels.size)} channel(s), ` +
      `${count(chunkCount)} chunk(s), ${count(statistics?.attachments ?? attachments.length)} attachment(s), ` +
      `${count(statistics?.metadata ?? metadata.length)} metadata record(s); ${size(bytes.length)}.`,
  );
  if (!finished) lines.push("The file has no footer: it was not closed, so it has no summary and what follows was counted from the records found.");
  else if (walked && counting) lines.push("The file has no statistics record, so messages were counted by reading the data section.");
  if (start !== undefined && end !== undefined && messages > 0) lines.push(`Time: ${range(start, end)}.`);

  if (chunks.length) {
    const by = new Map<string, { chunks: number; packed: number; unpacked: number }>();
    for (const chunk of chunks) {
      const entry = by.get(chunk.compression) ?? { chunks: 0, packed: 0, unpacked: 0 };
      entry.chunks++;
      entry.packed += chunk.packed;
      entry.unpacked += chunk.unpacked;
      by.set(chunk.compression, entry);
    }
    lines.push(
      `Chunks: ${[...by].map(([name, entry]) => `${count(entry.chunks)} ${name ? `compressed with ${name}` : "uncompressed"} (${size(entry.packed)} stored, ${size(entry.unpacked)} unpacked)`).join("; ")}.`,
    );
    for (const name of by.keys()) {
      if (!unpacks(name)) unread.push(`chunks compressed with ${name} were not opened (${whyNot(name)})`);
    }
  }

  const seconds = start !== undefined && end !== undefined ? Number(end - start) / 1e9 : 0;
  const channels = [...found.channels.values()].sort((a, b) => a.topic.localeCompare(b.topic));
  if (channels.length) {
    const { shown, rest } = some(channels, LISTED, "more channel(s)");
    lines.push("Channels:");
    for (const channel of shown) {
      const schema = found.schemas.get(channel.schema);
      const total = counts.get(channel.id);
      const rate = total !== undefined && total > 1 && seconds > 0 ? `, about ${Number(((total - 1) / seconds).toPrecision(3))} per second` : "";
      lines.push(
        `  ${channel.topic} [${schema?.name || "no schema"}, ${channel.encoding || "no encoding named"}]` +
          (total !== undefined ? `: ${count(total)} message(s)${rate}` : counts.size ? ": 0 messages" : ""),
      );
    }
    if (rest) lines.push(`  ${rest}`);
    if (!counts.size && messages > 0) lines.push("  (the file does not say how many messages each channel has)");
    if (counting && !unpackedAll) lines.push("  (counts leave out the messages in chunks that could not be opened)");
  }

  const defined = [...found.schemas.values()].map((schema) => ({ schema, body: schemaText(schema) })).filter((entry) => entry.body);
  if (defined.length) {
    const { shown, rest } = some(defined, 12, "more schema(s)");
    lines.push("Schemas:");
    for (const { schema, body } of shown) lines.push(`  ${schema.name} (${schema.encoding}): ${body}`);
    if (rest) lines.push(`  ${rest}`);
  }

  if (attachments.length) {
    const { shown, rest } = some(attachments, LISTED, "more");
    lines.push(`Attachments: ${shown.join(", ")}${rest ? `, ${rest}` : ""}.`);
  }

  if (metadata.length) {
    const { shown, rest } = some(metadata, 12, "more");
    lines.push("Metadata:");
    for (const entry of shown) {
      let pairs = "";
      try {
        const record = records(bytes, entry.offset, bytes.length).next().value;
        if (record && record.op === METADATA && !record.cut) {
          record.body.skip(record.body.u32());
          const map = record.body.sub(record.body.u32());
          const said: string[] = [];
          while (map.left >= 8 && said.length < 12) said.push(`${text(map)}=${clip(text(map), 80)}`);
          pairs = said.join(", ");
        }
      } catch {
        pairs = "";
      }
      lines.push(`  ${entry.name}${pairs ? `: ${pairs}` : ""}`);
    }
    if (rest) lines.push(`  ${rest}`);
  }

  const sampled = channels.filter((channel) => found.samples.get(channel.id)?.length);
  if (sampled.length) {
    const { shown, rest } = some(sampled, 16, "more channel(s) with messages");
    lines.push(`First message(s) of each channel${walked ? "" : ", from the first chunk"}:`);
    const binary = new Set<string>();
    for (const channel of shown) {
      if (channel.encoding !== "json") binary.add(channel.encoding || "unnamed");
      lines.push(`  ${channel.topic}`);
      for (const sample of found.samples.get(channel.id)!) lines.push(`    ${sampleOf(channel, sample)}`);
    }
    if (rest) lines.push(`  ${rest}`);
    if (binary.size) {
      unread.push(`message bodies in ${[...binary].join(", ")} encoding are binary and were not decoded: only their sizes are shown`);
    }
  } else if (messages > 0) {
    unread.push("no message was sampled, because the first chunk could not be opened");
  }

  const unknown = [...found.schemas.values()].filter((schema) => schema.data.length && !schemaText(schema));
  if (unknown.length) {
    unread.push(`${count(unknown.length)} schema(s) in ${[...new Set(unknown.map((schema) => schema.encoding))].join(", ")} encoding are named but their definitions are not shown`);
  }
  if (attachments.length) unread.push("attachment contents were not read");
  if (unread.length) lines.push(`Not read: ${unread.join("; ")}.`);
  return lines.join("\n");
}

export const mcap: Format = {
  name: "an MCAP recording",
  mimes: ["application/mcap", "application/x-mcap", "application/vnd.mcap"],
  extensions: ["mcap"],
  sniff: (bytes) => startsWith(bytes, MAGIC),
  read,
};
