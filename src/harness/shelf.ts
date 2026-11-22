/**
 * Where the small, curated parts of an agent's memory are kept: what it carries, the
 * proposal waiting on it, its subject pages.
 *
 * These are documents, not a log. Each has a name and a revision, and a writer says
 * which revision it read. If the document has moved on since, the write is refused and
 * nothing is lost; the writer reads again and decides again. That holds whether the
 * two writers are in one process or on two machines.
 *
 * There are two places they can be, and they follow the record: files under the state
 * directory for an agent that remembers into files, and the agent's store for one that
 * names a store. So an app that runs on several machines against one database has one
 * memory, all of it, and not a part of it on each machine's disk.
 */

import { open as openFile, readdir, rm, stat, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { privateDir, readState, updateState, FILE_MODE, type StateCipher } from "../private.js";
import type { Store } from "../stores/types.js";
import { memoryDir, rank } from "./memory.js";

/** A document changed between being read and being written. */
export class Conflict extends Error {
  constructor(key: string, read: number, found: number) {
    super(`"${key}" was at revision ${found}, not ${read}: it changed after it was read, and was left as it is`);
    this.name = "Conflict";
  }
}

export interface Versioned<T> {
  value: T;
  /** How many times it has been written. */
  revision: number;
}

/** Gives a lease back before its time is up. */
export type Release = () => Promise<void>;

export interface Shelf {
  read<T>(agent: string, key: string): Promise<Versioned<T> | undefined>;
  /**
   * Write a document, having read revision `read` of it (0 for one that is new).
   * Answers with its new revision; refused with `Conflict` when it is not at `read`.
   * `text` is what a search of the shelf finds it by.
   */
  write<T>(agent: string, key: string, value: T, read: number, text?: string): Promise<number>;
  /** The names of the documents in a folder, in no particular order. */
  keys(agent: string, folder: string): Promise<string[]>;
  /** The documents in a folder that answer a search, best first, by name. */
  search(agent: string, folder: string, query: string, limit: number): Promise<string[]>;
  remove(agent: string, key: string): Promise<void>;
  /** Everything on the shelf for this agent, gone. */
  drop(agent: string): Promise<void>;
  /**
   * Hold a name for up to `ttl` seconds, or learn that somebody else holds it. For work
   * that must not be done twice at once: nothing is returned to the caller that lost.
   */
  lease(agent: string, name: string, ttl: number): Promise<Release | undefined>;
}

/** A key is a name, or a folder and a name: `carried`, `pages/acme-ltd`. */
function parts(key: string): { folder: string; name: string } {
  const at = key.lastIndexOf("/");
  return at < 0 ? { folder: "", name: key } : { folder: key.slice(0, at), name: key.slice(at + 1) };
}

const fileName = (name: string): string => `${encodeURIComponent(name)}.json`;

interface Filed<T> {
  revision: number;
  value: T;
  text?: string;
}

/** The shelf as files: one document, one file. */
export class FileShelf implements Shelf {
  private readonly dir: string;
  private readonly cipher?: StateCipher;

  constructor(
    dir: string,
    /** Seals each document, as the record beside it is sealed. */
    cipher?: StateCipher,
  ) {
    this.dir = dir;
    this.cipher = cipher;
  }

  private root(agent: string): string {
    return join(memoryDir(this.dir, agent), "shelf");
  }

  private file(agent: string, key: string): string {
    const { folder, name } = parts(key);
    if (!name) throw new Error(`"${key}" is not a name a document can be kept under`);
    return join(this.root(agent), ...(folder ? folder.split("/").map(encodeURIComponent) : []), fileName(name));
  }

  async read<T>(agent: string, key: string): Promise<Versioned<T> | undefined> {
    const held = await readState<Filed<T>>(this.file(agent, key), this.cipher);
    return held ? { value: held.value, revision: held.revision } : undefined;
  }

  async write<T>(agent: string, key: string, value: T, read: number, text?: string): Promise<number> {
    let revision = 0;
    await updateState<Filed<T> | null>(this.file(agent, key), this.cipher, () => null, (held) => {
      const found = held?.revision ?? 0;
      if (found !== read) throw new Conflict(key, read, found);
      revision = found + 1;
      return { revision, value, ...(text !== undefined ? { text } : {}) };
    });
    return revision;
  }

  private async names(agent: string, folder: string): Promise<string[]> {
    const dir = join(this.root(agent), ...(folder ? folder.split("/").map(encodeURIComponent) : []));
    const found = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [] as string[];
      throw err;
    });
    return found.filter((name) => name.endsWith(".json")).map((name) => decodeURIComponent(name.slice(0, -".json".length)));
  }

  async keys(agent: string, folder: string): Promise<string[]> {
    return (await this.names(agent, folder)).map((name) => (folder ? `${folder}/${name}` : name));
  }

  async search(agent: string, folder: string, query: string, limit: number): Promise<string[]> {
    const held: { key: string; text: string }[] = [];
    for (const key of await this.keys(agent, folder)) {
      const doc = await readState<Filed<unknown>>(this.file(agent, key), this.cipher);
      if (doc?.text) held.push({ key, text: doc.text });
    }
    // Age is left out of it: a document is rewritten in place, so it has no age to decay by.
    const now = Date.now();
    return rank(query, held, (doc) => doc.text, () => now, 0)
      .slice(0, limit)
      .map(({ entry }) => entry.key);
  }

  async remove(agent: string, key: string): Promise<void> {
    await rm(this.file(agent, key), { force: true });
  }

  async drop(agent: string): Promise<void> {
    await rm(this.root(agent), { recursive: true, force: true });
  }

  async lease(agent: string, name: string, ttl: number): Promise<Release | undefined> {
    const path = join(this.root(agent), `${encodeURIComponent(name)}.lease`);
    await privateDir(dirname(path));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await openFile(path, "wx", FILE_MODE);
        await handle.close();
        return async () => {
          await unlink(path).catch(() => {});
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const held = await stat(path).catch(() => undefined);
        // Whoever held it past its time is gone; take the file away and try once more.
        if (!held || Date.now() - held.mtimeMs <= ttl * 1000) return undefined;
        await unlink(path).catch(() => {});
      }
    }
    return undefined;
  }
}

/** How long a writer has between winning a revision and writing it, in seconds. */
const WRITE_WINDOW = 60;

/** The most documents one folder is asked for at once. */
const MOST_KEYS = 1_000;

interface Row {
  key?: unknown;
  revision?: unknown;
  value?: unknown;
}

/**
 * The shelf in a store.
 *
 * A document is one row, found by an id made from its name, with what a search finds it
 * by as the row's text, so the store's own index does the searching. A revision is won
 * before it is written: the writer claims the next revision's name, which the backend
 * gives to exactly one caller, and only then replaces the row.
 */
export class StoreShelf implements Shelf {
  private readonly open: () => Promise<Store>;

  constructor(open: () => Promise<Store>) {
    this.open = open;
  }

  private scope(agent: string, folder: string): string {
    return folder ? `${agent}/shelf/${folder}` : `${agent}/shelf`;
  }

  private id(agent: string, key: string): string {
    return `doc_${createHash("sha256").update(`${agent}\n${key}`).digest("hex").slice(0, 32)}`;
  }

  private async row<T>(store: Store, agent: string, key: string): Promise<Versioned<T> | undefined> {
    const [item] = await store.history({ scope: this.scope(agent, parts(key).folder), id: this.id(agent, key), limit: 1 });
    const meta = (item?.meta ?? {}) as Row;
    if (!item || typeof meta.revision !== "number") return undefined;
    return { value: meta.value as T, revision: meta.revision };
  }

  async read<T>(agent: string, key: string): Promise<Versioned<T> | undefined> {
    return this.row<T>(await this.open(), agent, key);
  }

  async write<T>(agent: string, key: string, value: T, read: number, text?: string): Promise<number> {
    const store = (await this.open()).as(agent);
    const next = read + 1;
    const space = [agent, "shelf", "revisions"];
    const claim = `${key}@${next}`;
    if (!(await store.values.claim(space, claim, true, { ttl: WRITE_WINDOW }))) {
      throw new Conflict(key, read, Math.max((await this.row<T>(store, agent, key))?.revision ?? 0, next));
    }
    try {
      // Checked again with the revision in hand: a claim lapses, and one that lapsed
      // after its holder had written must not let a second writer in behind it.
      const found = (await this.row<T>(store, agent, key))?.revision ?? 0;
      if (found !== read) throw new Conflict(key, read, found);
      await store.remember({
        id: this.id(agent, key),
        scope: this.scope(agent, parts(key).folder),
        text: text ?? key,
        meta: { key, revision: next, value },
      });
    } finally {
      // The row says which revision it is from here on, so the claim has done its work.
      await store.values.delete(space, claim);
    }
    return next;
  }

  async keys(agent: string, folder: string): Promise<string[]> {
    const store = await this.open();
    const rows = await store.history({ scope: this.scope(agent, folder), limit: MOST_KEYS });
    return rows.flatMap((item) => (typeof (item.meta as Row | undefined)?.key === "string" ? [(item.meta as Row).key as string] : []));
  }

  async search(agent: string, folder: string, query: string, limit: number): Promise<string[]> {
    const store = await this.open();
    const found = await store.recall(query, { scope: this.scope(agent, folder), limit });
    return found.flatMap((item) => (typeof (item.meta as Row | undefined)?.key === "string" ? [(item.meta as Row).key as string] : []));
  }

  async remove(agent: string, key: string): Promise<void> {
    const store = await this.open();
    await store.forget({ scope: this.scope(agent, parts(key).folder), id: this.id(agent, key) });
  }

  async drop(agent: string): Promise<void> {
    const store = await this.open();
    for (const folder of ["", ...FOLDERS]) {
      while ((await store.forget({ scope: this.scope(agent, folder), limit: MOST_KEYS })) > 0);
    }
  }

  async lease(agent: string, name: string, ttl: number): Promise<Release | undefined> {
    const store = (await this.open()).as(agent);
    const space = [agent, "shelf", "leases"];
    const token = randomBytes(8).toString("hex");
    if (!(await store.values.claim(space, name, token, { ttl }))) return undefined;
    return async () => {
      // Only where it is still this holder's: one that lapsed may be somebody else's now.
      if ((await store.values.get<string>(space, name)) === token) await store.values.delete(space, name);
    };
  }
}

/** The folders documents are kept in, besides the shelf itself. */
export const FOLDERS = ["pages"] as const;
