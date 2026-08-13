/**
 * Run persistence. A workflow that pauses for approval has to outlive the
 * process it started in, so every run is a JSON file under the state
 * directory. Completed steps are recorded with their outputs, which is what
 * makes resuming a replay rather than a re-run — an approved workflow never
 * pays for the same model call twice.
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Step } from "../define.js";

export type RunStatus = "running" | "waiting" | "done" | "failed";

export interface RunEvent {
  step: string;
  at: number;
  kind: "done" | "waiting" | "failed" | "skipped" | "planned" | "judged";
  detail?: string;
}

/** Whether what the run produced was what the workflow said it should produce. */
export interface Outcome {
  held: boolean;
  /** What decided it, per check, in the order they were declared. */
  reasons: string[];
}

/**
 * What a `plan` step decided, kept so a resume runs the graph that was agreed.
 * Revisions are appended rather than overwriting: a plan that was replaced
 * because it failed is part of what happened, and losing it makes the run
 * impossible to account for afterwards.
 */
export interface PlanVersion {
  version: number;
  at: number;
  /** The failure that prompted a re-plan. Absent on the first version. */
  because?: string;
  steps: Step[];
}

export interface Run {
  id: string;
  workflow: string;
  status: RunStatus;
  input: Record<string, unknown>;
  /** Completed step outputs, keyed by scoped step id. */
  outputs: Record<string, unknown>;
  /** Provisioned graphs, keyed by the id of the `plan` step that produced them. */
  plans: Record<string, PlanVersion[]>;
  /** Everything the run has spent, across every model it called. */
  usage: { inputTokens: number; outputTokens: number };
  /** Set while status is "waiting". */
  waitingFor?: { step: string; prompt: string; requires?: { quorum?: number } };
  /** Append-only, non-repudiable decisions on the human gate — the audit trail and
   *  the accumulator for a quorum (who signed which step, and when). `approved` is
   *  false for a veto; absent means approved, on runs recorded before vetoes were
   *  ledgered. A veto is as much a governance act as a signature, so it lands here
   *  rather than only in the run's result. */
  approvals?: { step: string; approver?: string; signature: string; at: number; approved?: boolean }[];
  /** One entry per side-effecting `use` step that is mid-flight, keyed by scoped
   *  step id — persisted BEFORE the effect runs so a crash is detectable. Up to
   *  `concurrency` use steps run at once, so this is a map, not a single slot: a
   *  scalar would let concurrent steps clobber each other's marker. A re-drive that
   *  finds an entry for a step with no recorded output cannot prove the effect did
   *  not already happen, so it refuses rather than risk a double-execution
   *  (exactly-once discipline). */
  inflight?: Record<string, { key: string; at: number }>;
  /** Set once the run finishes. */
  result?: unknown;
  /** Set once a declared outcome has been checked. */
  outcome?: Outcome;
  error?: string;
  events: RunEvent[];
  startedAt: number;
  updatedAt: number;
}

export class RunStore {
  constructor(private readonly dir: string) {}

  /**
   * Writes for one run, chained.
   *
   * Steps run in parallel and each saves when it finishes, so without this two
   * writes share a temp file and one renames it out from under the other. The
   * chain also fixes the order, which is what makes the last file on disk the
   * latest state rather than whichever write happened to land last.
   */
  private readonly writes = new Map<string, Promise<void>>();

  private file(id: string): string {
    return join(this.dir, `${id.replace(/[^\w-]/g, "_")}.json`);
  }

  save(run: Run): Promise<void> {
    run.updatedAt = Date.now();
    // Serialised now, so what is queued is this moment's state, not a later one.
    const body = JSON.stringify(run, null, 2);
    const after = (this.writes.get(run.id) ?? Promise.resolve()).then(
      () => this.write(run.id, body),
      () => this.write(run.id, body),
    );
    this.writes.set(run.id, after);
    return after;
  }

  private async write(id: string, body: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(id);
    const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(temp, body, "utf8");
    await rename(temp, target);
  }

  async load(id: string): Promise<Run | undefined> {
    try {
      const run = JSON.parse(await readFile(this.file(id), "utf8")) as Run;
      // Read from disk, so it may have been truncated or hand-edited.
      run.outputs ??= {};
      run.plans ??= {};
      run.usage ??= { inputTokens: 0, outputTokens: 0 };
      run.events ??= [];
      // Runs persisted before inflight became a map used a single { step, key, at }
      // slot; carry the marker forward rather than dropping the evidence.
      const flight = run.inflight as unknown;
      if (flight && typeof (flight as { step?: unknown }).step === "string") {
        const old = flight as unknown as { step: string; key: string; at: number };
        run.inflight = { [old.step]: { key: old.key, at: old.at } };
      }
      return run;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<Run[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const runs: Run[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        runs.push(JSON.parse(await readFile(join(this.dir, name), "utf8")) as Run);
      } catch {
        // A half-written or hand-edited file should not break the listing.
      }
    }
    return runs.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
