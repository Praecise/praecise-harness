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

import type { Message } from "./types.js";

/**
 * How much of a conversation is carried back into a request.
 *
 * A ceiling rather than a target. What actually goes depends on where the last
 * drop landed, because a window that slid by one turn each time would change
 * the prefix on every request and throw away the endpoint's cache along with it.
 */
const CARRY = 48_000;

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

const size = (turn: Message): number => turn.content.length + 32;

/**
 * The most recent stretch of a conversation that fits.
 *
 * When it stops fitting, more is dropped than strictly has to be. Dropping the
 * minimum would mean dropping again on the very next turn, and again after
 * that; the front of the request would move every time and no endpoint could
 * ever serve any of it from a prefix it had already read. Dropping a third of
 * the room instead buys many turns of the front staying exactly where it is.
 */
export function carry(turns: Turn[], budget = CARRY): Message[] {
  let total = turns.reduce((sum, turn) => sum + size(turn), 0);
  let from = 0;

  if (total > budget) {
    const target = budget - Math.floor(budget / 3);
    while (from < turns.length && total > target) {
      total -= size(turns[from]!);
      from++;
    }
  }

  // A reply with nothing in front of it reads as though the agent spoke first.
  while (from < turns.length && turns[from]!.role !== "user") from++;

  return turns.slice(from).map(({ at: _at, ...message }) => message);
}

export class Threads {
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

  /** What to put in front of the next thing said, if anything. */
  async carry(id: string): Promise<Message[]> {
    const thread = await this.load(id);
    return thread ? carry(thread.turns) : [];
  }

  /** Add what was just said. The conversation starts if it had not already. */
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

    await mkdir(this.dir, { recursive: true });
    const target = this.file(id);
    const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(temp, JSON.stringify(thread, null, 2), "utf8");
    await rename(temp, target);
  }

  /** Every conversation, most recently spoken in first. */
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
