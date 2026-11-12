/**
 * What the MCP endpoint remembers about a task: which run it stands for, which tool
 * started it, and when.
 *
 * A task is the only way work outlives a connection in this revision of MCP, so the
 * record is on disk before the caller is told the task exists. It is small on purpose.
 * The run is the truth about the work and is already persisted by the workflow store;
 * this is the mapping from an id a stranger cannot guess to that run, and nothing else.
 *
 * The id is separate from the run's id because a run id is a workflow name, a timestamp
 * and a few characters — fine for a filename and a dashboard, and derivable by anyone who
 * knows roughly when a run started. A task id is all a caller presents to read a result.
 */

import { randomBytes } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { FILE_MODE, privateDir, replaceFile } from "../private.js";

export interface TaskRecord {
  id: string;
  /** The published tool that created it. Whoever may not call that tool may not see this. */
  tool: string;
  /** The workflow run it stands for. */
  run: string;
  createdAt: number;
  /** How long after `createdAt` it is kept. */
  ttlMs: number;
  /** Set once a caller cancelled it. */
  cancelledAt?: number;
  /** Set when the run could not be started at all, so there is no run to read it from. */
  error?: string;
}

/** 192 bits, URL-safe. Anything else is not an id this store issued. */
const ID = /^[A-Za-z0-9_-]{32}$/;

/** Expired records are looked for no more often than this. */
const SWEEP_EVERY_MS = 10 * 60_000;

export class McpTaskStore {
  private readonly dir: string;
  private swept = 0;

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** Record a new task. Resolves once it is on disk. */
  async create(tool: string, run: string, ttlMs: number): Promise<TaskRecord> {
    const record: TaskRecord = {
      id: randomBytes(24).toString("base64url"),
      tool,
      run,
      createdAt: Date.now(),
      ttlMs,
    };
    await this.save(record);
    void this.sweep();
    return record;
  }

  async save(record: TaskRecord): Promise<void> {
    await privateDir(this.dir);
    const target = this.file(record.id);
    // Written beside the target and renamed over it, so a reader never sees half a record.
    const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, JSON.stringify(record), { mode: FILE_MODE });
    await replaceFile(temp, target);
  }

  /** The record for an id, unless there is none or its time is up. */
  async load(id: unknown): Promise<TaskRecord | undefined> {
    // Checked before it is used as a filename: the id came from a caller.
    if (typeof id !== "string" || !ID.test(id)) return undefined;
    let record: TaskRecord;
    try {
      record = JSON.parse(await readFile(this.file(id), "utf8")) as TaskRecord;
    } catch {
      return undefined;
    }
    if (record.id !== id || expired(record)) {
      if (record.id === id) await rm(this.file(id), { force: true }).catch(() => undefined);
      return undefined;
    }
    return record;
  }

  /** Remove records whose time is up. Never throws; a failed sweep is tried again later. */
  private async sweep(): Promise<void> {
    if (Date.now() - this.swept < SWEEP_EVERY_MS) return;
    this.swept = Date.now();
    try {
      for (const name of await readdir(this.dir)) {
        if (!name.endsWith(".json")) continue;
        const path = join(this.dir, name);
        try {
          if (expired(JSON.parse(await readFile(path, "utf8")) as TaskRecord)) await rm(path, { force: true });
        } catch {
          // Unreadable, or being written right now. Left for the next sweep.
        }
      }
    } catch {
      // No directory yet.
    }
  }
}

/** The lifetime counts from creation, not from the last time anyone looked. */
function expired(record: TaskRecord): boolean {
  return Date.now() >= record.createdAt + record.ttlMs;
}
