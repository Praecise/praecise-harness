/**
 * Run persistence. A workflow that pauses for approval has to outlive the
 * process it started in, so every run is a JSON file under the state
 * directory. Completed steps are recorded with their outputs, which is what
 * makes resuming a replay rather than a re-run — an approved workflow never
 * pays for the same model call twice.
 */

import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { FILE_MODE, privateDir } from "../private.js";
import type { Step } from "../define.js";
import type { SealedEntry } from "../journal.js";

export type RunStatus = "running" | "waiting" | "done" | "failed";

export interface RunEvent {
  step: string;
  at: number;
  /**
   * `patched` is a person changing an earlier step's output when forking a run.
   *
   * It is a kind of its own rather than a `done` with a note, because "this value was
   * produced" and "this value was decided by a human afterwards" are different facts, and
   * anything reading the journal to judge what the workflow did needs to tell them apart.
   */
  kind: "done" | "waiting" | "failed" | "skipped" | "planned" | "judged" | "patched";
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
  waitingFor?: { step: string; prompt: string; requires?: { quorum?: number }; digest?: string };
  /**
   * Set once the run has read output from a tool that is not trusted. Every
   * action the run takes after that is marked tainted for the guard and the
   * authority, because its values may have been put there by that output.
   */
  tainted?: boolean;
  /**
   * The run's sealed journal, when the app configured one: every entry, how many
   * the sink has taken, and the anchors it gave back by entry number.
   */
  journal?: { entries: SealedEntry[]; delivered: number; anchors?: Record<number, string> };
  /**
   * Append-only decisions on the human gate — the audit trail, and the accumulator
   * for a quorum. `approved` is false for a veto; absent means approved, on runs
   * recorded before vetoes were ledgered. A veto is as much a governance act as an
   * approval, so it lands here rather than only in the run's result.
   *
   * How much an entry can be stood behind depends entirely on what the app wired.
   * With a signer and a verifier it is non-repudiable: `signature` was checked
   * against the claim before the entry was written, and `subject` is the identity
   * that check PROVED. Without them the entry is attributed and no more —
   * `unsigned` is set, `approver` is whatever the caller typed, and nothing here
   * is evidence of who acted. That distinction is on the record rather than in the
   * documentation because a reader years later has only the record.
   */
  approvals?: {
    step: string;
    /** What the approver called themselves. Attribution, never proof. */
    approver?: string;
    /** Present only when something signed it. Never synthesised. */
    signature?: string;
    /** Set when no signer was wired, so a missing signature reads as a fact rather
     *  than as data loss. */
    unsigned?: boolean;
    /** The identity `verify` proved from the signature. The only field a quorum
     *  counts, because it is the only one the approver did not choose. */
    subject?: string;
    /** Which surface the decision arrived on, so an agent approving its own run
     *  through the same API its tools use is visible afterwards. */
    channel?: string;
    at: number;
    approved?: boolean;
    /** The action digest the signed claim covered, for a gate the authority raised. */
    digest?: string;
  }[];
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
  /**
   * The run this one branched from, when it is a fork.
   *
   * Kept so a forked run is never mistaken for an independent one: its early steps were
   * not run here, they were carried, and a reader comparing two runs has to know that.
   */
  forkedFrom?: { run: string; after?: string };
  events: RunEvent[];
  startedAt: number;
  updatedAt: number;
}

/**
 * Encrypts run files at rest. The store hands over each run's bytes and keeps
 * only what comes back; where the key lives is the cipher's business.
 */
export interface RunCipher {
  seal(plain: Uint8Array): Promise<Uint8Array>;
  open(sealed: Uint8Array): Promise<Uint8Array>;
}

/** Marks a sealed run file, so a store with a cipher never mistakes plaintext for ciphertext. */
const SEALED = "praecise-sealed-run:v1\n";

export class RunStore {
  private readonly dir: string;
  private readonly cipher?: RunCipher;
  constructor(
    dir: string,
    options: { cipher?: RunCipher } = {},
  ) {
    this.dir = dir;
    this.cipher = options.cipher;
  }

  /** Read one run file, opening it when the store seals. Plaintext is refused once a cipher is set. */
  private async read(path: string): Promise<Run> {
    const raw = await readFile(path);
    if (!this.cipher) return JSON.parse(raw.toString("utf8")) as Run;
    const head = Buffer.from(SEALED, "utf8");
    if (raw.length < head.length || !raw.subarray(0, head.length).equals(head)) {
      throw new Error(`${path} is not sealed, and this store only reads sealed runs`);
    }
    const plain = await this.cipher.open(raw.subarray(head.length));
    return JSON.parse(Buffer.from(plain).toString("utf8")) as Run;
  }

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
    await privateDir(this.dir);
    const target = this.file(id);
    const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    const bytes = this.cipher
      ? Buffer.concat([Buffer.from(SEALED, "utf8"), Buffer.from(await this.cipher.seal(Buffer.from(body, "utf8")))])
      : Buffer.from(body, "utf8");
    await writeFile(temp, bytes, { mode: FILE_MODE });
    await rename(temp, target);
  }

  async load(id: string): Promise<Run | undefined> {
    try {
      const run = await this.read(this.file(id));
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
    } catch (err) {
      // A sealed run that will not open is not a missing run: saying "no such
      // run" would let a caller start over on top of one it cannot read.
      if (this.cipher && (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
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
        runs.push(await this.read(join(this.dir, name)));
      } catch {
        // A half-written or hand-edited file should not break the listing.
      }
    }
    return runs.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
