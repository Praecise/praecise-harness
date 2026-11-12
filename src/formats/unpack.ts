/**
 * Undoing the compressions these containers use, with what Node has and nothing else.
 *
 * `node:zlib` does deflate, gzip and brotli on every supported Node, and zstd only from
 * 22.15. LZ4 and LZF it does not do at all, but both are small enough to write out: an
 * LZ4 block is a loop of "copy these literals, then repeat that much from this far
 * back", and the frame around it is a header and a list of blocks. bzip2 is neither in
 * Node nor small, so a chunk compressed with it is reported and left alone.
 *
 * Nothing here verifies a checksum. These decoders are for showing a model a sample; a
 * reader that needs to trust every byte has a real codec.
 */

import * as zlib from "node:zlib";

import { viewOf } from "./bytes.js";

/** The most a reader will unpack to look inside one chunk. A sample does not need more. */
export const MOST = 64 * 1024 * 1024;

/** Bytes that grow as they are written, and can be copied from behind the write point. */
class Out {
  bytes: Uint8Array;
  length = 0;

  constructor(room: number) {
    this.bytes = new Uint8Array(Math.max(64, room));
  }

  private fit(more: number): void {
    if (this.length + more <= this.bytes.length) return;
    if (this.length + more > MOST) throw new Error(`it unpacks to more than ${MOST} bytes`);
    const grown = new Uint8Array(Math.min(MOST, Math.max(this.bytes.length * 2, this.length + more)));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  push(chunk: Uint8Array): void {
    this.fit(chunk.length);
    this.bytes.set(chunk, this.length);
    this.length += chunk.length;
  }

  /** Repeat `count` bytes from `back` bytes ago. They may overlap what is being written, so one at a time. */
  repeat(back: number, count: number): void {
    if (back <= 0 || back > this.length) throw new Error("a back-reference points before the start of the data");
    this.fit(count);
    const bytes = this.bytes;
    let from = this.length - back;
    let to = this.length;
    for (let index = 0; index < count; index++) bytes[to++] = bytes[from++]!;
    this.length = to;
  }

  done(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }
}

/** One LZ4 block (the LZ4 block format), appended to what has been unpacked so far. */
function lz4Into(src: Uint8Array, out: Out): void {
  let at = 0;
  const end = src.length;
  while (at < end) {
    const token = src[at++]!;
    let literals = token >> 4;
    if (literals === 15) {
      let more: number;
      do {
        if (at >= end) throw new Error("an LZ4 block ends inside a length");
        more = src[at++]!;
        literals += more;
      } while (more === 255);
    }
    if (at + literals > end) throw new Error("an LZ4 block ends inside its literals");
    out.push(src.subarray(at, at + literals));
    at += literals;
    // The last sequence of a block is literals only.
    if (at >= end) break;
    if (at + 2 > end) throw new Error("an LZ4 block ends inside an offset");
    const back = src[at]! | (src[at + 1]! << 8);
    at += 2;
    let length = token & 15;
    if (length === 15) {
      let more: number;
      do {
        if (at >= end) throw new Error("an LZ4 block ends inside a length");
        more = src[at++]!;
        length += more;
      } while (more === 255);
    }
    out.repeat(back, length + 4);
  }
}

/** A bare LZ4 block, as USD crate files and Parquet's LZ4_RAW hold. */
export function lz4Block(src: Uint8Array, room = src.length * 3): Uint8Array {
  const out = new Out(room);
  lz4Into(src, out);
  return out.done();
}

/**
 * An LZ4 frame (the LZ4 frame format, magic 0x184D2204): what MCAP's `lz4` chunks,
 * Arrow's compressed buffers and the `lz4` command write.
 */
export function lz4Frame(src: Uint8Array, room = src.length * 3): Uint8Array {
  const view = viewOf(src);
  const out = new Out(room);
  let at = 0;
  while (at + 4 <= src.length) {
    const magic = view.getUint32(at, true);
    at += 4;
    // A skippable frame carries somebody's metadata; it is stepped over.
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      at += 4 + view.getUint32(at, true);
      continue;
    }
    if (magic !== 0x184d2204) throw new Error("it is not an LZ4 frame");
    const flags = src[at]!;
    if (flags >> 6 !== 1) throw new Error("it is an LZ4 frame of a version this does not read");
    const blockChecksum = (flags & 0x10) !== 0;
    const contentSize = (flags & 0x08) !== 0;
    const contentChecksum = (flags & 0x04) !== 0;
    const dictionary = (flags & 0x01) !== 0;
    // FLG, BD, the optional content size and dictionary id, then the header checksum.
    at += 2 + (contentSize ? 8 : 0) + (dictionary ? 4 : 0) + 1;
    for (;;) {
      if (at + 4 > src.length) throw new Error("an LZ4 frame ends before its end mark");
      const word = view.getUint32(at, true);
      at += 4;
      if (word === 0) break;
      const length = word & 0x7fffffff;
      if (at + length > src.length) throw new Error("an LZ4 frame ends inside a block");
      const block = src.subarray(at, at + length);
      at += length + (blockChecksum ? 4 : 0);
      // The high bit marks a block stored as it is.
      if (word & 0x80000000) out.push(block);
      else lz4Into(block, out);
    }
    if (contentChecksum) at += 4;
  }
  return out.done();
}

/**
 * LZF, as the Point Cloud Library's `binary_compressed` PCD files hold: a control byte
 * under 32 is a run of that many literals plus one; anything else is a back-reference
 * whose length is its top three bits (with an extra byte when they are all set).
 */
export function lzf(src: Uint8Array, room: number): Uint8Array {
  const out = new Out(room);
  let at = 0;
  while (at < src.length) {
    const control = src[at++]!;
    if (control < 32) {
      const run = control + 1;
      if (at + run > src.length) throw new Error("LZF data ends inside a literal run");
      out.push(src.subarray(at, at + run));
      at += run;
    } else {
      let length = control >> 5;
      if (length === 7) length += src[at++]!;
      if (at >= src.length) throw new Error("LZF data ends inside a back-reference");
      const back = (((control & 0x1f) << 8) | src[at++]!) + 1;
      out.repeat(back, length + 2);
    }
  }
  return out.done();
}

type Unzstd = (data: Uint8Array, options?: { maxOutputLength?: number }) => Uint8Array;

/** zstd, where this Node has it (22.15 and later). Asked each time, so a test can see both. */
const zstd = (): Unzstd | undefined => {
  const found = (zlib as unknown as { zstdDecompressSync?: Unzstd }).zstdDecompressSync;
  return typeof found === "function" ? found : undefined;
};

/** Whether a compression named in a container can be undone here. */
export function unpacks(compression: string): boolean {
  const name = compression.toLowerCase();
  if (name === "zstd") return zstd() !== undefined;
  return ["", "none", "lz4", "zlib", "deflate", "gzip", "brotli"].includes(name);
}

/** Why a compression cannot be undone here, for the rendering to say. */
export function whyNot(compression: string): string {
  const name = compression.toLowerCase();
  if (name === "zstd") return `zstd needs Node 22.15 or later, and this is ${process.version}`;
  if (name === "bz2" || name === "bzip2") return "bzip2 is not in Node";
  return `"${compression}" is not a compression this reads`;
}

/**
 * Undo a compression by the name a container gives it. Throws, with the reason, where it
 * cannot: the caller says so in its rendering and goes on with what it could read.
 */
export function unpack(compression: string, data: Uint8Array, unpacked?: number): Uint8Array {
  const name = compression.toLowerCase();
  if (unpacked !== undefined && unpacked > MOST) throw new Error(`it unpacks to ${unpacked} bytes, more than is unpacked for a sample`);
  const limit = { maxOutputLength: MOST };
  switch (name) {
    case "":
    case "none":
      return data;
    case "lz4":
      return lz4Frame(data, unpacked);
    case "zlib":
      return zlib.inflateSync(data, limit);
    case "deflate":
      return zlib.inflateRawSync(data, limit);
    case "gzip":
      return zlib.gunzipSync(data, limit);
    case "brotli":
      return zlib.brotliDecompressSync(data, limit);
    case "zstd": {
      const run = zstd();
      if (run) return run(data, limit);
      throw new Error(whyNot(name));
    }
    default:
      throw new Error(whyNot(compression));
  }
}
