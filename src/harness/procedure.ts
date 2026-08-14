/**
 * The procedural memory an agent keeps — named, reusable procedures, held to the
 * same floor as its semantic notes.
 *
 * Where a Note (see consolidate.ts) is a durable FACT — "this customer is on the
 * annual plan" — a Procedure is a durable WAY — "to export a file over a gigabyte,
 * split it first, then upload the parts". It is the fourth of the CoALA memory types
 * (working / episodic / semantic / procedural), and the one an LLM-agent framework
 * usually lacks: agents accumulate facts but never procedures, so nothing compounds.
 *
 * It is kept exactly the way notes are, and for the same reason. A procedure is
 * PROPOSED as a candidate and never adopted in the same motion; every procedure cites
 * the traces it was drawn from, so one whose sources do not support it is one to throw
 * out; accepting is a separate, human act; and an accepted set replaces the last one
 * rather than accumulating. A memory that rewrites itself has no floor — the discipline
 * that protects the notes protects the procedures.
 *
 * What this is NOT: a runtime. Turning a procedure into running code is a sandbox that
 * belongs to the app (a driver), not this store. This is the memory of the way; the
 * executing of it is first light.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** One durable way, and the traces it was drawn from. */
export interface Procedure {
  name: string;
  /** The reusable way, in steps. */
  recipe: string;
  /** Trace/episode ids. A procedure that cites nothing cannot be checked, so is dropped. */
  from: string[];
}

/** A proposal. Nothing here is in use until it is accepted. */
export interface ProcedureCandidate {
  agent: string;
  at: number;
  procedures: Procedure[];
  problems?: string[];
}

/** What the agent can reuse, once somebody has agreed to it. */
export interface Skills {
  agent: string;
  at: number;
  procedures: Procedure[];
}

const MOST_PROCEDURES = 24;
const RECIPE_LENGTH = 800;

/**
 * Keep only procedures that name a way, describe it, and cite traces that were
 * actually seen — the same validity gate `usable` applies to notes. A procedure
 * citing nothing that was read is one nobody can check, and the likeliest reason
 * for it is that the model made it up.
 */
export function usableProcedures(proposed: unknown, known: Set<string>): Procedure[] {
  if (!Array.isArray(proposed)) return [];
  const out: Procedure[] = [];
  for (const entry of proposed) {
    if (!entry || typeof entry !== "object") continue;
    const { name, recipe, from } = entry as { name?: unknown; recipe?: unknown; from?: unknown };
    if (typeof name !== "string" || !name.trim()) continue;
    if (typeof recipe !== "string" || !recipe.trim()) continue;
    const cited = (Array.isArray(from) ? from : []).filter(
      (id): id is string => typeof id === "string" && known.has(id),
    );
    if (!cited.length) continue;
    out.push({ name: name.trim(), recipe: recipe.trim().slice(0, RECIPE_LENGTH), from: cited });
    if (out.length >= MOST_PROCEDURES) break;
  }
  return out;
}

/**
 * Where procedure proposals and accepted skills are kept, one file each per agent —
 * the same candidate/accept floor as NoteBook. A candidate lives beside the traces
 * rather than inside them, so accepting one is a separate act with its own file and
 * rejecting one is a delete.
 */
export class SkillBook {
  private readonly dir: string;
  constructor(
    dir: string
  ) {
    this.dir = dir;
}

  private file(agent: string, kind: "candidate" | "skills"): string {
    return join(this.dir, `${agent.replace(/[^\w.-]/g, "_")}.proc-${kind}.json`);
  }

  private async read<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  private async write(path: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
    await rename(temp, path);
  }

  /** Put a proposal up for review, replacing any earlier unaccepted one. */
  async propose(candidate: ProcedureCandidate): Promise<void> {
    await this.write(this.file(candidate.agent, "candidate"), candidate);
  }

  /** The proposal waiting on this agent, if there is one. */
  pending(agent: string): Promise<ProcedureCandidate | undefined> {
    return this.read<ProcedureCandidate>(this.file(agent, "candidate"));
  }

  /** What this agent can reuse. Empty until something has been accepted. */
  async skills(agent: string): Promise<Procedure[]> {
    const held = await this.read<Skills>(this.file(agent, "skills"));
    return Array.isArray(held?.procedures) ? held.procedures : [];
  }

  /**
   * Adopt a proposal, in whole or in part. `keep` selects by position; omitting it
   * takes all of them. Accepted procedures replace the previous set — a procedure the
   * last pass left out was left out on purpose.
   */
  async accept(agent: string, keep?: number[]): Promise<Procedure[]> {
    const candidate = await this.pending(agent);
    if (!candidate) throw new Error(`there is no procedure proposal waiting on ${agent}`);
    const procedures = keep
      ? keep.map((at) => candidate.procedures[at]).filter((p): p is Procedure => Boolean(p))
      : candidate.procedures;
    await this.write(this.file(agent, "skills"), { agent, at: Date.now(), procedures } satisfies Skills);
    await this.reject(agent);
    return procedures;
  }

  /** Throw a proposal away. The traces it was drawn from are untouched. */
  async reject(agent: string): Promise<void> {
    await unlink(this.file(agent, "candidate")).catch(() => {});
  }
}

/** Render accepted procedures as an instruction block, alongside the notes. */
export function renderSkills(procedures: Procedure[]): string {
  if (!procedures.length) return "";
  const lines = procedures.map((p) => `- ${p.name}: ${p.recipe}`).join("\n");
  return `Procedures you can reuse:\n${lines}`;
}
