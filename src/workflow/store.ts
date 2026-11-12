/**
 * Run persistence. A workflow that pauses for approval has to outlive the
 * process it started in, so every run is a JSON file under the state
 * directory. Completed steps are recorded with their outputs, which is what
 * makes resuming a replay rather than a re-run — an approved workflow never
 * pays for the same model call twice.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { FILE_MODE, privateDir, replaceFile } from "../private.js";
import type { Step } from "../define.js";
import type { SealedEntry } from "../journal.js";

/**
 * `cancelled` is a run somebody stopped. It is not `failed`: nothing went wrong,
 * and a reader counting failures must not count a person changing their mind.
 */
export type RunStatus = "running" | "waiting" | "done" | "failed" | "cancelled";

/** What a run stopped at a `wait` step is waiting for. */
export interface AwaitedEvent {
  type: string;
  source?: string;
  subject?: string;
  /** When the wait runs out, in milliseconds since the epoch. */
  until?: number;
  onTimeout?: "fail" | "continue";
}

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
  kind: "done" | "waiting" | "failed" | "skipped" | "planned" | "judged" | "patched" | "cancelled";
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
  waitingFor?: {
    step: string;
    prompt: string;
    requires?: { quorum?: number };
    digest?: string;
    /** Set when the run waits for an event and not for a person. An approval cannot answer it. */
    event?: AwaitedEvent;
  };
  /**
   * The events that continued this run, by where they came from and their id there.
   * A delivery that is already here is one this run has had, so an event sent twice
   * cannot answer two waits.
   */
  signals?: { step: string; source: string; id: string; at: number }[];
  /** When each `wait` step that has a timeout runs out, set the first time the run stops there. */
  deadlines?: Record<string, number>;
  /** Set when the run was cancelled: when, and what whoever cancelled it said. */
  cancelled?: { at: number; reason?: string; by?: string };
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

/**
 * A run's status changing, as of the save that made it so.
 *
 * Carries what a report of the change needs and nothing a run keeps private: no
 * outputs, no result, no error text.
 */
export interface RunTransition {
  run: string;
  workflow: string;
  /** What the run was before. Absent for a run this store had never held. */
  from?: RunStatus;
  to: RunStatus;
  /** The gate or the wait, when the run stopped at one. `until` is when a wait runs out. */
  waitingFor?: { step: string; prompt: string; until?: number };
  outcome?: Outcome;
}

/** A filename for an event as one workflow received it. Hashed: a source is a URI and an id is anything. */
function eventKey(workflow: string, source: string, id: string): string {
  return createHash("sha256").update(`${workflow}\n${source}\n${id}`).digest("hex").slice(0, 40);
}

/** Marks a sealed run file, so a store with a cipher never mistakes plaintext for ciphertext. */
const SEALED = "praecise-sealed-run:v1\n";

export class RunStore {
  private readonly dir: string;
  private readonly cipher?: RunCipher;
  private readonly onTransition?: (change: RunTransition) => void;
  /**
   * The status each run object had when it was last read or saved here, and the gate
   * it was stopped at: a run approved at one gate that stops at the next has gone from
   * waiting to waiting, and that is a change somebody has to be told about.
   *
   * Every path that moves a run — start, resume, recover, fork, a source or an event
   * starting one — ends in `save`, so comparing against this is the one place a change
   * of status can be seen exactly once. Keyed by the object, not the id: a run nobody
   * holds any more costs nothing to have known about.
   */
  private readonly known = new WeakMap<Run, { status: RunStatus; gate?: string }>();

  constructor(
    dir: string,
    options: {
      cipher?: RunCipher;
      /**
       * Called once per change of a run's status, after the save that recorded it has
       * reached disk. What it throws is dropped: telling somebody about a run must not
       * be able to fail the run.
       */
      onTransition?: (change: RunTransition) => void;
    } = {},
  ) {
    this.dir = dir;
    this.cipher = options.cipher;
    this.onTransition = options.onTransition;
  }

  /** Read one run file, opening it when the store seals. Plaintext is refused once a cipher is set. */
  private async read(path: string): Promise<Run> {
    const raw = await readFile(path);
    if (!this.cipher) return this.met(JSON.parse(raw.toString("utf8")) as Run);
    const head = Buffer.from(SEALED, "utf8");
    if (raw.length < head.length || !raw.subarray(0, head.length).equals(head)) {
      throw new Error(`${path} is not sealed, and this store only reads sealed runs`);
    }
    const plain = await this.cipher.open(raw.subarray(head.length));
    return this.met(JSON.parse(Buffer.from(plain).toString("utf8")) as Run);
  }

  /** Note the status a run came off disk with, so a later save can tell if it changed. */
  private met(run: Run): Run {
    this.known.set(run, { status: run.status, gate: run.waitingFor?.step });
    if (run.waitingFor?.event) this.awaited.add(run.id);
    return run;
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

  /** Runs this process knows to have a wait marker on disk, so it is removed once and not on every save. */
  private readonly awaited = new Set<string>();

  /**
   * A small file beside the runs: `waits/` for a run waiting on an event, `cancels/`
   * for a request to stop one, `taken/` for an event that continued one.
   */
  private beside(kind: "waits" | "cancels" | "taken", id: string): string {
    return join(this.dir, kind, `${id.replace(/[^\w-]/g, "_")}.json`);
  }

  private async note(kind: "waits" | "cancels" | "taken", id: string, value: unknown): Promise<void> {
    await privateDir(join(this.dir, kind));
    const target = this.beside(kind, id);
    const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(temp, JSON.stringify(value), { mode: FILE_MODE });
    await replaceFile(temp, target);
  }

  /**
   * The runs stopped at a `wait` step, and the event type each waits for.
   *
   * Kept as one small file per waiting run, so an event arriving does not mean
   * reading every run the app has ever made. The file says only the type and the
   * deadline; what else has to match is in the run, which is read (and opened,
   * where the store seals) before anything is continued. A marker whose run has
   * moved on is harmless for the same reason.
   */
  async waiting(): Promise<{ run: string; type: string; until?: number }[]> {
    let names: string[];
    try {
      names = await readdir(join(this.dir, "waits"));
    } catch {
      return [];
    }
    const found: { run: string; type: string; until?: number }[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const said = JSON.parse(await readFile(join(this.dir, "waits", name), "utf8")) as { run?: unknown; type?: unknown; until?: unknown };
        if (typeof said.run === "string" && typeof said.type === "string") {
          found.push({ run: said.run, type: said.type, ...(typeof said.until === "number" ? { until: said.until } : {}) });
        }
      } catch {
        // Being replaced right now. The run it names is found on the next look.
      }
    }
    return found;
  }

  /**
   * Record that an event continued a run of a workflow.
   *
   * A sender that retries delivers the event again after the run has moved on,
   * and by then nothing is waiting for it. Without this the retry would look
   * like an event nobody was waiting for, and would start a run.
   */
  eventTaken(workflow: string, source: string, id: string, run: string): Promise<void> {
    return this.note("taken", eventKey(workflow, source, id), { run });
  }

  /** The run of a workflow an event continued, if it continued one. */
  async eventTaker(workflow: string, source: string, id: string): Promise<string | undefined> {
    try {
      const said = JSON.parse(await readFile(this.beside("taken", eventKey(workflow, source, id)), "utf8")) as { run?: unknown };
      return typeof said.run === "string" ? said.run : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Ask whoever is driving a run to stop, when that is not this process.
   *
   * A driver holds its run in memory and writes it over whatever is on disk, so a
   * request to stop cannot live in the run file. It lives beside it, and the
   * runner looks before each step.
   */
  requestCancel(id: string, why: { reason?: string; by?: string } = {}): Promise<void> {
    return this.note("cancels", id, { at: Date.now(), ...why });
  }

  /** The request to stop a run, if one was made. */
  async cancelRequested(id: string): Promise<{ reason?: string; by?: string } | undefined> {
    try {
      return JSON.parse(await readFile(this.beside("cancels", id), "utf8")) as { reason?: string; by?: string };
    } catch {
      return undefined;
    }
  }

  /** Forget a request to stop a run, once it has been honoured. */
  async cancelHonoured(id: string): Promise<void> {
    await rm(this.beside("cancels", id), { force: true }).catch(() => undefined);
  }

  private file(id: string): string {
    return join(this.dir, `${id.replace(/[^\w-]/g, "_")}.json`);
  }

  save(run: Run): Promise<void> {
    run.updatedAt = Date.now();
    // Serialised now, so what is queued is this moment's state, not a later one.
    const body = JSON.stringify(run, null, 2);
    // What the wait marker should be after this save: written, removed, or left alone.
    const event = run.status === "waiting" ? run.waitingFor?.event : undefined;
    const mark = event
      ? { run: run.id, type: event.type, ...(event.until !== undefined ? { until: event.until } : {}) }
      : this.awaited.has(run.id)
        ? null
        : undefined;
    if (event) this.awaited.add(run.id);
    else this.awaited.delete(run.id);
    const after = (this.writes.get(run.id) ?? Promise.resolve()).then(
      () => this.write(run.id, body, mark),
      () => this.write(run.id, body, mark),
    );
    this.writes.set(run.id, after);

    const from = this.known.get(run);
    this.known.set(run, { status: run.status, gate: run.waitingFor?.step });
    if (this.onTransition && (from?.status !== run.status || from.gate !== run.waitingFor?.step)) {
      // Captured now for the same reason the body is: by the time the write lands the
      // run has usually moved on.
      const change: RunTransition = {
        run: run.id,
        workflow: run.workflow,
        ...(from ? { from: from.status } : {}),
        to: run.status,
        ...(run.waitingFor
          ? {
              waitingFor: {
                step: run.waitingFor.step,
                prompt: run.waitingFor.prompt,
                ...(run.waitingFor.event?.until !== undefined ? { until: run.waitingFor.event.until } : {}),
              },
            }
          : {}),
        ...(run.outcome ? { outcome: run.outcome } : {}),
      };
      const tell = this.onTransition;
      // Only once it is on disk: a change that was reported and then not recorded
      // would send a receiver looking for a state the run never reached.
      void after.then(
        () => {
          try {
            tell(change);
          } catch {
            // See `onTransition`.
          }
          return undefined;
        },
        () => undefined,
      );
    }
    return after;
  }

  private async write(id: string, body: string, mark?: { run: string; type: string; until?: number } | null): Promise<void> {
    await privateDir(this.dir);
    const target = this.file(id);
    const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    const bytes = this.cipher
      ? Buffer.concat([Buffer.from(SEALED, "utf8"), Buffer.from(await this.cipher.seal(Buffer.from(body, "utf8")))])
      : Buffer.from(body, "utf8");
    await writeFile(temp, bytes, { mode: FILE_MODE });
    await replaceFile(temp, target);
    // After the run, so a marker never names a wait the run file does not yet record.
    if (mark) await this.note("waits", id, mark);
    else if (mark === null) await rm(this.beside("waits", id), { force: true }).catch(() => undefined);
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
