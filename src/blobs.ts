/**
 * Bytes kept under the hash of what they are.
 *
 * A row is text, a little JSON and a time, and an attachment is a media type and its
 * bytes inline. Neither is the place for a film, a scan or a model's weights: a row
 * that carries one is a row every read pays for, and a transcript that carries one is
 * re-sent whole on every turn. So large things are kept here once, and what travels is
 * their address — `sha256:` and sixty-four hex digits — from a row's `meta`, or from an
 * `Attachment` in place of its bytes.
 *
 * The address is the content. The same bytes kept twice are one blob; a blob cannot be
 * changed without becoming a different one; and what comes back can be checked against
 * what was asked for, which the store on disk does on every read.
 *
 * Nothing here collects garbage by itself. Whether a blob is still wanted is a fact
 * about every row and transcript that might name it, and a framework that guessed
 * would be deleting data on a guess. `sweepBlobs` is told what is still referenced and
 * removes the rest, when an app decides to run it.
 *
 * The interface is five operations so that somewhere other than a disk — object
 * storage, most likely — can stand behind it. A plugin supplies one as `blobs`.
 */

import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Attachment } from "./harness/types.js";
import { FILE_MODE, privateDir } from "./private.js";

/** What is known about a blob without reading it. */
export interface BlobInfo {
  /** `sha256:` followed by the hex digest of the bytes. */
  address: string;
  size: number;
  /** When it was kept, epoch milliseconds. */
  at: number;
}

/** Somewhere bytes are kept under their own hash. */
export interface BlobStore {
  /** Keep these bytes. Answers with their address; keeping the same bytes again changes nothing. */
  put(bytes: Uint8Array): Promise<string>;
  /** The bytes at an address, or nothing if they are not here. */
  get(address: string): Promise<Uint8Array | undefined>;
  /** Whether the bytes at an address are here, and what is known of them. */
  stat(address: string): Promise<BlobInfo | undefined>;
  /** Remove the bytes at an address. True when something was there. */
  delete(address: string): Promise<boolean>;
  /** Everything kept, in no particular order. */
  list(): AsyncIterable<BlobInfo>;
}

const ADDRESS = /^sha256:([0-9a-f]{64})$/;
const ANYWHERE = /sha256:[0-9a-f]{64}/g;

/** The address of some bytes: what they would be kept under. */
export const addressOf = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Whether a string is a blob's address. */
export const isBlobAddress = (value: unknown): value is string => typeof value === "string" && ADDRESS.test(value);

function digestOf(address: string): string {
  const digest = ADDRESS.exec(address)?.[1];
  if (!digest) throw new Error(`"${address}" is not a blob address: one is "sha256:" and 64 hex digits`);
  return digest;
}

/**
 * Blobs as files in a folder.
 *
 * Two hex digits of folder and the rest as the file name, so no one directory holds
 * every blob. A blob is written beside where it will live and renamed into place, so a
 * reader never sees half of one; and it is hashed again on the way out, because a file
 * on a disk can be changed by things that are not this, and bytes that are no longer
 * what their address says are worse than no bytes.
 */
export function diskBlobs(dir: string): BlobStore {
  const fileOf = (address: string): { folder: string; file: string } => {
    const digest = digestOf(address);
    const folder = join(dir, digest.slice(0, 2));
    return { folder, file: join(folder, digest.slice(2)) };
  };

  const stat_ = async (address: string): Promise<BlobInfo | undefined> => {
    const { file } = fileOf(address);
    try {
      const found = await stat(file);
      return { address, size: found.size, at: Math.floor(found.mtimeMs) };
    } catch {
      return undefined;
    }
  };

  return {
    async put(bytes) {
      const address = addressOf(bytes);
      if (await stat_(address)) return address;
      const { folder, file } = fileOf(address);
      await privateDir(dir);
      await privateDir(folder);
      const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temp, bytes, { mode: FILE_MODE });
      await rename(temp, file);
      return address;
    },

    async get(address) {
      const { file } = fileOf(address);
      let bytes: Buffer;
      try {
        bytes = await readFile(file);
      } catch {
        return undefined;
      }
      if (addressOf(bytes) !== address) {
        throw new Error(`the blob at ${address} is no longer what its address says: the file was changed or damaged`);
      }
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },

    stat: stat_,

    async delete(address) {
      if (!(await stat_(address))) return false;
      await rm(fileOf(address).file, { force: true });
      return true;
    },

    async *list() {
      const folders = await readdir(dir).catch(() => [] as string[]);
      for (const folder of folders) {
        if (!/^[0-9a-f]{2}$/.test(folder)) continue;
        for (const name of await readdir(join(dir, folder)).catch(() => [] as string[])) {
          if (!/^[0-9a-f]{62}$/.test(name)) continue; // a write in progress, or not ours
          const info = await stat_(`sha256:${folder}${name}`);
          if (info) yield info;
        }
      }
    },
  };
}

/** Blobs kept in the process and gone with it, for a test or a scratch app. */
export function memoryBlobs(): BlobStore {
  const held = new Map<string, { bytes: Uint8Array; at: number }>();
  return {
    async put(bytes) {
      const address = addressOf(bytes);
      if (!held.has(address)) held.set(address, { bytes: Uint8Array.from(bytes), at: Date.now() });
      return address;
    },
    async get(address) {
      digestOf(address);
      const found = held.get(address);
      return found ? Uint8Array.from(found.bytes) : undefined;
    },
    async stat(address) {
      digestOf(address);
      const found = held.get(address);
      return found ? { address, size: found.bytes.byteLength, at: found.at } : undefined;
    },
    async delete(address) {
      return held.delete(address);
    },
    async *list() {
      for (const [address, { bytes, at }] of held) yield { address, size: bytes.byteLength, at };
    },
  };
}

// ── Attachments ─────────────────────────────────────────────────────────────

/**
 * Keep an attachment's bytes as a blob and carry the address instead.
 *
 * What comes back has `blob` where it had `data`, so it can be written into a row, a
 * transcript or a queue at the cost of its address. `over` leaves anything smaller
 * than that many bytes inline, where a round trip to fetch it would cost more than
 * carrying it. An attachment that is an address already, or a URL, is left as it is.
 */
export async function detach(blobs: BlobStore, attachment: Attachment, options: { over?: number } = {}): Promise<Attachment> {
  if (attachment.data === undefined) return attachment;
  const bytes = Buffer.from(attachment.data, "base64");
  if (bytes.byteLength < (options.over ?? 0)) return attachment;
  const { data: _data, ...rest } = attachment;
  return { ...rest, blob: await blobs.put(bytes) };
}

/**
 * Put an attachment's bytes back, for whatever is about to read them.
 *
 * Throws when the blob is not there: an attachment sent without its bytes is not the
 * attachment, and the caller is in a position to say which one went missing.
 */
export async function inline(blobs: BlobStore, attachment: Attachment): Promise<Attachment> {
  if (attachment.blob === undefined || attachment.data !== undefined || attachment.url !== undefined) return attachment;
  const bytes = await blobs.get(attachment.blob);
  if (!bytes) throw new Error(`its bytes are not in the blob store (${attachment.blob})`);
  return { ...attachment, data: Buffer.from(bytes).toString("base64") };
}

// ── Sweeping ────────────────────────────────────────────────────────────────

/**
 * Every blob address anywhere in a value: a row's `meta`, an attachment, a transcript.
 *
 * Strings are searched rather than only matched whole, so an address inside a longer
 * string — a URL, a sentence — still counts as a reference. Erring that way keeps a
 * blob that was not needed; erring the other way deletes one that was.
 */
export function blobsIn(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    for (const address of value.match(ANYWHERE) ?? []) found.add(address);
  } else if (Array.isArray(value)) {
    for (const one of value) blobsIn(one, found);
  } else if (typeof value === "object" && value !== null) {
    for (const one of Object.values(value)) blobsIn(one, found);
  }
  return found;
}

export interface SweepOptions {
  /**
   * Leave anything kept more recently than this many milliseconds ago, referenced or
   * not. A blob is written before the row that names it, so a sweep that ran between
   * the two would take it. Default one day.
   */
  olderThan?: number;
  /** Report what would go without removing it. */
  dryRun?: boolean;
  /** The time it is, for a test. */
  now?: number;
}

export interface Swept {
  /** The addresses removed, or that would have been. */
  removed: string[];
  /** How many blobs were left. */
  kept: number;
  /** Bytes given back. */
  freed: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Remove every blob that nothing still names.
 *
 * `live` is every address still referenced, and gathering it is the caller's part —
 * `blobsIn` over the rows and transcripts that could hold one — because only the app
 * knows everywhere it keeps an address. This never runs by itself.
 */
export async function sweepBlobs(blobs: BlobStore, live: Iterable<string>, options: SweepOptions = {}): Promise<Swept> {
  const wanted = live instanceof Set ? (live as Set<string>) : new Set(live);
  const before = (options.now ?? Date.now()) - (options.olderThan ?? DAY_MS);
  const out: Swept = { removed: [], kept: 0, freed: 0 };

  for await (const info of blobs.list()) {
    if (wanted.has(info.address) || info.at > before) {
      out.kept++;
      continue;
    }
    if (!options.dryRun && !(await blobs.delete(info.address))) {
      out.kept++;
      continue;
    }
    out.removed.push(info.address);
    out.freed += info.size;
  }
  return out;
}
