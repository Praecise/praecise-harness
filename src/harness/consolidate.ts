/**
 * Turning a pile of exchanges into a few things worth keeping.
 *
 * Episodes are a good record and a poor memory. Five hundred of them hold
 * everything an agent has done and tell it nothing, because recall can only
 * ever hand back the handful that happen to share words with the question. What
 * is missing is the shorter thing underneath: the fact that this customer is on
 * the annual plan, that the export always fails on files over a gigabyte. Those
 * are worth carrying into every conversation, and no amount of lexical overlap
 * will produce them.
 *
 * So they are written out — but never in the same motion as being adopted.
 *
 * Consolidation produces a candidate and stops. The episodes it read are not
 * touched, not compacted, not summarised away; they are still there afterwards,
 * byte for byte. Nothing an agent carries into future conversations changes
 * until somebody says so. That is the whole discipline of this file, and it is
 * there because a memory that rewrites itself is a memory with no floor: each
 * pass summarises the last one's summary, the errors compound in the direction
 * of whatever the model finds easiest to say, and by the time it reads wrong
 * there is nothing left to check it against.
 *
 * Every note cites the episodes it came from, which is what makes reviewing it
 * possible rather than a matter of taste. A note whose sources do not say what
 * it says is a note to throw out.
 *
 * This runs between conversations, not during one. A request that pauses to
 * reconsider everything the agent knows is a request the user waits for.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentPlan } from "../compile/plan.js";
import { DIR_MODE, FILE_MODE } from "../private.js";
import type { Episode } from "./memory.js";
import type { Harness } from "./types.js";

/** One durable thing, and the exchanges it was drawn from. */
export interface Note {
  text: string;
  /** Episode ids. A note that cites nothing cannot be checked, so is dropped. */
  from: string[];
}

/** A proposal. Nothing here is in use until it is accepted. */
export interface Candidate {
  agent: string;
  at: number;
  /** What was read to produce it. */
  read: { episodes: number; since: number; until: number };
  notes: Note[];
  /** What went wrong, or was left out. */
  problems?: string[];
}

/** What the agent carries, once somebody has agreed to it. */
export interface Notes {
  agent: string;
  /** When these were accepted. */
  at: number;
  notes: Note[];
}

const MOST_NOTES = 24;
const MOST_EPISODES = 200;
const NOTE_LENGTH = 400;

const INSTRUCTIONS = [
  "You read a record of past exchanges and write down the few things worth",
  "carrying into every future one.",
  "",
  "Write only what the exchanges show. A standing fact, a preference stated",
  "outright, a constraint that held every time, something that failed the same",
  "way more than once. Not a summary of what was discussed — anyone can reread",
  "the record for that. If the exchanges support nothing durable, write nothing;",
  "an empty list is a correct answer and a common one.",
  "",
  "Each note must cite the ids of the exchanges it came from, and must be true",
  "of those exchanges on their own. Do not generalise past them, do not soften",
  "a one-off into a pattern, and do not carry forward anything about a single",
  "conversation that will not still be true next month.",
].join("\n");

interface Proposed {
  notes?: unknown;
}

/**
 * Strip a plan down to something that only reads the record.
 *
 * No tools and no memory, so what it proposes comes from the episodes in front
 * of it and nowhere else — including from whatever it proposed last time, which
 * is the loop that makes a self-summarising memory drift.
 */
export function consolidatorPlan(plan: AgentPlan): AgentPlan {
  return {
    ...plan,
    name: `${plan.name}:consolidate`,
    description: "Proposes what an agent should carry forward.",
    instructions: INSTRUCTIONS,
    services: [],
    locals: [],
    memory: false,
    memoryStore: undefined,
    memoryRecall: undefined,
    greeting: undefined,
    quality: "best",
    returns: {
      notes: 'a list of { "text": the durable thing, "from": the exchange ids it came from }',
    },
  };
}

function render(episodes: Episode[]): string {
  return episodes
    .map((e) => `[${e.id}] asked: ${e.input.slice(0, 600)}\n     answered: ${e.answer.slice(0, 600)}`)
    .join("\n\n");
}

/** Keep only notes that say something and cite exchanges that were actually read. */
function usable(proposed: unknown, known: Set<string>): Note[] {
  if (!Array.isArray(proposed)) return [];
  const notes: Note[] = [];

  for (const entry of proposed) {
    if (!entry || typeof entry !== "object") continue;
    const { text, from } = entry as { text?: unknown; from?: unknown };
    if (typeof text !== "string" || !text.trim()) continue;

    const cited = (Array.isArray(from) ? from : [])
      .filter((id): id is string => typeof id === "string" && known.has(id));
    // A note citing nothing that was read is one nobody can check, and the
    // likeliest reason for it is that the model made it up.
    if (!cited.length) continue;

    notes.push({ text: text.trim().slice(0, NOTE_LENGTH), from: cited });
    if (notes.length >= MOST_NOTES) break;
  }

  return notes;
}

/**
 * Read the record and propose what to carry forward. Returns the proposal; it
 * is the caller's business whether it is ever written anywhere.
 */
export async function consolidate(
  harness: Harness,
  plan: AgentPlan,
  episodes: Episode[],
): Promise<Candidate> {
  const read = episodes.slice(-MOST_EPISODES);
  const base: Candidate = {
    agent: plan.name,
    at: Date.now(),
    read: {
      episodes: read.length,
      since: read[0]?.at ?? 0,
      until: read[read.length - 1]?.at ?? 0,
    },
    notes: [],
  };

  if (!read.length) return { ...base, problems: ["there was nothing to read"] };

  let answer;
  try {
    answer = await harness.ask(consolidatorPlan(plan), render(read));
  } catch (err) {
    return { ...base, problems: [`could not read the record: ${(err as Error).message}`] };
  }

  const proposed = (answer.data ?? {}) as Proposed;
  const notes = usable(proposed.notes, new Set(read.map((e) => e.id)));
  const problems =
    Array.isArray(proposed.notes) && proposed.notes.length > notes.length
      ? [`${proposed.notes.length - notes.length} proposed notes cited nothing that was read`]
      : undefined;

  return { ...base, notes, problems };
}

/**
 * Where proposals and accepted notes are kept, one file each per agent.
 *
 * A candidate lives beside the episodes rather than inside them, so accepting
 * one is a separate act with its own file and rejecting one is a delete.
 */
export class NoteBook {
  constructor(private readonly dir: string) {}

  private file(agent: string, kind: "candidate" | "notes"): string {
    return join(this.dir, `${agent.replace(/[^\w.-]/g, "_")}.${kind}.json`);
  }

  private async read<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  private async write(path: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: FILE_MODE });
    await rename(temp, path);
  }

  /** Put a proposal up for review, replacing any earlier unaccepted one. */
  async propose(candidate: Candidate): Promise<void> {
    await this.write(this.file(candidate.agent, "candidate"), candidate);
  }

  /** The proposal waiting on this agent, if there is one. */
  pending(agent: string): Promise<Candidate | undefined> {
    return this.read<Candidate>(this.file(agent, "candidate"));
  }

  /** What this agent carries. Empty until something has been accepted. */
  async notes(agent: string): Promise<Note[]> {
    const held = await this.read<Notes>(this.file(agent, "notes"));
    return Array.isArray(held?.notes) ? held.notes : [];
  }

  /**
   * Adopt a proposal, in whole or in part.
   *
   * `keep` selects by position in the candidate; omitting it takes all of them.
   * Accepted notes replace the previous set rather than accumulating, because
   * this pass read the same record the last one did and a note it left out was
   * left out on purpose.
   */
  async accept(agent: string, keep?: number[]): Promise<Note[]> {
    const candidate = await this.pending(agent);
    if (!candidate) throw new Error(`there is no proposal waiting on ${agent}`);

    const notes = keep
      ? keep.map((at) => candidate.notes[at]).filter((note): note is Note => Boolean(note))
      : candidate.notes;

    await this.write(this.file(agent, "notes"), { agent, at: Date.now(), notes } satisfies Notes);
    await this.reject(agent);
    return notes;
  }

  /** Throw a proposal away. The record it was drawn from is untouched. */
  async reject(agent: string): Promise<void> {
    await unlink(this.file(agent, "candidate")).catch(() => {});
  }
}

/** Render accepted notes as an instruction block. */
export function renderNotes(notes: Note[]): string {
  if (!notes.length) return "";
  const lines = notes.map((note) => `- ${note.text}`).join("\n");
  return `What you have learned across past conversations:\n${lines}`;
}
