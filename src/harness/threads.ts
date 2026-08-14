/**
 * A conversation between turns.
 *
 * A run is either going or over. A conversation is neither: it sits idle, for a
 * minute or for a fortnight, and then someone says one more thing. Until now
 * that meant whoever asked had to keep the turns and hand them back, so a
 * conversation only lasted as long as the process that was holding it.
 *
 * So it is kept here instead, one file per conversation, and naming it is all
 * anyone has to do. Nothing is ever summarised away: the file holds every turn
 * that was taken, and what is carried back into a request is a window onto it.
 * Those are two different questions and conflating them is how a conversation
 * quietly loses the thing it was about.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DIR_MODE, FILE_MODE } from "../private.js";
import { budgetFor, tokens } from "./budget.js";
import type { Message } from "./types.js";

/** A message costs what it says, plus what it costs to say who said it. */
const OVERHEAD = 8;

export interface Turn extends Message {
  /** Epoch milliseconds. */
  at: number;
}

export interface Thread {
  id: string;
  /** The agent this conversation is with. */
  agent: string;
  turns: Turn[];
  startedAt: number;
  updatedAt: number;
}

/** What a conversation looks like from a list of them. */
export interface ThreadSummary {
  id: string;
  agent: string;
  turns: number;
  startedAt: number;
  updatedAt: number;
  /** The first thing that was asked, which is usually what it is about. */
  opened: string;
}

const size = (turn: Message): number => tokens(turn.content) + OVERHEAD;

/**
 * The most recent stretch of a conversation that fits.
 *
 * A ceiling rather than a target. When it stops fitting, more is dropped than
 * strictly has to be, and how much more is rounded to a whole step. Dropping
 * the minimum would mean dropping again on the very next turn, and again after
 * that; the front of the request would move every time anyone said anything and
 * no endpoint could ever serve any of it from a prefix it had already read.
 *
 * Rounding up to a step is what makes the front hold still, and it has to be
 * rounding rather than a target because nothing is remembered between calls:
 * dropping to a target would land somewhere new every time the tail grew. A
 * step of a third of the room buys a third of the room's worth of talking
 * before the front moves again.
 */
export function carry(turns: Turn[], budget = budgetFor().conversation): Message[] {
  const total = turns.reduce((sum, turn) => sum + size(turn), 0);
  let from = 0;

  if (total > budget) {
    const step = Math.max(1, Math.floor(budget / 3));
    const drop = Math.ceil((total - budget) / step) * step;
    let dropped = 0;
    while (from < turns.length && dropped < drop) {
      dropped += size(turns[from]!);
      from++;
    }
  }

  // A reply with nothing in front of it reads as though the agent spoke first.
  while (from < turns.length && turns[from]!.role !== "user") from++;

  return turns.slice(from).map(({ at: _at, ...message }) => message);
}

/**
 * Where conversations are kept.
 *
 * Storage only. Which turns come back into a request is decided above this line
 * and written once, the same way a store's meaning is written once above its
 * driver — otherwise every backend would get its own opinion about what a
 * conversation is, and they would not agree.
 *
 * `append` is a primitive rather than something built from a read and a write.
 * That is the whole reason this interface has the shape it does: a backend two
 * processes share would lose a turn every time both of them loaded the same
 * conversation, added to it, and put it back. A backend that can append must be
 * asked to append.
 */
export interface Conversations {
  load(id: string): Promise<Thread | undefined>;
  /** Add what was just said. The conversation starts if it had not already. */
  append(id: string, agent: string, said: Message[]): Promise<void>;
  /** Every conversation, most recently spoken in first. */
  list(agent?: string): Promise<ThreadSummary[]>;
  forget(id: string): Promise<boolean>;
}

/** Conversations kept as one file each, which is all a single process needs. */
export class Folder implements Conversations {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return join(this.dir, `${id.replace(/[^\w.-]/g, "_")}.json`);
  }

  async load(id: string): Promise<Thread | undefined> {
    try {
      const thread = JSON.parse(await readFile(this.file(id), "utf8")) as Thread;
      // Read from disk, so it may have been truncated or hand-edited.
      if (!Array.isArray(thread.turns)) return undefined;
      return thread;
    } catch {
      return undefined;
    }
  }

  /**
   * Add what was just said.
   *
   * Read, add, write — which is safe here because a folder is one process. A
   * backend more than one process reaches has to do this in one step instead.
   */
  async append(id: string, agent: string, said: Message[]): Promise<void> {
    const now = Date.now();
    const thread = (await this.load(id)) ?? {
      id,
      agent,
      turns: [],
      startedAt: now,
      updatedAt: now,
    };

    thread.agent = agent;
    thread.updatedAt = now;
    for (const message of said) thread.turns.push({ ...message, at: now });

    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    const target = this.file(id);
    const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(temp, JSON.stringify(thread, null, 2), { encoding: "utf8", mode: FILE_MODE });
    await rename(temp, target);
  }

  async list(agent?: string): Promise<ThreadSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }

    const found: ThreadSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const thread = await this.load(name.slice(0, -".json".length));
      if (!thread) continue;
      if (agent && thread.agent !== agent) continue;
      found.push({
        id: thread.id,
        agent: thread.agent,
        turns: thread.turns.length,
        startedAt: thread.startedAt,
        updatedAt: thread.updatedAt,
        opened: thread.turns.find((turn) => turn.role === "user")?.content.slice(0, 200) ?? "",
      });
    }
    return found.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Throw a conversation away.
   *
   * This is the one thing here that does take something back, which is why it
   * only ever happens because somebody asked for it by name.
   */
  async forget(id: string): Promise<boolean> {
    const thread = await this.load(id);
    if (!thread) return false;
    await rm(this.file(id), { force: true });
    return true;
  }
}

/**
 * Conversations, however they are kept, plus the one thing that is not storage.
 *
 * The window is decided here so that it is decided the same way whatever is
 * underneath. Everything else is the backend's, passed straight through.
 */
export class Threads implements Conversations {
  private readonly kept: Conversations;

  constructor(kept: Conversations | string) {
    this.kept = typeof kept === "string" ? new Folder(kept) : kept;
  }

  /** What to put in front of the next thing said, if anything. */
  async carry(id: string, budget?: number): Promise<Message[]> {
    const thread = await this.load(id);
    return thread ? carry(thread.turns, budget) : [];
  }

  load(id: string): Promise<Thread | undefined> {
    return this.kept.load(id);
  }

  append(id: string, agent: string, said: Message[]): Promise<void> {
    return this.kept.append(id, agent, said);
  }

  list(agent?: string): Promise<ThreadSummary[]> {
    return this.kept.list(agent);
  }

  forget(id: string): Promise<boolean> {
    return this.kept.forget(id);
  }
}
