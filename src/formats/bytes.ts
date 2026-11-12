/**
 * What every binary reader here stands on: the bytes of an attachment, a cursor over
 * them that refuses to run past the end, and the few ways a number is said to a model.
 *
 * A reader is handed a file somebody recorded on a robot, which is to say a file that
 * may have been cut off when the battery went. So nothing here trusts a length it has
 * read: every read is checked against where the bytes actually end, and running out is
 * an error that says where, not a silent zero.
 */

import type { Attachment } from "../harness/types.js";

const DECODED = new WeakMap<Attachment, Uint8Array>();

/**
 * The bytes of an attachment, or nothing if it is only an address.
 *
 * Kept per attachment: a dozen formats are each asked whether a file is theirs, and
 * decoding the base64 of a recording once per question would cost more than the reading.
 */
export function bytesOf(attachment: Attachment): Uint8Array | undefined {
  if (attachment.data === undefined) return undefined;
  let bytes = DECODED.get(attachment);
  if (!bytes) {
    bytes = Buffer.from(attachment.data, "base64");
    DECODED.set(attachment, bytes);
  }
  return bytes;
}

/** The lower-cased extension of a file name, without the dot. */
export function extensionOf(name: string | undefined): string {
  const leaf = (name ?? "").split(/[\\/]/).pop() ?? "";
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(dot + 1).toLowerCase() : "";
}

/** A media type without its parameters, lower-cased. */
export const baseOf = (mime: string): string => (mime.split(";")[0] ?? "").trim().toLowerCase();

/** Whether `bytes` holds `magic` at `at`. */
export function startsWith(bytes: Uint8Array, magic: ArrayLike<number> | string, at = 0): boolean {
  if (at < 0 || at + magic.length > bytes.length) return false;
  for (let index = 0; index < magic.length; index++) {
    const want = typeof magic === "string" ? magic.charCodeAt(index) : magic[index];
    if (bytes[at + index] !== want) return false;
  }
  return true;
}

const UTF8 = new TextDecoder("utf-8");
const LATIN1 = new TextDecoder("latin1");

export const utf8 = (bytes: Uint8Array): string => UTF8.decode(bytes);
export const latin1 = (bytes: Uint8Array): string => LATIN1.decode(bytes);

/** A view over the same memory, whatever offset the bytes sit at in their buffer. */
export const viewOf = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * A place in some bytes, read forward, little-endian unless told otherwise.
 *
 * `end` bounds it to a record inside a larger file, so a record whose own length field
 * lies cannot make its reader walk into the record after it.
 */
export class Cursor {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  at: number;
  readonly end: number;

  constructor(bytes: Uint8Array, at = 0, end = bytes.length) {
    this.bytes = bytes;
    this.view = viewOf(bytes);
    this.at = at;
    this.end = Math.min(end, bytes.length);
  }

  get left(): number {
    return this.end - this.at;
  }

  private need(count: number): number {
    if (!(count >= 0) || this.at + count > this.end) {
      throw new Error(`it is cut short: ${count} byte(s) were expected at offset ${this.at}, and it ends at ${this.end}`);
    }
    const from = this.at;
    this.at += count;
    return from;
  }

  u8(): number {
    return this.view.getUint8(this.need(1));
  }
  u16(): number {
    return this.view.getUint16(this.need(2), true);
  }
  u32(): number {
    return this.view.getUint32(this.need(4), true);
  }
  i32(): number {
    return this.view.getInt32(this.need(4), true);
  }
  u64(): bigint {
    return this.view.getBigUint64(this.need(8), true);
  }
  /** A 64-bit offset or count as a number. Files this large are not handed over as base64. */
  size(): number {
    return Number(this.u64());
  }
  f64(): number {
    return this.view.getFloat64(this.need(8), true);
  }
  take(count: number): Uint8Array {
    const from = this.need(count);
    return this.bytes.subarray(from, from + count);
  }
  text(count: number): string {
    return utf8(this.take(count));
  }
  skip(count: number): void {
    this.need(count);
  }
  /** A cursor over the next `count` bytes, which this one steps past. */
  sub(count: number): Cursor {
    const from = this.need(count);
    return new Cursor(this.bytes, from, from + count);
  }
}

/** A count, with separators: a model misreads 1250000 and does not misread 1,250,000. */
export const count = (value: number | bigint): string => value.toLocaleString("en-US");

/** A size in bytes, in the unit a person would say it in. */
export function size(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1000;
    unit++;
  } while (value >= 1000 && unit < units.length - 1);
  return `${value >= 100 ? Math.round(value) : Number(value.toPrecision(3))} ${units[unit]}`;
}

/** The first `most` of a list, and how many were left out. */
export function some<T>(items: readonly T[], most: number, what = "more"): { shown: T[]; rest: string } {
  return items.length <= most
    ? { shown: [...items], rest: "" }
    : { shown: items.slice(0, most), rest: `… and ${count(items.length - most)} ${what}` };
}

/** Text cut to a length, saying that it was. */
export function clip(text: string, most: number): string {
  return text.length <= most ? text : `${text.slice(0, most)}… (${count(text.length - most)} more characters)`;
}

/**
 * A time in nanoseconds, said as a date when it plainly is one.
 *
 * Recordings count from the Unix epoch or from when the robot booted, and nothing in the
 * file says which. A count that lands between 2001 and 2100 is taken for a date; anything
 * else is left as seconds from whatever the recorder counted from.
 */
export function when(nanoseconds: bigint): string {
  const seconds = Number(nanoseconds) / 1e9;
  if (seconds > 978_307_200 && seconds < 4_102_444_800) {
    return new Date(Number(nanoseconds / 1_000_000n)).toISOString();
  }
  return `${Number(seconds.toPrecision(12))}s`;
}

/** A span of seconds, in the unit that keeps it readable. */
export function span(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "an unknown time";
  if (seconds < 1) return `${Number((seconds * 1000).toPrecision(3))} ms`;
  if (seconds < 120) return `${Number(seconds.toPrecision(4))} s`;
  if (seconds < 7200) return `${Number((seconds / 60).toPrecision(3))} min`;
  return `${Number((seconds / 3600).toPrecision(3))} h`;
}

/** "from A to B (lasting C)", for a recording's first and last message. */
export function range(start: bigint, end: bigint): string {
  return `${when(start)} to ${when(end)} (${span(Number(end - start) / 1e9)})`;
}

/** Bytes as text where they are printable, as hex where they are not. */
export function printable(bytes: Uint8Array, most = 48): string {
  const head = bytes.subarray(0, most);
  let plain = head.length > 0;
  for (const byte of head) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) plain = false;
  }
  if (plain) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(head);
      return JSON.stringify(text) + (bytes.length > most ? "…" : "");
    } catch {
      // Not text after all; shown as hex below.
    }
  }
  return `0x${Buffer.from(head).toString("hex")}${bytes.length > most ? "…" : ""}`;
}

/**
 * A format this plugin reads: what it is called, how a file declares itself as one, how
 * its bytes give it away, and the rendering.
 */
export interface Format {
  /** What a rendering is said to be shown as: "an MCAP recording". */
  name: string;
  /** The media types a file of this format is sent under. */
  mimes: readonly string[];
  /** The file extensions it goes by, without the dot. */
  extensions: readonly string[];
  /**
   * Media types that say nothing about what a file is, under which this format still
   * arrives and is then told by its bytes: `text/plain` for a format written as text,
   * `application/zip` for one that is a zip archive.
   */
  loose?: readonly string[];
  /**
   * Set where a media type is shared with another format here (a PLY file may be splats
   * or a plain point cloud): a file under that type that is not this format is the other
   * one's to read, not a mislabelled file.
   */
  shared?: boolean;
  /**
   * Whether these bytes are this format. `declared` is true when the media type or the
   * file name already said so, which is all a format with no magic number has to go on.
   */
  sniff(bytes: Uint8Array, declared: boolean): boolean;
  /** What a model should read of it, or nothing to let another reader try. */
  read(bytes: Uint8Array, attachment: Attachment): string | undefined;
}

/** The media types a file is given when whoever sent it did not know what it was. */
const UNSAID = new Set(["", "application/octet-stream", "binary/octet-stream", "application/x-binary"]);

/** Whether a format should be asked about a media type at all. */
export function offered(format: Format, mime: string): boolean {
  const base = baseOf(mime);
  return format.mimes.includes(base) || UNSAID.has(base) || (format.loose ?? []).includes(base);
}

/**
 * Ask a format about an attachment.
 *
 * A file that says it is MCAP and does not begin as one is an error, said in a note: the
 * sender should hear that the file is not what they called it. A file that said nothing
 * and is not this format is simply not this format, and the next reader is asked.
 */
export function readAs(format: Format, attachment: Attachment): string | undefined {
  const bytes = bytesOf(attachment);
  if (!bytes) return undefined;
  const named = format.mimes.includes(baseOf(attachment.mime));
  const declared = named || format.extensions.includes(extensionOf(attachment.name));
  if (!format.sniff(bytes, declared)) {
    if (named && !format.shared) throw new Error("its bytes do not begin the way that format does");
    return undefined;
  }
  return format.read(bytes, attachment);
}
