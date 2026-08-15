/**
 * One scheduler, several authoring shapes.
 *
 * A list of steps, a graph, and a loop are not three engines. Steps are held in
 * a ready set — everything whose dependencies are satisfied — and the set is
 * drained under a concurrency bound. A plain list is the case where the ready
 * set never holds more than one step, because each implicitly waits for the one
 * before it. Declaring `after` widens it. `repeat` re-arms the same set until a
 * check holds. `plan` fills it in from a model, once, and records what it
 * produced so a resume replays the same graph rather than inventing a new one.
 *
 * An `approve` step suspends the run to disk. Work already finished is kept, so
 * resuming replays recorded outputs and carries on from the pause — nothing
 * before the approval is paid for twice.
 */

import type { AgentPlan } from "../compile/plan.js";
import {
  isApprove,
  isAsk,
  isEach,
  isPlan,
  isRepeat,
  isUse,
  isWhen,
  type Check,
  type EachStep,
  type Limits,
  type PlanStep,
  type Quality,
  type RepeatStep,
  type Step,
  type WorkflowSpec,
} from "../define.js";
import { shapedFor } from "../compile/plan.js";
import { Gate } from "../gate.js";
import type { Harness } from "../harness/types.js";
import { safeMessage } from "../redact.js";
import { isLatent } from "../transport.js";
import { defectsIn } from "./defects.js";
import { interpolate } from "./interpolate.js";
import { judge } from "./judge.js";
import type { Run, RunEvent, RunStore } from "./store.js";
import { runCommand } from "./verify.js";

const DEFAULTS = { depth: 3, concurrency: 4, timeout: 600 } as const;

/** What a `plan` step asks for, and what it must be given back. */
export interface ProvisionRequest {
  /** The brief, already interpolated. */
  brief: string;
  /** Agents the plan may draw on. Empty ⇒ all of them. */
  from: string[];
  /**
   * Non-escalation ceiling: tools the provisioned steps may call.
   *
   * Absent ⇒ NONE. A model-authored graph starts with no authority and is
   * granted what the author names, because the alternative — a `plan` step whose
   * author said nothing about tools handing the model everything the app has,
   * `effect: "destructive"` included — makes the least deliberate thing an
   * author can write the most powerful.
   */
  tools?: string[];
  /** Ceiling on how many steps may come back. */
  max: number;
  /** How far down the provisioning tree this is. */
  depth: number;
  /** What the run knows so far, for the planner to refer to. */
  scope: Record<string, unknown>;
  /** Set when re-planning after a failure, with the reason. */
  because?: string;
  /**
   * The harness the planning call must run on.
   *
   * Not the provisioner's own: this one is metered against the run's budget and
   * bounded by the run's timeout. Laying out the work is a completion like any
   * other, it runs at the most expensive rung, and it is the FIRST thing a
   * plan-driven workflow does — a ceiling that does not cover it is a ceiling
   * that starts applying after the largest single call of the run.
   */
  harness: Harness;
}

export interface ProvisionResult {
  steps: Step[];
  notes?: string[];
}

/** An OpenTelemetry GenAI-shaped span, emitted per step. Zero-dependency: praecise
 *  produces the standard shape (`invoke_agent`/`execute_tool`/`plan`), the app wires
 *  `emit` to a real OTel exporter. Attribute names follow the gen_ai semantic
 *  conventions so praecise is legible to Phoenix/LangSmith/Datadog without a new dep. */
export interface GenAiSpan {
  operation: "invoke_agent" | "execute_tool" | "plan" | "invoke_workflow";
  name: string;
  step: string;
  attributes: Record<string, unknown>;
  durationMs: number;
  at: number;
}

/**
 * Exactly what an approval binds itself to.
 *
 * Everything a signature covers and nothing derived, so a verifier can rebuild
 * the claim from the run and the ledger entry alone and check it again years
 * later. `at` is part of it and therefore travels WITH the signature: a receiver
 * that stamps its own arrival time has changed the claim and could never verify
 * what it was handed.
 */
export interface ApprovalClaim {
  runId: string;
  step: string;
  approver?: string;
  approved: boolean;
  at: number;
}

/** A decision on a waiting run's gate. */
export interface ApprovalDecision {
  approved: boolean;
  note?: string;
  /** What the approver calls themselves. Free text the caller chose — attribution,
   *  never proof. Only a verified signature can carry an identity. */
  approver?: string;
  /** A signature over the claim. Verified before it is stored, or refused. */
  signature?: string;
  /** When the decision was made; defaults to now. Send back the same value that
   *  was signed, or the signature cannot verify. */
  at?: number;
  /** How this decision reached the runner: "http", "cli", whatever the app calls
   *  its surfaces. Recorded on the ledger, and checked against
   *  `WorkflowDeps.approvalChannels` when the app has narrowed them. */
  channel?: string;
}

export interface WorkflowDeps {
  harness: Harness;
  /** Plan for an `ask` step; no agent means the workflow's general-purpose agent. */
  planFor(agent: string | undefined, quality: Quality | undefined): Promise<AgentPlan>;
  /** Invoke `service.tool`, or a local function, with the given arguments. `opts`
   *  carries a derived idempotency key so a compliant tool can dedupe a retried side
   *  effect (exactly-once when the downstream honours it), and the origin of the
   *  call so a guard can tell a workflow step from whoever can reach the port. */
  callTool(
    ref: string,
    args: unknown,
    opts?: { idempotencyKey?: string; via?: "workflow"; run?: string; step?: string },
  ): Promise<unknown>;
  store: RunStore;
  /** Ceilings, inherited by everything the run provisions. */
  limits?: Limits;
  /**
   * The agents that exist, so a step naming one that does not is refused before
   * the run starts rather than discovered part-way through a paid graph.
   *
   * Absent ⇒ `agent:` references go unchecked, which is the honest answer for a
   * caller driving a spec directly: it holds no registry, and refusing every
   * named agent against an empty set would refuse everything.
   */
  knownAgents?: Iterable<string>;
  /** Turns a `plan` step's brief into steps. Absent ⇒ `plan` steps report why. */
  provision?(request: ProvisionRequest): Promise<ProvisionResult>;
  /** Optional OTel GenAI span sink — receives a standard-shaped span per step. */
  emit?(span: GenAiSpan): void;
  /**
   * Sign an approval claim — an OIDC token, a KMS key, a WebAuthn assertion.
   *
   * With no signer, NOTHING is synthesised: the entry records `unsigned: true`
   * and carries no signature at all. A hash over the run id, the step name and
   * the approver's own words is computable by anyone who can read a run listing,
   * so calling it a signature would be a lie the audit trail then carries
   * forever — and a fake signature is worse than an absent one, because the
   * absent one is not believed.
   */
  sign?(claim: ApprovalClaim): Promise<string>;
  /**
   * Check a signature against the claim it should cover, and answer with the
   * identity it PROVES — not with a boolean.
   *
   * The subject is the whole point. `approver` is a string the caller typed, so
   * counting distinct approvers counts nothing; a two-person rule can only be
   * built out of identities something checked. Answer `undefined` for a
   * signature that does not hold up and the approval is refused rather than
   * recorded.
   */
  verify?(claim: ApprovalClaim, signature: string): Promise<string | undefined>;
  /**
   * The channels an approval may arrive on. Absent ⇒ any.
   *
   * An agent holding any HTTP tool can read its own run id from the run listing
   * and post its own approval — a two-person rule satisfied twice over by one
   * process. Naming the channels here (`["cli"]`, say, when the agents' tools
   * can only reach `"http"`) is what puts the gate somewhere the run itself
   * cannot reach.
   */
  approvalChannels?: string[];
}

/** Thrown to unwind out of a nested step when the run hits an approval gate. */
class Suspend {
  readonly step: string;
  readonly prompt: string;
  readonly requires?: { quorum?: number };
  constructor(
    step: string,
    prompt: string,
    requires?: { quorum?: number },
  ) {
    this.step = step;
    this.prompt = prompt;
    this.requires = requires;
  }
}

/** Everything the scheduler carries down that is not the step itself. */
interface Context {
  run: Run;
  deps: WorkflowDeps;
  limits: { depth: number; concurrency: number; timeout: number; budget?: number };
  depth: number;
  /**
   * How much of the run may be doing paid work at once, for the whole run.
   *
   * Shared by every nesting level rather than made fresh per list, which is the
   * only way the number means anything: a four-wide `each` whose body is a
   * four-wide graph is sixteen calls in flight under a per-list bound of four.
   */
  gate: Gate;
}

/**
 * Outputs of a nested body, under the names the body itself wrote.
 *
 * Steps inside `repeat`, `each` and `when` are recorded under the enclosing
 * step so a second attempt does not collide with the first, which also puts
 * them out of reach of `{{name}}`. Exposing them locally is what lets a body
 * refer to itself: without it a repeat can only ever re-run the same prompt,
 * and a loop that cannot see its last attempt is not repair.
 */
function localTo(outputs: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const at = `${prefix}.`;
  const local: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(outputs)) {
    if (id.startsWith(at)) local[id.slice(at.length)] = value;
  }
  return local;
}

const scopeOf = (
  run: Run,
  extra: Record<string, unknown>,
  prefix = "",
): Record<string, unknown> => ({
  ...run.input,
  ...run.outputs,
  // Nearest wins: inside a body, a bare name means this attempt's step, not the
  // one of the same name that ran outside it.
  ...(prefix ? localTo(run.outputs, prefix) : {}),
  ...extra,
});

function newRunId(workflow: string): string {
  return `${workflow.replace(/[^\w-]/g, "_")}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/**
 * Fail a step that outruns its ceiling rather than letting it hang the run.
 *
 * `stop` is aborted alongside the rejection wherever the work can hear it. A
 * race that only rejects bounds how long the run WAITS and not what it spends:
 * the request carries on at the far end, still being billed, with nobody left
 * to read the answer.
 */
function withTimeout<T>(
  work: Promise<T>,
  seconds: number,
  what: string,
  stop?: AbortController,
): Promise<T> {
  if (!(seconds > 0)) return work;
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${what} took longer than ${seconds}s`);
      stop?.abort(err);
      reject(err);
    }, seconds * 1000);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * The harness every model call inside a run goes through.
 *
 * Two things a run must be able to say about a completion — that it was counted
 * against the budget, and that it cannot hang — are properties of the CALL, not
 * of the step that happened to make it. Accounting for them at the step is what
 * left three whole classes of spend uncounted and unbounded: the `plan` call
 * that lays out the work, the judge that decides whether the outcome held, and
 * every extra sample the router takes on the way to an answer. Wrapping the
 * boundary is what makes both true of the calls nobody remembered to wrap.
 */
function bound(ctx: Context, what: string): Harness {
  const inner = ctx.deps.harness;
  return {
    name: inner.name,
    async ask(plan, input, options) {
      const stop = new AbortController();
      const given = options?.signal;
      if (given?.aborted) stop.abort(given.reason);
      else given?.addEventListener("abort", () => stop.abort(given.reason), { once: true });

      const answer = await withTimeout(
        inner.ask(plan, input, { ...options, signal: stop.signal }),
        ctx.limits.timeout,
        what,
        stop,
      );
      spend(ctx, what, answer.usage);
      return answer;
    },
  };
}

// ── Checks ─────────────────────────────────────────────────────────────────

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a && b && typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
}

/** Does the condition hold? A failing command is a false, not an exception. */
async function holds(
  check: Check,
  scope: Record<string, unknown>,
  ctx: Context,
  what: string,
): Promise<{ ok: boolean; detail?: string }> {
  if ("passes" in check) {
    const command = String(interpolate(check.passes, scope, what) ?? "");
    const { ok, output } = await runCommand(command, {
      cwd: check.in,
      timeout: ctx.limits.timeout * 1000,
    });
    return { ok, detail: ok ? undefined : output.slice(0, 500) };
  }

  if ("equals" in check) {
    const actual = interpolate(check.equals, scope, what);
    return {
      ok: sameValue(actual, check.to),
      detail: `expected ${JSON.stringify(check.to)}, got ${JSON.stringify(actual)}`,
    };
  }

  const plan = await ctx.deps.planFor(undefined, "balanced");
  const verdict = await ctx.gate.run(() =>
    judge(
      bound(ctx, what),
      plan,
      String(interpolate(check.asks, scope, what) ?? ""),
      materialOf(scope),
    ),
  );
  return { ok: verdict.holds, detail: verdict.holds ? undefined : verdict.why.slice(0, 500) };
}

/** Bound on how much of the run is laid in front of the judge. */
const MATERIAL = 20_000;

/**
 * What the run produced, for the judge to read.
 *
 * Values only — the judge is shown what came out, never how it was arrived at.
 * A latent payload is refused outright rather than JSON-stringified: an opaque
 * vector (`audit: false` by construction) is not evidence to any reader, and a
 * judgment laundered through one would claim a legibility it does not have.
 * Probe it, or decode it to text, before putting it in front of a judge.
 */
export function materialOf(scope: Record<string, unknown>): string {
  const parts: string[] = [];
  let spent = 0;
  for (const [name, value] of Object.entries(scope)) {
    if (value === undefined || value === null) continue;
    if (isLatent(value)) {
      throw new Error(
        `"${name}" is a latent payload (audit: false) — an opaque vector can never be judge evidence. Probe it or decode it to text before judging.`,
      );
    }
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const room = MATERIAL - spent;
    if (room <= 0) break;
    parts.push(`${name}:\n${text.slice(0, room)}`);
    spent += text.length;
  }
  return parts.join("\n\n");
}

// ── One step ───────────────────────────────────────────────────────────────

function spend(
  ctx: Context,
  what: string,
  usage: { inputTokens: number; outputTokens: number },
): void {
  ctx.run.usage.inputTokens += usage.inputTokens;
  ctx.run.usage.outputTokens += usage.outputTokens;

  const budget = ctx.limits.budget;
  if (!budget) return;
  const total = ctx.run.usage.inputTokens + ctx.run.usage.outputTokens;
  if (total > budget) {
    throw new Error(
      `run passed its budget of ${budget.toLocaleString()} tokens at ${what} ` +
        `(${total.toLocaleString()} spent)`,
    );
  }
}

/** A stable idempotency key for a side-effecting step, derived from (run, step, args)
 *  so a crash-retry presents the SAME key and a compliant tool dedupes. Never random —
 *  a fresh key on every attempt would defeat the purpose. */
function idemKey(runId: string, stepId: string, args: unknown): string {
  const s = `${runId}:${stepId}:${JSON.stringify(args ?? null)}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `idem-${(h >>> 0).toString(16)}`;
}

async function runStep(
  step: Step,
  prefix: string,
  ctx: Context,
  extra: Record<string, unknown>,
): Promise<unknown> {
  const { run, deps } = ctx;
  const id = prefix ? `${prefix}.${step.id}` : step.id;

  // Replay: a step that already produced an output is not run again.
  if (id in run.outputs) return run.outputs[id];

  const scope = scopeOf(run, extra, prefix);
  let output: unknown;

  if (isAsk(step)) {
    const t0 = Date.now();
    const plan = shapedFor(await deps.planFor(step.agent, step.quality), step.returns);
    // The permit is held around the call and nothing else. Holding it across the
    // scheduling of nested work would let parents starve their own children of
    // the permits those children need to finish — the pool would deadlock at
    // exactly the depth it was added to bound.
    const answer = await ctx.gate.run(() =>
      bound(ctx, `step "${id}"`).ask(plan, String(interpolate(step.ask, scope, `step "${id}"`) ?? "")),
    );
    output = answer.data ?? answer.text;
    deps.emit?.({
      operation: "invoke_agent", name: step.agent ?? "agent", step: id, at: t0, durationMs: Date.now() - t0,
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": step.agent ?? "agent",
        "gen_ai.usage.input_tokens": answer.usage.inputTokens,
        "gen_ai.usage.output_tokens": answer.usage.outputTokens,
        "gen_ai.usage.cache_read.input_tokens": answer.usage.cachedTokens,
      },
    });
  } else if (isUse(step)) {
    // A `use` step is the only side-effecting action. Exactly-once discipline: if a
    // prior attempt was interrupted mid-effect (an inflight entry for this step, no
    // output recorded), a resume cannot prove the effect did not already happen — so
    // it refuses to re-run rather than risk a double-execution. Otherwise: mark this
    // step inflight and persist BEFORE the effect, pass a derived idempotency key
    // downstream, and clear this step's entry once the effect returns. The map is
    // per-step because up to `concurrency` use steps run at once.
    if (run.inflight?.[id]) {
      throw new Error(
        `step "${id}" was interrupted mid-side-effect (idempotency ${run.inflight[id]!.key}); a resume cannot prove the effect did not already happen, so it will not re-run it. Resolve the effect and clear the inflight entry to proceed (recoverRun with retryInflight retries under the same key).`,
      );
    }
    const args = interpolate(step.with, scope, `step "${id}"`);
    const key = idemKey(run.id, id, args);
    (run.inflight ??= {})[id] = { key, at: Date.now() };
    await deps.store.save(run);
    const t0 = Date.now();
    output = await ctx.gate.run(() =>
      withTimeout(
        deps.callTool(step.use, args, {
          idempotencyKey: key,
          via: "workflow",
          run: run.id,
          step: id,
        }),
        ctx.limits.timeout,
        `step "${id}"`,
      ),
    );
    delete run.inflight![id];
    if (!Object.keys(run.inflight!).length) delete run.inflight;
    deps.emit?.({
      operation: "execute_tool", name: step.use, step: id, at: t0, durationMs: Date.now() - t0,
      attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": step.use },
    });
  } else if (isApprove(step)) {
    throw new Suspend(id, String(interpolate(step.approve, scope, `step "${id}"`) ?? ""), step.requires);
  } else if (isEach(step)) {
    output = await runEach(step, id, ctx, extra, scope);
  } else if (isWhen(step)) {
    const value = String(interpolate(step.when, scope, `step "${id}"`) ?? "");
    const branch = step.is[value] ?? step.otherwise;
    if (!branch) {
      run.events.push({ step: id, at: Date.now(), kind: "skipped", detail: `no case for "${value}"` });
      output = null;
    } else {
      output = await runList(branch, id, ctx, extra);
    }
  } else if (isRepeat(step)) {
    output = await runRepeat(step, id, ctx, extra);
  } else if (isPlan(step)) {
    output = await runPlan(step, id, ctx, extra, scope);
  } else {
    throw new Error(`step "${(step as Step).id}" has no recognised action`);
  }

  run.outputs[id] = output;
  run.events.push({ step: id, at: Date.now(), kind: "done" });
  await deps.store.save(run);
  return output;
}

/** Run a body once per item, up to `concurrency` at a time. */
async function runEach(
  step: EachStep,
  id: string,
  ctx: Context,
  extra: Record<string, unknown>,
  scope: Record<string, unknown>,
): Promise<unknown[]> {
  const list: unknown = interpolate(step.each, scope, `step "${id}"`);
  const items = Array.isArray(list) ? list : [];
  const capped = step.max ? items.slice(0, step.max) : items;
  const binding = step.as ?? "item";
  const width = Math.max(1, Math.min(step.concurrency ?? 1, ctx.limits.concurrency));
  const results: unknown[] = Array.from({ length: capped.length });

  let next = 0;
  const worker = async (): Promise<void> => {
    for (let at = next++; at < capped.length; at = next++) {
      results[at] = await runList(step.do, `${id}#${at}`, ctx, {
        ...extra,
        [binding]: capped[at],
        index: at,
      });
    }
  };

  await Promise.all(Array.from({ length: Math.min(width, capped.length) }, worker));
  return results;
}

/** Re-arm the same steps until the check holds, or until `max` attempts. */
async function runRepeat(
  step: RepeatStep,
  id: string,
  ctx: Context,
  extra: Record<string, unknown>,
): Promise<unknown> {
  let last: unknown;

  for (let attempt = 1; attempt <= step.max; attempt++) {
    // `{{prior.draft}}` is the same step one attempt ago, empty on the first.
    // A loop that cannot see what it did last time can only send the same
    // prompt again, and repeating a prompt is not the same as repairing.
    const prior = attempt > 1 ? localTo(ctx.run.outputs, `${id}@${attempt - 1}`) : {};
    last = await runList(step.repeat, `${id}@${attempt}`, ctx, { ...extra, attempt, prior });
    const verdict = await holds(
      step.until,
      scopeOf(ctx.run, { ...extra, attempt, last }, `${id}@${attempt}`),
      ctx,
      `the "until" check on step "${id}"`,
    );
    if (verdict.ok) return { attempts: attempt, passed: true, result: last };

    ctx.run.events.push({
      step: id,
      at: Date.now(),
      kind: "skipped",
      detail: `attempt ${attempt} did not pass${verdict.detail ? `: ${verdict.detail}` : ""}`,
    });
  }

  return { attempts: step.max, passed: false, result: last };
}

/**
 * Let a model lay out the rest of the work, then run it as a graph.
 *
 * The plan is produced once and kept on the run, so a resume executes the graph
 * that was actually agreed rather than asking again and getting something else.
 * A failure re-plans only the part that failed, and lands as a new version
 * beside the old one instead of overwriting it.
 */
async function runPlan(
  step: PlanStep,
  id: string,
  ctx: Context,
  extra: Record<string, unknown>,
  scope: Record<string, unknown>,
): Promise<unknown> {
  const { run, deps } = ctx;

  if (!deps.provision) {
    throw new Error(`step "${id}" asks for a plan, and this runner has no planner`);
  }
  if (ctx.depth >= ctx.limits.depth) {
    throw new Error(
      `step "${id}" would provision ${ctx.depth + 1} levels deep, past the limit of ${ctx.limits.depth}`,
    );
  }

  const brief = String(interpolate(step.plan, scope, `step "${id}"`) ?? "");
  const max = step.max ?? 8;
  const inner: Context = { ...ctx, depth: ctx.depth + 1 };

  const provision = async (because?: string): Promise<Step[]> => {
    // Held under the same permit and the same ceiling as any other completion.
    // Planning is the most expensive call in a plan-driven run and the first one
    // it makes, so an unbounded, unmetered planner is a run with no ceiling at
    // all until after it has already spent the most it will ever spend.
    const result = await ctx.gate.run(() =>
      withTimeout(
        deps.provision!({
          brief,
          from: step.from ?? [],
          tools: step.tools,
          max,
          depth: inner.depth,
          scope,
          because,
          harness: bound(inner, `the plan for step "${id}"`),
        }),
        ctx.limits.timeout,
        `the plan for step "${id}"`,
      ),
    );
    const steps = result.steps.slice(0, max);
    const version = (run.plans[id]?.length ?? 0) + 1;
    (run.plans[id] ??= []).push({ version, at: Date.now(), because, steps });
    run.events.push({
      step: id,
      at: Date.now(),
      kind: "planned",
      detail: `v${version}: ${steps.map((s) => s.id).join(", ") || "nothing to do"}`,
    });
    for (const note of result.notes ?? []) {
      run.events.push({ step: id, at: Date.now(), kind: "skipped", detail: note });
    }
    await deps.store.save(run);
    return steps;
  };

  // A plan's first version runs under the step's own id; a revision under
  // `id~version`, so a second attempt's outputs never collide with the first's.
  // The version is on the persisted PlanVersion, so a resume derives the SAME
  // prefix live execution used — replaying the latest plan under the bare id
  // would miss every journaled output, double-fire the effects it then re-runs,
  // and orphan any approval recorded under the versioned step path.
  const prefixed = (version: number): string => (version > 1 ? `${id}~${version}` : id);

  const recorded = run.plans[id]?.at(-1);
  const steps = recorded ? recorded.steps : await provision();
  if (!steps.length) return null;

  const at = prefixed(recorded?.version ?? 1);
  try {
    return await runList(steps, at, inner, extra);
  } catch (err) {
    if (err instanceof Suspend || step.revise === false) throw err;

    // Revision is scoped to this step and happens at a boundary, not after
    // every action: reconsidering the whole plan each time is what makes
    // model-driven orchestration expensive without making it better.
    const revised = await provision((err as Error).message);
    if (!revised.length) throw err;

    // The superseded attempt's steps can never be re-driven — a resume replays
    // only the latest version, under its own prefix — so an inflight marker left
    // by the failure that prompted this revision no longer guards anything.
    // Clear those markers, or a run that revised around a failed side effect
    // could never pass its next gate. The failure itself stays on the record,
    // in the revision's `because`.
    for (const marked of Object.keys(run.inflight ?? {})) {
      if (marked === at || marked.startsWith(`${at}.`)) delete run.inflight![marked];
    }
    if (run.inflight && !Object.keys(run.inflight).length) delete run.inflight;

    return runList(revised, prefixed(run.plans[id]!.at(-1)!.version), inner, extra);
  }
}

// ── The ready set ──────────────────────────────────────────────────────────

/**
 * Run a list of steps and return the last one's output.
 *
 * With no `after` anywhere, each step waits for the one before it and this is a
 * sequence. As soon as one step declares dependencies, every step without them
 * is ready at once and the list is a graph.
 */
async function runList(
  steps: Step[],
  prefix: string,
  ctx: Context,
  extra: Record<string, unknown>,
): Promise<unknown> {
  if (!steps.length) return undefined;

  const ids = new Set(steps.map((step) => step.id));
  const isGraph = steps.some((step) => step.after?.length);
  const needs = new Map<string, string[]>(
    steps.map((step, at) => [
      step.id,
      isGraph
        ? (step.after ?? []).filter((need) => ids.has(need))
        : at > 0
          ? [steps[at - 1]!.id]
          : [],
    ]),
  );

  const width = isGraph ? ctx.limits.concurrency : 1;
  const done = new Set<string>();
  const running = new Map<string, Promise<void>>();
  let suspended: Suspend | undefined;
  let failure: unknown;

  while (done.size < steps.length && !suspended && failure === undefined) {
    const ready = steps.filter(
      (step) =>
        !done.has(step.id) &&
        !running.has(step.id) &&
        needs.get(step.id)!.every((need) => done.has(need)),
    );

    for (const step of ready.slice(0, Math.max(0, width - running.size))) {
      const settled = runStep(step, prefix, ctx, extra).then(
        (): void => {
          done.add(step.id);
          return;
        },
        (err: unknown) => {
          if (err instanceof Suspend) suspended ??= err;
          else failure ??= err;
        },
      );
      running.set(
        step.id,
        settled.finally(() => running.delete(step.id)),
      );
    }

    if (!running.size) {
      // Nothing is ready and nothing is running, with steps still unfinished:
      // every remaining step is waiting on another remaining step. Breaking here
      // returned the run as though it had succeeded, with steps neither done nor
      // failed and a `result` read off a step that never ran — a silent wrong
      // answer, which is the worst thing a scheduler can hand back.
      const stuck = steps.filter((step) => !done.has(step.id));
      const blocked = stuck
        .map((step) => {
          const unmet = needs.get(step.id)!.filter((need) => !done.has(need));
          return `"${step.id}" waits for ${unmet.map((need) => `"${need}"`).join(", ")}`;
        })
        .join("; ");
      throw new Error(
        `${prefix ? `inside "${prefix}", ` : ""}${stuck.length} step${stuck.length === 1 ? "" : "s"} can never run: ${blocked}. ` +
          `Every one of them is waiting for another that is also waiting — an \`after\` cycle. ` +
          `Break it by removing one of those dependencies, or by reordering so each step only names steps that can finish before it.`,
      );
    }
    await Promise.race(running.values());
  }

  // Let work already in flight finish and record itself before unwinding, so a
  // pause never throws away a step that was about to succeed.
  await Promise.allSettled(running.values());
  if (suspended) {
    // A pause outranks a sibling's failure for control flow — the gate is still
    // worth asking — but the failure is part of what happened: record it so the
    // operator deciding at the gate is not deciding blind.
    if (failure !== undefined) {
      ctx.run.events.push({
        step: "-",
        at: Date.now(),
        kind: "failed",
        detail: `a sibling step failed while the run paused: ${(failure as Error)?.message ?? String(failure)}`,
      });
    }
    throw suspended;
  }
  if (failure !== undefined) throw failure;

  const last = steps[steps.length - 1]!;
  return ctx.run.outputs[prefix ? `${prefix}.${last.id}` : last.id];
}

// ── Driving a run ──────────────────────────────────────────────────────────

function contextFor(run: Run, deps: WorkflowDeps): Context {
  const limits = deps.limits ?? {};
  const concurrency = Math.max(1, limits.concurrency ?? DEFAULTS.concurrency);
  return {
    run,
    deps,
    limits: {
      depth: limits.depth ?? DEFAULTS.depth,
      concurrency,
      timeout: limits.timeout ?? DEFAULTS.timeout,
      budget: limits.budget,
    },
    depth: 0,
    // Made once, here, and carried down by every nested context: `{ ...ctx }`
    // shares this object, which is the point.
    gate: new Gate(concurrency),
  };
}

/**
 * Check what the workflow said had to be true of the result.
 *
 * Run after the steps and before the run reports success, because a run that
 * calls itself done and then adds that the outcome did not hold has already
 * told everything downstream the wrong thing.
 */
async function checkOutcome(run: Run, spec: WorkflowSpec, ctx: Context): Promise<void> {
  const declared = spec.outcome;
  if (!declared) return;

  const checks = Array.isArray(declared) ? declared : [declared];
  const scope = scopeOf(run, { result: run.result });
  const reasons: string[] = [];
  let held = true;

  for (const check of checks) {
    const verdict = await holds(check, scope, ctx, "the outcome check");
    if (!verdict.ok) held = false;
    reasons.push(verdict.ok ? "held" : (verdict.detail ?? "did not hold"));
  }

  run.outcome = { held, reasons };
  run.events.push({
    step: "-",
    at: Date.now(),
    kind: "judged",
    detail: held ? "the outcome held" : reasons.join("; ").slice(0, 500),
  });

  if (!held) {
    run.status = "failed";
    run.error = `the work finished but the outcome did not hold: ${reasons.join("; ")}`;
  }
}

/** Drive a run to completion, to an approval gate, or to failure. */
async function drive(run: Run, spec: WorkflowSpec, deps: WorkflowDeps): Promise<Run> {
  const ctx = contextFor(run, deps);
  run.status = "running";
  delete run.waitingFor;

  try {
    run.result = await runList(spec.steps, "", ctx, {});
    run.status = "done";
    await checkOutcome(run, spec, ctx);
  } catch (err) {
    if (err instanceof Suspend) {
      run.status = "waiting";
      run.waitingFor = { step: err.step, prompt: err.prompt, requires: err.requires };
      run.events.push({ step: err.step, at: Date.now(), kind: "waiting", detail: err.prompt });
    } else {
      run.status = "failed";
      // Redacted on the way onto the record, not on the way off it. A run file is
      // read by the dashboard, the API, the provenance graph and whatever an app
      // exports next; a credential that lands in it once has to be scrubbed from
      // every one of those, and it never is.
      run.error = safeMessage(err, `run ${run.id} failed`);
      run.events.push({ step: "-", at: Date.now(), kind: "failed", detail: run.error });
    }
  }

  await deps.store.save(run);
  return run;
}

/** Every `approve` step in a spec, however deeply nested, with what it demands. */
function gatesIn(steps: Step[], prefix = ""): { id: string; quorum: number }[] {
  const found: { id: string; quorum: number }[] = [];
  for (const step of steps) {
    const id = prefix ? `${prefix}.${step.id}` : step.id;
    if (isApprove(step)) found.push({ id, quorum: step.requires?.quorum ?? 1 });
    else if (isEach(step)) found.push(...gatesIn(step.do, id));
    else if (isRepeat(step)) found.push(...gatesIn(step.repeat, id));
    else if (isWhen(step)) {
      for (const branch of Object.values(step.is)) found.push(...gatesIn(branch, id));
      if (step.otherwise) found.push(...gatesIn(step.otherwise, id));
    }
  }
  return found;
}

/**
 * Refuse a two-person rule nobody can count, at the start rather than at the gate.
 *
 * A `quorum` above one is a promise that two DIFFERENT people had to agree. With
 * no verifier the only thing distinguishing them is the `approver` string each
 * request carried, which the same caller writes twice — so the rule is decorative
 * and the workflow's author has no way to find that out except by being attacked.
 *
 * It fails here, before any work is paid for, because the alternative is a run
 * that spends its way to the gate and only then discovers its governance was
 * never real. Checked again on resume, so a run started before a verifier was
 * unwired cannot be walked through the hole.
 */
export function checkGovernable(spec: WorkflowSpec, deps: WorkflowDeps): void {
  if (deps.verify) return;
  const ungovernable = gatesIn(spec.steps).filter((gate) => gate.quorum > 1);
  if (!ungovernable.length) return;

  const which = ungovernable
    .map((gate) => `"${gate.id}" (quorum ${gate.quorum})`)
    .join(", ");
  throw new Error(
    `workflow "${spec.name ?? "workflow"}" gates ${which} on more than one approver, and this runner has no \`verify\` ` +
      `to say who any of them were. \`approver\` is free text the caller chose, so one caller posting "alice" and then "bob" ` +
      `would clear it — the rule would look enforced and enforce nothing. ` +
      `Wire \`verify\` into the workflow's deps so a quorum counts identities a signature proved, or set the quorum to 1 and ` +
      `say plainly that one approval is what the gate takes.`,
  );
}

/**
 * Refuse a workflow that cannot be walked, before anything is spent on it.
 *
 * The loader has always been able to see these. It wrote them into
 * `project.warnings` and nothing on this path ever read them, so a workflow with
 * two steps sharing an id, or with `a` waiting on `b` waiting on `a`, started
 * anyway and came back `{"status":"done","outputs":{}}` — the framework
 * diagnosing a defect precisely and then reporting success over it, which is
 * worse than never having looked. The diagnosis is the same sentence either way
 * (`src/workflow/defects.ts` is the only place it is written), so what the
 * dashboard shows and what stops a run cannot drift apart.
 *
 * A throw rather than a failed run, and that is the rule everywhere here: a
 * `Run` is the record of work that was attempted, and nothing was attempted.
 * Manufacturing a run id, a store entry and a `failed` status for a spec that
 * never ran puts something in the run history that never happened. It is also
 * the same channel `startWorkflow("nope")` already used for an unknown workflow
 * — one class of mistake, one way of hearing about it. Anything discovered while
 * running fails the run instead, because by then something did happen.
 */
function checkRunnable(spec: WorkflowSpec, deps: WorkflowDeps): void {
  const defects = defectsIn(spec, { agents: deps.knownAgents });
  if (!defects.length) return;
  throw new Error(
    `this workflow cannot run as written:\n${defects.map((defect) => `  ${defect}`).join("\n")}\n\n` +
      `Fix it in workflows/. Started as it is, the run would report itself done having done nothing.`,
  );
}

/** Start a workflow. */
export async function startRun(
  spec: WorkflowSpec,
  input: Record<string, unknown>,
  deps: WorkflowDeps,
): Promise<Run> {
  checkRunnable(spec, deps);
  checkGovernable(spec, deps);
  const name = spec.name ?? "workflow";
  const now = Date.now();
  const run: Run = {
    id: newRunId(name),
    workflow: name,
    status: "running",
    input,
    outputs: {},
    plans: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    events: [],
    startedAt: now,
    updatedAt: now,
  };
  await deps.store.save(run);
  return drive(run, spec, deps);
}

/** Inflight markers for steps with no journaled output — evidence a side effect
 *  may have fired without being recorded. Any such entry makes the whole run
 *  dirty, whichever step a re-drive would reach next. */
function staleInflight(run: Run): string[] {
  return Object.keys(run.inflight ?? {}).filter((step) => !(step in run.outputs));
}

/** What one decision lands on the ledger as, once it has been checked. */
interface Ledgered {
  signature?: string;
  /** Set when no signer was wired. An absent signature said out loud. */
  unsigned?: boolean;
  /** The identity the signature PROVED. The only thing a quorum may count. */
  subject?: string;
  at: number;
}

/**
 * Turn a decision into a ledger entry, refusing anything that cannot be stood behind.
 *
 * Three cases, and the middle one is the fix. A presented signature is VERIFIED
 * here, on the way in — a signature that is only ever written and never read is
 * a log line wearing a costume, and this is the one place a forged one can still
 * be turned away. A signer produces one. Neither, and the entry says so.
 */
async function ledger(
  run: Run,
  step: string,
  decision: ApprovalDecision,
  deps: WorkflowDeps,
): Promise<Ledgered> {
  const at = decision.at ?? Date.now();
  const claim: ApprovalClaim = {
    runId: run.id,
    step,
    approver: decision.approver,
    approved: decision.approved,
    at,
  };

  const presented = decision.signature?.trim();
  if (presented) {
    if (!deps.verify) {
      throw new Error(
        `the approval of step "${step}" carries a signature and this runner has no \`verify\` to check it. ` +
          `Recording it would put a claim in the audit trail that nothing ever tested — which is exactly what a forged one counts on. ` +
          `Wire \`verify\` into the workflow's deps, or send the decision without a signature and it will be recorded as unsigned.`,
      );
    }
    const subject = await deps.verify(claim, presented);
    if (!subject) {
      throw new Error(
        `the signature on the approval of step "${step}" does not verify against the claim it must cover: ` +
          `{ runId: ${JSON.stringify(run.id)}, step: ${JSON.stringify(step)}, approver: ${JSON.stringify(decision.approver ?? null)}, ` +
          `approved: ${decision.approved}, at: ${at} }. ` +
          `Sign that whole object, and send back the same \`at\` you signed — a re-stamped timestamp is a different claim.`,
      );
    }
    return { signature: presented, subject, at };
  }

  if (deps.sign) {
    const signature = await deps.sign(claim);
    // The subject comes from `verify` and from nowhere else. A signer says a
    // claim was signed; it does not say whose identity was checked before it was
    // signed, and assuming that was `approver` is how the free-text field creeps
    // back into the count it was removed from.
    return { signature, subject: deps.verify ? await deps.verify(claim, signature) : undefined, at };
  }

  return { unsigned: true, at };
}

/**
 * Answer a waiting run's approval and continue. A rejection records the
 * decision and ends the run rather than running the remaining steps.
 */
/**
 * Start a NEW run from a point in an old one — time travel, and the thing checkpointing
 * exists for that resuming alone does not give you.
 *
 * `recoverRun` continues an interrupted run: same id, same history, forward only.
 * That answers "the process died". It does not answer the question people actually have
 * about a long workflow, which is "step four went badly — what if it had gone otherwise",
 * and re-running from the top to find out costs every step before it again.
 *
 * A fork copies the journal up to and including `after`, and nothing past it. The original
 * is untouched: this is a branch, not an edit, so the run that already happened stays
 * exactly as it happened and remains readable beside the one that might have.
 *
 * `patch` is the other half, and it is what makes a fork worth having. Editing an earlier
 * step's output before continuing is how a person answers "what if the classifier had said
 * refund" without pretending the classifier said it. Every patched value is recorded as an
 * event naming who changed it, because a run whose outputs were edited and whose record
 * does not say so is a run nobody can trust afterwards.
 */
export async function forkRun(
  runId: string,
  spec: WorkflowSpec,
  deps: WorkflowDeps,
  options: { after?: string; patch?: Record<string, unknown>; by?: string } = {},
): Promise<Run> {
  checkRunnable(spec, deps);
  const original = await deps.store.load(runId);
  if (!original) throw new Error(`no such run: ${runId}`);

  const order = original.events.filter((event) => event.kind === "done").map((event) => event.step);
  const cut = options.after ? order.indexOf(options.after) : order.length - 1;
  if (options.after && cut < 0) {
    throw new Error(
      `run ${runId} has no completed step "${options.after}" to fork after; it completed: ${order.join(", ") || "nothing"}`,
    );
  }

  // Everything up to the cut survives. Everything after it is discarded, which is the
  // whole point — those are the steps being asked about.
  const keep = new Set(order.slice(0, cut + 1));
  const outputs: Record<string, unknown> = {};
  for (const [step, value] of Object.entries(original.outputs)) {
    if (keep.has(step)) outputs[step] = value;
  }

  const at = Date.now();
  const events: RunEvent[] = original.events.filter(
    (event) => keep.has(event.step) || event.step === "",
  );

  for (const [step, value] of Object.entries(options.patch ?? {})) {
    if (!keep.has(step)) {
      throw new Error(
        `cannot patch "${step}": it is not among the steps carried into this fork (${[...keep].join(", ") || "none"})`,
      );
    }
    outputs[step] = value;
    // Written down, always. An edited output that leaves no trace turns the record from
    // evidence into a story.
    events.push({ step, at, kind: "patched", detail: `edited by ${options.by ?? "an operator"}` });
  }

  const fork: Run = {
    ...original,
    id: `${original.id}-fork-${at.toString(36)}`,
    status: "running",
    outputs,
    events,
    inflight: undefined,
    waitingFor: undefined,
    error: undefined,
    result: undefined,
    outcome: undefined,
    startedAt: at,
    updatedAt: at,
    forkedFrom: { run: original.id, after: order[cut] },
  };

  await deps.store.save(fork);
  // Driven exactly as a recovered run is: the journal decides what is already done, so
  // the carried steps are not re-executed and the discarded ones are.
  return drive(fork, spec, deps);
}

export async function resumeRun(
  runId: string,
  decision: ApprovalDecision,
  spec: WorkflowSpec,
  deps: WorkflowDeps,
): Promise<Run> {
  checkRunnable(spec, deps);
  checkGovernable(spec, deps);
  const run = await deps.store.load(runId);
  if (!run) throw new Error(`no such run: ${runId}`);
  if (run.status !== "waiting" || !run.waitingFor) {
    throw new Error(`run ${runId} is ${run.status}, not waiting for approval`);
  }

  // A sibling `use` step interrupted mid-effect leaves its marker even when a
  // pause won the unwind. Any stale marker means the run is dirty: re-driving it
  // could double-fire the unresolved effect, whatever step comes next.
  const stale = staleInflight(run);
  if (stale.length) {
    throw new Error(
      `run ${runId} has an unresolved side effect at ${stale.map((s) => `"${s}"`).join(", ")}; ` +
        `a resume cannot prove the effect did not already happen. Resolve it, or recover with recoverRun({ retryInflight: true }) to retry under the same idempotency key.`,
    );
  }

  const step = run.waitingFor.step;
  const quorum = run.waitingFor.requires?.quorum ?? 1;

  // Where the decision came in on. An agent that holds any HTTP tool can read its
  // own run id from the run listing and post its own approval, so an app that has
  // named the channels a gate answers on is saying which surfaces the run itself
  // cannot reach — and this is where that is enforced. Recorded either way, so a
  // self-approval on an unrestricted app is at least legible afterwards.
  if (deps.approvalChannels && !deps.approvalChannels.includes(decision.channel ?? "")) {
    throw new Error(
      `step "${step}" only answers to approvals arriving on ${deps.approvalChannels.map((c) => `"${c}"`).join(" or ")}, ` +
        `and this one arrived on ${decision.channel ? `"${decision.channel}"` : "no named channel"}. ` +
        `The gate is deliberately somewhere the run's own agents cannot reach: approve it from one of those channels, ` +
        `or widen \`approvalChannels\` if this one is genuinely out of the run's reach.`,
    );
  }

  // A rejection is a single veto: it ends the run. It is recorded in the same
  // ledger as an approval before anything else happens — a veto is as much a
  // governance act as a signature, and an audit trail that cannot say who
  // stopped a run is not an audit trail.
  if (!decision.approved) {
    const vetoed = await ledger(run, step, decision, deps);
    (run.approvals ??= []).push({
      step,
      approver: decision.approver,
      ...vetoed,
      channel: decision.channel,
      approved: false,
    });
    run.outputs[step] = decision;
    run.status = "done";
    run.result = { approved: false, note: decision.note };
    delete run.waitingFor;
    run.events.push({
      step,
      at: Date.now(),
      kind: "done",
      detail: decision.approver ? `rejected by ${decision.approver}` : "rejected",
    });
    await deps.store.save(run);
    return run;
  }

  // A quorum is a count of DISTINCT people. An approval that names nobody can
  // neither be counted distinct nor answered for afterwards, so a gate that
  // requires more than one signature refuses it outright — N anonymous nods
  // must never satisfy a two-person rule.
  if (quorum > 1 && !decision.approver) {
    throw new Error(
      `step "${step}" requires a quorum of ${quorum}: an approval carrying no approver identity cannot count toward it`,
    );
  }

  const entry = await ledger(run, step, decision, deps);

  // Above a quorum of one, only a PROVED identity counts. Names are what the
  // caller typed; two of them from one socket is one person twice over, which is
  // the whole failure a two-person rule exists to prevent.
  if (quorum > 1 && !entry.subject) {
    throw new Error(
      `step "${step}" requires ${quorum} distinct approvers, so an approval counts only once its signature has proved WHO made it. ` +
        `This one carries ${entry.unsigned ? "no signature at all" : "a signature that proved no subject"}. ` +
        `Approve with a signature over { runId, step, approver, approved, at } that this app's \`verify\` accepts.`,
    );
  }

  // Distinct by the strongest identity available: the verified subject where
  // there is one, the claimed name only where a quorum of one made proof
  // unnecessary in the first place.
  run.approvals ??= [];
  const who = entry.subject ?? decision.approver;
  if (
    who &&
    run.approvals.some(
      (a) =>
        a.step === step &&
        a.approved !== false &&
        (entry.subject ? a.subject === entry.subject : a.approver === decision.approver),
    )
  ) {
    throw new Error(`${who} already approved step "${step}" — a quorum needs distinct approvers`);
  }
  run.approvals.push({
    step,
    approver: decision.approver,
    ...entry,
    channel: decision.channel,
    approved: true,
  });

  const forStep = run.approvals.filter((a) => a.step === step && a.approved !== false);
  const got =
    quorum > 1
      ? new Set(forStep.map((a) => a.subject).filter(Boolean)).size
      : forStep.length;
  if (got < quorum) {
    // Short of quorum: stay waiting for a distinct co-approver (two-person rule).
    run.events.push({ step, at: Date.now(), kind: "waiting", detail: `approval ${got}/${quorum}` });
    await deps.store.save(run);
    return run;
  }

  run.outputs[step] = decision;
  return drive(run, spec, deps);
}

/**
 * Re-drive a run whose driving process died.
 *
 * `resumeRun` answers a gate and rightly refuses a run still marked "running" —
 * but a crash leaves exactly that status behind with nobody driving, and the
 * journal is the only way back. Calling this asserts the driver is dead: the
 * store records state, not processes, so that assertion is the caller's to make.
 * Recovery replays journaled outputs (completed steps are never re-executed) and
 * carries on from the first step with no output.
 *
 * An inflight marker for a step with no journaled output means a side effect may
 * have fired without being recorded. Recovery refuses by default; passing
 * `retryInflight: true` re-executes those steps, presenting the SAME derived
 * idempotency key as the interrupted attempt — exactly-once iff the downstream
 * dedupes on it, which is the caller's judgment to make about their tools.
 */
export async function recoverRun(
  runId: string,
  spec: WorkflowSpec,
  deps: WorkflowDeps,
  opts: { retryInflight?: boolean } = {},
): Promise<Run> {
  checkRunnable(spec, deps);
  checkGovernable(spec, deps);
  const run = await deps.store.load(runId);
  if (!run) throw new Error(`no such run: ${runId}`);
  if (run.status !== "running") {
    throw new Error(
      `run ${runId} is ${run.status}, not a crashed "running" run — a waiting run resumes with resumeRun`,
    );
  }

  const stale = staleInflight(run);
  if (stale.length && !opts.retryInflight) {
    throw new Error(
      `run ${runId} was interrupted mid-side-effect at ${stale.map((s) => `"${s}"`).join(", ")}; ` +
        `recovery cannot prove the effect did not already happen. Pass { retryInflight: true } to re-run under the same idempotency key (safe iff the tool dedupes on it).`,
    );
  }

  // Either the retry was consented to, or every marker belongs to a step whose
  // output landed — in both cases the markers have served their purpose.
  delete run.inflight;
  return drive(run, spec, deps);
}
