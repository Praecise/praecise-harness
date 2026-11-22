/**
 * What an agent carries into every conversation, and how that changes.
 *
 * The record (see memory.ts) holds everything an agent has done and tells it nothing on
 * its own: recall hands back the few entries that share words with the question. What is
 * worth carrying everywhere is the shorter thing underneath: a fact (this customer is on
 * the annual plan) or a way of doing something (to export a file over a gigabyte, split
 * it first). Those are placed in front of the model on every request, which is exactly
 * why they are the one part of memory that never changes by itself.
 *
 * So a change to them is proposed, and adopted in a separate step by a person:
 *
 *   review   reads the record, the working notes and what is carried now, and writes a
 *            proposal: things to start carrying, and carried things the record no longer
 *            supports. The record is not touched, and nothing takes effect.
 *   accept   adopts the proposal, in whole or in part.
 *
 * Every proposed entry cites the exchanges or working notes it came from, which is what
 * makes reviewing it possible. An entry whose sources do not say what it says is one to
 * throw out, and one that cites nothing that was read is dropped before anyone sees it.
 * An entry is never drawn from another carried entry: what is carried is checked against
 * the record, and only the record can be cited.
 *
 * What is carried accumulates. Something adopted last month is still carried after the
 * exchanges it came from have aged out of the record, until a later proposal closes it.
 * Closing is not deleting: the entry stays, marked with when it stopped being true, so
 * the difference between "no longer the case" and "never the case" is kept.
 *
 * When a proposed entry would replace a carried one, which of the two stands is worked
 * out here and not asked of a model: the higher authority wins, and between equals the
 * later one. So something an outside source said cannot displace something a person
 * said, however it was summarised on the way.
 *
 * This runs between conversations, not during one.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { AgentPlan } from "../compile/plan.js";
import { readState, updateState, type StateCipher } from "../private.js";
import { RANK, authorityOf, memoryDir, type Episode, type Jotting, type Origin } from "./memory.js";
import type { Harness } from "./types.js";

/** One thing an agent carries: a fact, or a way of doing something. */
export interface Note {
  id: string;
  kind: "fact" | "procedure";
  /** What a procedure is called. A fact has no name. */
  name?: string;
  text: string;
  /** The exchanges and working notes it was drawn from. */
  from: string[];
  /** How far this may be trusted: the lowest authority of what it was drawn from. */
  origin: Origin;
  /** When it was proposed. */
  at: number;
  /** When it stopped being carried, if it has. */
  until?: number;
  /** The entry that took its place, where one did. */
  replacedBy?: string;
}

/** Something a proposal would start carrying. */
export interface ProposedNote extends Omit<Note, "id" | "until" | "replacedBy"> {
  /** Carried entries this one would take the place of. */
  replaces?: string[];
}

/** A carried entry a proposal would stop carrying, and why. */
export interface Retirement {
  /** The carried entry. */
  id: string;
  why: string;
  /** The exchanges or working notes that show it. */
  from: string[];
  /** The lowest authority of those. */
  origin: Origin;
  at: number;
}

/** A proposal. Nothing here is in use until it is accepted. */
export interface Candidate {
  agent: string;
  at: number;
  /** What was read to produce it. */
  read: { episodes: number; jottings: number; carried: number; since: number; until: number };
  notes: ProposedNote[];
  retire: Retirement[];
  /** What went wrong, or was left out. */
  problems?: string[];
}

/** What came of accepting a proposal. */
export interface Accepted {
  /** Entries now carried that were not before. */
  kept: Note[];
  /** Entries that were carried and are now closed. */
  closed: Note[];
  /** What was chosen and not done, and why. */
  refused: string[];
}

const MOST_PROPOSED = 24;
const MOST_EPISODES = 200;
const MOST_JOTTINGS = 100;
const FACT_LENGTH = 400;
const PROCEDURE_LENGTH = 800;
const NAME_LENGTH = 80;
const WHY_LENGTH = 300;

/** The most an agent carries at once. Every one of them is read on every request. */
export const MOST_CARRIED = 48;

/** The most closed entries kept. The oldest are let go first. */
const MOST_CLOSED = 200;

const INSTRUCTIONS = [
  "You read a record of what an assistant did and decide what it should carry into",
  "every future conversation. You are given three things: the exchanges it had, the",
  "notes it wrote while working, and what it carries now. Entries of the first two have",
  "an id; so does each thing carried.",
  "",
  "Propose only what the record shows. Two kinds of thing are worth carrying:",
  '- a fact ("kind": "fact"): a standing fact, a preference stated outright, a',
  "  constraint that held every time, something that failed the same way more than once.",
  '- a procedure ("kind": "procedure", with a "name"): a way of doing something that',
  "  worked, in steps, that would work again.",
  "Not a summary of what was discussed. If the record supports nothing durable, propose",
  "nothing; an empty list is a correct answer and a common one. Do not propose something",
  "that is already carried.",
  "",
  "Each proposal must cite the ids of the exchanges or notes it came from, and must be",
  "true of those on their own. Do not generalise past them, do not turn a one-off into a",
  "pattern, and do not carry forward anything that will not still be true next month.",
  "",
  "Then check what is carried against the record. Where an exchange or note shows that",
  'something carried has changed, propose what is true now and list the carried id under',
  '"replaces". Where the record shows something carried is no longer true and nothing',
  'takes its place, list it under "retire" with the ids that show it and one line saying',
  "why. Something the record simply does not mention is left alone: silence is not",
  "evidence against it.",
].join("\n");

/**
 * Strip a plan down to something that only reads the record.
 *
 * No tools and no memory, so what it proposes comes from what is put in front of it and
 * nowhere else.
 */
export function reviewerPlan(plan: AgentPlan): AgentPlan {
  return {
    ...plan,
    name: `${plan.name}:review`,
    description: "Proposes what an agent should carry forward.",
    instructions: INSTRUCTIONS,
    services: [],
    locals: [],
    delegates: undefined,
    memory: false,
    memoryStore: undefined,
    memoryRecall: undefined,
    self: undefined,
    greeting: undefined,
    quality: "best",
    returns: {
      notes:
        'a list of { "kind": "fact" or "procedure", "name": what a procedure is called, "text": the durable thing, "from": the ids it came from, "replaces": carried ids it takes the place of, if any }',
      retire: 'a list of { "id": a carried id, "from": the ids that show it is no longer true, "why": one line }',
    },
  };
}

function render(episodes: Episode[], jottings: Jotting[], carried: Note[]): string {
  const outside = (origin: Origin): string => (origin === "external" ? " (carries text from outside the app)" : "");
  const exchanges = episodes
    .map((e) => `[${e.id}]${outside(e.origin)} asked: ${e.input.slice(0, 600)}\n     answered: ${e.answer.slice(0, 600)}`)
    .join("\n\n");
  const notes = jottings
    .map((n) => `[${n.id}]${outside(n.origin)} ${n.subject}: ${n.text.slice(0, 600)}`)
    .join("\n\n");
  const held = carried
    .map((note) => `[${note.id}] ${note.kind}${note.name ? ` "${note.name}"` : ""}: ${note.text}`)
    .join("\n");
  return [
    `Exchanges:\n\n${exchanges || "(none)"}`,
    `Notes it wrote:\n\n${notes || "(none)"}`,
    `Carried now:\n${held || "(nothing)"}`,
  ].join("\n\n");
}

type Source = { id: string; origin: Origin };

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : []).filter((entry): entry is string => typeof entry === "string");

/** Keep only proposals that say something and cite what was actually read. */
function usable(proposed: unknown, read: Map<string, Source>, carried: Map<string, Note>, at: number): ProposedNote[] {
  if (!Array.isArray(proposed)) return [];
  const notes: ProposedNote[] = [];
  for (const entry of proposed) {
    if (!entry || typeof entry !== "object") continue;
    const { kind, name, text, from, replaces } = entry as Record<string, unknown>;
    if (typeof text !== "string" || !text.trim()) continue;
    const procedure = kind === "procedure";
    // A way of doing something with no name cannot be told from the one beside it.
    if (procedure && (typeof name !== "string" || !name.trim())) continue;
    const cited = strings(from).filter((id) => read.has(id));
    // A proposal citing nothing that was read is one nobody can check, and the likeliest
    // reason for it is that the model made it up.
    if (!cited.length) continue;
    const rivals = strings(replaces).filter((id) => carried.has(id));
    notes.push({
      kind: procedure ? "procedure" : "fact",
      ...(procedure ? { name: (name as string).trim().slice(0, NAME_LENGTH) } : {}),
      text: text.trim().slice(0, procedure ? PROCEDURE_LENGTH : FACT_LENGTH),
      from: cited,
      origin: authorityOf(cited.map((id) => read.get(id)!.origin)),
      at,
      ...(rivals.length ? { replaces: rivals } : {}),
    });
    if (notes.length >= MOST_PROPOSED) break;
  }
  return notes;
}

function retirements(proposed: unknown, read: Map<string, Source>, carried: Map<string, Note>, at: number): Retirement[] {
  if (!Array.isArray(proposed)) return [];
  const out: Retirement[] = [];
  for (const entry of proposed) {
    if (!entry || typeof entry !== "object") continue;
    const { id, from, why } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !carried.has(id) || out.some((other) => other.id === id)) continue;
    const cited = strings(from).filter((source) => read.has(source));
    if (!cited.length) continue;
    out.push({
      id,
      why: typeof why === "string" ? why.trim().slice(0, WHY_LENGTH) : "",
      from: cited,
      origin: authorityOf(cited.map((source) => read.get(source)!.origin)),
      at,
    });
  }
  return out;
}

/** What a review reads. */
export interface ReviewInput {
  episodes: Episode[];
  jottings: Jotting[];
  /** What the agent carries now. */
  carried: Note[];
}

/**
 * Read the record and propose what should change in what the agent carries. Returns the
 * proposal; it is the caller's business whether it is ever written anywhere.
 */
export async function review(harness: Harness, plan: AgentPlan, record: ReviewInput): Promise<Candidate> {
  const episodes = record.episodes.filter((e) => !e.redactedAt).slice(-MOST_EPISODES);
  const jottings = record.jottings.filter((n) => !n.redactedAt).slice(-MOST_JOTTINGS);
  const carried = record.carried.filter((note) => note.until === undefined);
  const times = [...episodes, ...jottings].map((entry) => entry.at);
  const at = Date.now();
  const base: Candidate = {
    agent: plan.memoryAs ?? plan.name,
    at,
    read: {
      episodes: episodes.length,
      jottings: jottings.length,
      carried: carried.length,
      since: times.length ? Math.min(...times) : 0,
      until: times.length ? Math.max(...times) : 0,
    },
    notes: [],
    retire: [],
  };

  if (!episodes.length && !jottings.length) return { ...base, problems: ["there was nothing to read"] };

  let answer;
  try {
    answer = await harness.ask(reviewerPlan(plan), render(episodes, jottings, carried));
  } catch (err) {
    return { ...base, problems: [`could not read the record: ${(err as Error).message}`] };
  }

  const proposed = (answer.data ?? {}) as { notes?: unknown; retire?: unknown };
  const read = new Map<string, Source>([...episodes, ...jottings].map((entry) => [entry.id, entry]));
  const held = new Map(carried.map((note) => [note.id, note]));
  const notes = usable(proposed.notes, read, held, at);
  const retire = retirements(proposed.retire, read, held, at);

  const problems: string[] = [];
  const dropped = (Array.isArray(proposed.notes) ? proposed.notes.length : 0) - notes.length;
  if (dropped > 0) problems.push(`${dropped} proposed entries cited nothing that was read, or said nothing`);
  const unshown = (Array.isArray(proposed.retire) ? proposed.retire.length : 0) - retire.length;
  if (unshown > 0) problems.push(`${unshown} proposed retirements named nothing carried, or cited nothing that was read`);

  return { ...base, notes, retire, ...(problems.length ? { problems } : {}) };
}

/** Which of two entries that cannot both stand is the one to carry. */
export function preferred<A extends { origin: Origin; at: number }, B extends { origin: Origin; at: number }>(
  held: A,
  incoming: B,
): A | B {
  const byAuthority = RANK[incoming.origin] - RANK[held.origin];
  if (byAuthority !== 0) return byAuthority > 0 ? incoming : held;
  return incoming.at >= held.at ? incoming : held;
}

const newId = (): string => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const same = (a: string, b: string): boolean =>
  a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

const label = (note: { kind: Note["kind"]; name?: string; text: string }): string =>
  `"${(note.name ?? note.text).slice(0, 60)}"`;

/**
 * Apply the chosen parts of a proposal to what is carried.
 *
 * Pure: handed what is carried and what was chosen, answers with what should be carried
 * and what was refused. Precedence is authority first, then time, and both are compared
 * as values. Nothing here asks a model which of two entries is the more recent or the
 * more trustworthy.
 */
export function settle(
  carried: Note[],
  notes: ProposedNote[],
  retire: Retirement[],
  now = Date.now(),
): { notes: Note[] } & Accepted {
  const all = carried.map((note) => ({ ...note }));
  const live = (): Note[] => all.filter((note) => note.until === undefined);
  const kept: Note[] = [];
  const closed: Note[] = [];
  const refused: string[] = [];

  const close = (note: Note, replacedBy?: string): void => {
    note.until = now;
    if (replacedBy) note.replacedBy = replacedBy;
    closed.push(note);
  };

  for (const proposal of notes) {
    if (live().some((note) => note.kind === proposal.kind && same(note.text, proposal.text))) {
      refused.push(`${label(proposal)} is already carried`);
      continue;
    }
    const rivals = live().filter((note) => proposal.replaces?.includes(note.id));
    const stronger = rivals.find((rival) => preferred(rival, proposal) === rival);
    if (stronger) {
      refused.push(
        `${label(proposal)} would replace ${label(stronger)}, which came from a source of higher authority (${stronger.origin} over ${proposal.origin}); what is carried was kept`,
      );
      continue;
    }
    const { replaces: _replaces, ...rest } = proposal;
    const note: Note = { ...rest, id: newId() };
    for (const rival of rivals) close(rival, note.id);
    all.push(note);
    kept.push(note);
  }

  for (const retirement of retire) {
    const note = live().find((candidate) => candidate.id === retirement.id);
    if (!note) {
      refused.push(`nothing carried under ${retirement.id}; it may have been closed already`);
      continue;
    }
    if (RANK[retirement.origin] < RANK[note.origin]) {
      refused.push(
        `${label(note)} was kept: what speaks against it came from a source of lower authority (${retirement.origin} under ${note.origin})`,
      );
      continue;
    }
    close(note);
  }

  const open = all.filter((note) => note.until === undefined);
  const shut = all.filter((note) => note.until !== undefined).slice(-MOST_CLOSED);
  return { notes: [...shut, ...open], kept, closed, refused };
}

/**
 * Where proposals and what is carried are kept, one file each per agent.
 *
 * A proposal lives beside the record and not inside it, so accepting one is a separate
 * act with its own file and rejecting one is a delete.
 */
export class NoteBook {
  private readonly dir: string;
  private readonly cipher?: StateCipher;

  constructor(
    dir: string,
    /** Seals what is kept: it is made from an agent's memory, and is sealed where that is. */
    cipher?: StateCipher,
  ) {
    this.dir = dir;
    this.cipher = cipher;
  }

  private file(agent: string, kind: "proposal" | "carried"): string {
    return join(memoryDir(this.dir, agent), `${kind}.json`);
  }

  /** Put a proposal up for review, replacing any earlier unaccepted one. */
  async propose(candidate: Candidate): Promise<void> {
    await updateState<Candidate | null>(this.file(candidate.agent, "proposal"), this.cipher, () => null, () => candidate);
  }

  /** The proposal waiting on this agent, if there is one. */
  async pending(agent: string): Promise<Candidate | undefined> {
    return (await readState<Candidate | null>(this.file(agent, "proposal"), this.cipher)) ?? undefined;
  }

  /** Everything ever carried, closed entries first. */
  async history(agent: string): Promise<Note[]> {
    return (await readState<Note[]>(this.file(agent, "carried"), this.cipher)) ?? [];
  }

  /** What this agent carries now. Empty until something has been accepted. */
  async notes(agent: string): Promise<Note[]> {
    return (await this.history(agent)).filter((note) => note.until === undefined);
  }

  /**
   * Adopt a proposal, in whole or in part.
   *
   * `keep` selects by position, counting the proposed entries first and the retirements
   * after them; omitting it takes everything. What is adopted is added to what is
   * carried. Nothing already carried is dropped for not being proposed again.
   */
  async accept(agent: string, keep?: number[]): Promise<Accepted> {
    const candidate = await this.pending(agent);
    if (!candidate) throw new Error(`there is no proposal waiting on ${agent}`);

    const chosen = (at: number): boolean => !keep || keep.includes(at);
    const notes = candidate.notes.filter((_, at) => chosen(at));
    const retire = candidate.retire.filter((_, at) => chosen(candidate.notes.length + at));

    let outcome: Accepted = { kept: [], closed: [], refused: [] };
    await updateState<Note[]>(this.file(agent, "carried"), this.cipher, () => [], (held) => {
      const settled = settle(held, notes, retire);
      const carrying = settled.notes.filter((note) => note.until === undefined).length;
      if (carrying > MOST_CARRIED) {
        throw new Error(
          `accepting this would have ${agent} carry ${carrying} entries, and the most is ${MOST_CARRIED}: ` +
            `every one is read on every request. Accept fewer, or retire some first.`,
        );
      }
      outcome = { kept: settled.kept, closed: settled.closed, refused: settled.refused };
      return settled.notes;
    });
    await this.reject(agent);
    return outcome;
  }

  /** Stop carrying one entry, by a person's own decision. It is closed, not deleted. */
  async retire(agent: string, id: string): Promise<boolean> {
    let done = false;
    await updateState<Note[]>(this.file(agent, "carried"), this.cipher, () => [], (held) => {
      const note = held.find((candidate) => candidate.id === id && candidate.until === undefined);
      if (!note) return undefined;
      note.until = Date.now();
      done = true;
      return held;
    });
    return done;
  }

  /** Throw a proposal away. The record it was drawn from is untouched. */
  async reject(agent: string): Promise<void> {
    await rm(this.file(agent, "proposal"), { force: true });
  }

  /** The proposal and everything carried, gone. */
  async drop(agent: string): Promise<void> {
    await this.reject(agent);
    await rm(this.file(agent, "carried"), { force: true });
  }
}

/** Render what is carried as an instruction block: facts, then procedures. */
export function renderNotes(notes: Note[]): string {
  const live = notes.filter((note) => note.until === undefined);
  const facts = live.filter((note) => note.kind === "fact").map((note) => `- ${note.text}`);
  const ways = live.filter((note) => note.kind === "procedure").map((note) => `- ${note.name}: ${note.text}`);
  return [
    facts.length ? `What you have learned across past conversations:\n${facts.join("\n")}` : "",
    ways.length ? `Procedures you can reuse:\n${ways.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
