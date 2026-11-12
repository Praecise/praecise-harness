/**
 * Unpacking a skill archive without trusting it.
 *
 * The discovery convention ships a skill with more than one file as a `.tar.gz` or a
 * `.zip`, and asks every client to read both. An archive is the oldest way there is to
 * write a file somewhere its recipient did not expect, so what is read here is narrow
 * on purpose: regular files and directories, with relative paths that stay under the
 * root. A link of either kind, an absolute path, a `..`, a device, an encrypted or
 * 64-bit zip — each is a refusal of the whole archive, not an entry skipped, because an
 * archive that tries one of those once is not one to take the rest of.
 *
 * Nothing is written from here. The files come back in memory, bounded in number and
 * in size, for the installer to place.
 */

import { gunzipSync, inflateRawSync } from "node:zlib";

export interface ArchiveFile {
  /** Relative, forward slashes, no `.` or `..` segments. */
  path: string;
  data: Uint8Array;
}

export interface ArchiveLimits {
  /** Total unpacked bytes. Default 20 MB. */
  bytes?: number;
  /** Number of files. Default 500. */
  files?: number;
}

const DEFAULT_BYTES = 20 * 1024 * 1024;
const DEFAULT_FILES = 500;

/**
 * A path from an archive, as one that is safe to join under a folder — or a refusal.
 *
 * A backslash and a colon are refused outright, not normalised: on one platform they
 * are part of a file name and on another they are a separator and a drive, and a path
 * that means two things is how a check on one machine is passed for a write on another.
 */
export function safeRelativePath(raw: string): string {
  const refuse = (why: string): never => {
    throw new Error(`the archive holds ${JSON.stringify(raw.slice(0, 120))}, ${why}; nothing was unpacked`);
  };
  // Control characters have no place in a file name and every place in a trick.
  // oxlint-disable-next-line no-control-regex
  if (!raw || /[\u0000-\u001f]/.test(raw)) refuse("which is not a usable path");
  if (raw.includes("\\") || raw.includes(":")) refuse("which has a backslash or a colon in it");
  if (raw.startsWith("/")) refuse("which is an absolute path");
  const parts = raw.replace(/^(\.\/)+/, "").replace(/\/+$/, "").split("/");
  for (const part of parts) {
    if (part === "..") refuse("which climbs out of the skill's folder");
    if (part === "" || part === ".") refuse("which is not a plain relative path");
  }
  return parts.join("/");
}

class Budget {
  private bytes = 0;
  private files = 0;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(maxBytes: number, maxFiles: number) {
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
  }

  /** How much may still be unpacked. */
  get left(): number {
    return Math.max(0, this.maxBytes - this.bytes);
  }

  take(size: number): void {
    this.bytes += size;
    this.files += 1;
    if (this.bytes > this.maxBytes) {
      throw new Error(`the archive unpacks to more than ${this.maxBytes.toLocaleString("en")} bytes; nothing was unpacked`);
    }
    if (this.files > this.maxFiles) {
      throw new Error(`the archive holds more than ${this.maxFiles} files; nothing was unpacked`);
    }
  }
}

const ascii = (bytes: Uint8Array, from: number, length: number): string => {
  const slice = bytes.subarray(from, from + length);
  const end = slice.indexOf(0);
  return Buffer.from(end < 0 ? slice : slice.subarray(0, end)).toString("utf8");
};

/** Read a gzipped tar. */
function untar(packed: Uint8Array, budget: Budget): ArchiveFile[] {
  let tar: Uint8Array;
  try {
    // One block over the budget, so a bomb is refused by the budget and in its words.
    tar = gunzipSync(packed, { maxOutputLength: budget.left + 1024 * 1024 });
  } catch (err) {
    throw new Error(`the archive could not be read as .tar.gz (${(err as Error).message}); nothing was unpacked`, { cause: err });
  }

  const files: ArchiveFile[] = [];
  /** A name carried by a header that comes before the entry it names. */
  let longName: string | undefined;
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(ascii(header, 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("the archive has an entry whose size cannot be read; nothing was unpacked");
    const type = String.fromCharCode(header[156] || 48);
    const prefix = ascii(header, 257, 5) === "ustar" ? ascii(header, 345, 155) : "";
    const name = longName ?? (prefix ? `${prefix}/${ascii(header, 0, 100)}` : ascii(header, 0, 100));
    const body = tar.subarray(at + 512, at + 512 + size);
    if (body.length !== size) throw new Error("the archive ends in the middle of a file; nothing was unpacked");
    at += 512 + Math.ceil(size / 512) * 512;
    longName = undefined;

    if (type === "x") {
      // Extended header for the next entry: `<length> key=value\n` records. Only the path matters here.
      const records = Buffer.from(body).toString("utf8");
      const found = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(records);
      if (found) longName = found[1];
    } else if (type === "L") {
      longName = ascii(body, 0, body.length);
    } else if (type === "g" || type === "5") {
      // Archive-wide settings, and directories: a file's own path makes its folders.
    } else if (type === "0" || type === "7") {
      const path = safeRelativePath(name);
      budget.take(size);
      files.push({ path, data: body.slice() });
    } else {
      const what = type === "1" || type === "2" ? "a link" : "something that is not a file";
      throw new Error(`the archive holds ${what} at ${JSON.stringify(name.slice(0, 120))}; nothing was unpacked`);
    }
  }
  return files;
}

const u16 = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8);
const u32 = (bytes: Uint8Array, at: number): number => (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0;

/** Read a zip, from its central directory: the one list that names every entry once. */
function unzip(zip: Uint8Array, budget: Budget): ArchiveFile[] {
  const broken = (why: string): Error => new Error(`the archive could not be read as .zip (${why}); nothing was unpacked`);
  let end = -1;
  for (let at = zip.length - 22; at >= 0 && at >= zip.length - 22 - 0xffff; at--) {
    if (u32(zip, at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw broken("it has no end record");
  const count = u16(zip, end + 10);
  let at = u32(zip, end + 16);
  if (count === 0xffff || at === 0xffffffff) throw broken("it is a 64-bit zip, which is not read here");

  const files: ArchiveFile[] = [];
  for (let index = 0; index < count; index++) {
    if (at + 46 > zip.length || u32(zip, at) !== 0x02014b50) throw broken("its directory is cut short");
    const madeBy = u16(zip, at + 4);
    const flags = u16(zip, at + 8);
    const method = u16(zip, at + 10);
    const packedSize = u32(zip, at + 20);
    const size = u32(zip, at + 24);
    const nameLength = u16(zip, at + 28);
    const extraLength = u16(zip, at + 30);
    const commentLength = u16(zip, at + 32);
    const external = u32(zip, at + 38);
    const local = u32(zip, at + 42);
    const name = Buffer.from(zip.subarray(at + 46, at + 46 + nameLength)).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;

    if (flags & 1) throw broken("it is encrypted");
    if (packedSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw broken("it is a 64-bit zip, which is not read here");
    // The upper half of the external attributes is a Unix mode when a Unix made the entry.
    const mode = madeBy >>> 8 === 3 ? (external >>> 16) & 0o170000 : 0;
    if (mode === 0o120000) throw new Error(`the archive holds a link at ${JSON.stringify(name.slice(0, 120))}; nothing was unpacked`);
    if (name.endsWith("/")) continue;
    if (mode !== 0 && mode !== 0o100000) {
      throw new Error(`the archive holds something that is not a file at ${JSON.stringify(name.slice(0, 120))}; nothing was unpacked`);
    }

    const path = safeRelativePath(name);
    if (local + 30 > zip.length || u32(zip, local) !== 0x04034b50) throw broken("an entry points at nothing");
    const start = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
    const packed = zip.subarray(start, start + packedSize);
    if (packed.length !== packedSize) throw broken("an entry is cut short");

    let data: Uint8Array;
    if (method === 0) data = packed.slice();
    else if (method === 8) {
      try {
        data = inflateRawSync(packed, { maxOutputLength: Math.max(1, budget.left + 1) });
      } catch (err) {
        if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") budget.take(budget.left + 1);
        throw broken((err as Error).message);
      }
    } else throw broken(`it uses compression method ${method}, which is not read here`);
    if (data.length !== size) throw broken("an entry is not the size its directory says");
    budget.take(data.length);
    files.push({ path, data });
  }
  return files;
}

/** Which kind of archive this is: what the server said, then the name, then the bytes. */
export function archiveFormat(contentType: string | null | undefined, url: string, bytes: Uint8Array): "tar.gz" | "zip" | undefined {
  const said = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (said === "application/zip" || said === "application/x-zip-compressed") return "zip";
  if (said === "application/gzip" || said === "application/x-gzip" || said === "application/x-tar+gzip") return "tar.gz";
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  })();
  if (path.endsWith(".zip")) return "zip";
  if (path.endsWith(".tar.gz") || path.endsWith(".tgz")) return "tar.gz";
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "tar.gz";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "zip";
  return undefined;
}

/**
 * Unpack an archive into memory, or refuse all of it.
 *
 * The same path twice is a refusal as well: which of the two would be the file is
 * something the archive's author knows and its reader does not.
 */
export function unpackArchive(bytes: Uint8Array, format: "tar.gz" | "zip", limits: ArchiveLimits = {}): ArchiveFile[] {
  const budget = new Budget(limits.bytes ?? DEFAULT_BYTES, limits.files ?? DEFAULT_FILES);
  const files = format === "zip" ? unzip(bytes, budget) : untar(bytes, budget);
  const seen = new Set<string>();
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new Error(`the archive holds ${JSON.stringify(file.path)} twice; nothing was unpacked`);
    seen.add(key);
  }
  return files;
}
