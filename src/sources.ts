/**
 * Durable triggers: an outside stream of events, each starting a workflow run.
 *
 * A source yields events with a cursor; the cursor of the last event handled is
 * stored, so after a restart the source is asked to continue after it. Delivery
 * is at least once — an event can arrive again when the process died between
 * starting its run and storing the cursor — and each event's run is named from
 * the source and the cursor, so a second delivery finds the run the first one
 * started instead of starting another.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SourceEvent {
  /** Where this event sits in the stream. Opaque; handed back to `subscribe` to continue after it. */
  cursor: string;
  event: unknown;
}

export interface Source {
  /** Names the stored cursor; one cursor per name. */
  name: string;
  /** Events after `cursor` (from the start when absent), until `signal` aborts. */
  subscribe(cursor: string | undefined, signal: AbortSignal): AsyncIterable<SourceEvent>;
}

/** The run id an event's run gets: stable per (source, cursor). */
export function runIdFor(workflow: string, source: string, cursor: string): string {
  const tag = createHash("sha256").update(`${source}\n${cursor}`).digest("hex").slice(0, 24);
  return `${workflow}-src-${tag}`;
}

/** Where a source's cursor is kept between runs of the process. */
export class CursorFile {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  private file(name: string): string {
    return join(this.dir, `${name.replace(/[^\w-]/g, "_")}.json`);
  }

  async read(name: string): Promise<string | undefined> {
    try {
      const saved = JSON.parse(await readFile(this.file(name), "utf8")) as { cursor?: unknown };
      return typeof saved.cursor === "string" ? saved.cursor : undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`the stored cursor for source "${name}" cannot be read: ${(err as Error).message}`, { cause: err });
    }
  }

  async write(name: string, cursor: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = this.file(name);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ cursor, at: Date.now() }), { mode: 0o600 });
    await rename(temp, target);
  }
}
