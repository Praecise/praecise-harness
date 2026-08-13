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
import type { Harness } from "../harness/types.js";
import { isLatent } from "../transport.js";
import { interpolate } from "./interpolate.js";
import { judge } from "./judge.js";
import type { Run, RunStore } from "./store.js";
import { runCommand } from "./verify.js";

const DEFAULTS = { depth: 3, concurrency: 4, timeout: 600 } as const;

/** What a `plan` step asks for, and what it must be given back. */
export interface ProvisionRequest {
  /** The brief, already interpolated. */
  brief: string;
  /** Agents the plan may draw on. Empty ⇒ all of them. */
  from: string[];
  /** Non-escalation ceiling: tools the provisioned steps may call. Absent ⇒ all. */
  tools?: string[];
  /** Ceiling on how many steps may come back. */
  max: number;
  /** How far down the provisioning tree this is. */
  depth: number;
  /** What the run knows so far, for the planner to refer to. */
  scope: Record<string, unknown>;
  /** Set when re-planning after a failure, with the reason. */
  because?: string;
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

export interface WorkflowDeps {
  harness: Harness;
  /** Plan for an `ask` step; no agent means the workflow's general-purpose agent. */
  planFor(agent: string | undefined, quality: Quality | undefined): Promise<AgentPlan>;
  /** Invoke `service.tool`, or a local function, with the given arguments. `opts`
   *  carries a derived idempotency key so a compliant tool can dedupe a retried side
   *  effect (exactly-once when the downstream honours it). */
  callTool(ref: string, args: unknown, opts?: { idempotencyKey?: string }): Promise<unknown>;
  store: RunStore;
  /** Ceilings, inherited by everything the run provisions. */
  limits?: Limits;
  /** Turns a `plan` step's brief into steps. Absent ⇒ `plan` steps report why. */
  provision?(request: ProvisionRequest): Promise<ProvisionResult>;
  /** Optional OTel GenAI span sink — receives a standard-shaped span per step. */
  emit?(span: GenAiSpan): void;
}

/** Thrown to unwind out of a nested step when the run hits an approval gate. */
class Suspend {
  constructor(
    readonly step: string,
    readonly prompt: string,
    readonly requires?: { quorum?: number },
  ) {}
}

/** A non-repudiation signature over an approval — a stub for a real signature/OIDC
 *  token, same shape (binds run + step + approver). */
function approvalStamp(runId: string, step: string, approver?: string): string {
  const s = `${runId}:${step}:${approver ?? ""}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `sig-stub:${(h >>> 0).toString(16)}`;
}

/** Everything the scheduler carries down that is not the step itself. */
interface Context {
  run: Run;
  deps: WorkflowDeps;
  limits: { depth: number; concurrency: number; timeout: number; budget?: number };
  depth: number;
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

/** Fail a step that outruns its ceiling rather than letting it hang the run. */
function withTimeout<T>(work: Promise<T>, seconds: number, what: string): Promise<T> {
  if (!(seconds > 0)) return work;
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} took longer than ${seconds}s`)),
      seconds * 1000,
    );
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer)) as Promise<T>;
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
): Promise<{ ok: boolean; detail?: string }> {
  if ("passes" in check) {
    const command = String(interpolate(check.passes, scope) ?? "");
    const { ok, output } = await runCommand(command, {
      cwd: check.in,
      timeout: ctx.limits.timeout * 1000,
    });
    return { ok, detail: ok ? undefined : output.slice(0, 500) };
  }

  if ("equals" in check) {
    const actual = interpolate(check.equals, scope);
    return {
      ok: sameValue(actual, check.to),
      detail: `expected ${JSON.stringify(check.to)}, got ${JSON.stringify(actual)}`,
    };
  }

  const plan = await ctx.deps.planFor(undefined, "balanced");
  const verdict = await judge(
    ctx.deps.harness,
    plan,
    String(interpolate(check.asks, scope) ?? ""),
    materialOf(scope),
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

function spend(ctx: Context, id: string, usage: { inputTokens: number; outputTokens: number }): void {
  ctx.run.usage.inputTokens += usage.inputTokens;
  ctx.run.usage.outputTokens += usage.outputTokens;

  const budget = ctx.limits.budget;
  if (!budget) return;
  const total = ctx.run.usage.inputTokens + ctx.run.usage.outputTokens;
  if (total > budget) {
    throw new Error(
      `run passed its budget of ${budget.toLocaleString()} tokens at step "${id}" ` +
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
    const answer = await withTimeout(
      deps.harness.ask(plan, String(interpolate(step.ask, scope) ?? "")),
      ctx.limits.timeout,
      `step "${id}"`,
    );
    spend(ctx, id, answer.usage);
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
    const args = interpolate(step.with, scope);
    const key = idemKey(run.id, id, args);
    (run.inflight ??= {})[id] = { key, at: Date.now() };
    await deps.store.save(run);
    const t0 = Date.now();
    output = await withTimeout(
      deps.callTool(step.use, args, { idempotencyKey: key }),
      ctx.limits.timeout,
      `step "${id}"`,
    );
    delete run.inflight![id];
    if (!Object.keys(run.inflight!).length) delete run.inflight;
    deps.emit?.({
      operation: "execute_tool", name: step.use, step: id, at: t0, durationMs: Date.now() - t0,
      attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": step.use },
    });
  } else if (isApprove(step)) {
    throw new Suspend(id, String(interpolate(step.approve, scope) ?? ""), step.requires);
  } else if (isEach(step)) {
    output = await runEach(step, id, ctx, extra, scope);
  } else if (isWhen(step)) {
    const value = String(interpolate(step.when, scope) ?? "");
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
  const list: unknown = interpolate(step.each, scope);
  const items = Array.isArray(list) ? list : [];
  const capped = step.max ? items.slice(0, step.max) : items;
  const binding = step.as ?? "item";
  const width = Math.max(1, Math.min(step.concurrency ?? 1, ctx.limits.concurrency));
  const results: unknown[] = new Array(capped.length);

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
    const verdict = await holds(step.until, scopeOf(ctx.run, { ...extra, attempt, last }, `${id}@${attempt}`), ctx);
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

  const brief = String(interpolate(step.plan, scope) ?? "");
  const max = step.max ?? 8;
  const inner: Context = { ...ctx, depth: ctx.depth + 1 };

  const provision = async (because?: string): Promise<Step[]> => {
    const result = await deps.provision!({
      brief,
      from: step.from ?? [],
      tools: step.tools,
      max,
      depth: inner.depth,
      scope,
      because,
    });
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
        () => {
          done.add(step.id);
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

    if (!running.size) break; // nothing runnable — a cycle the loader warned about
    await Promise.race(running.values());
  }

  // Let work already in flight finish and record itself before unwinding, so a
  // pause never throws away a step that was about to succeed.
  await Promise.allSettled([...running.values()]);
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
  return {
    run,
    deps,
    limits: {
      depth: limits.depth ?? DEFAULTS.depth,
      concurrency: Math.max(1, limits.concurrency ?? DEFAULTS.concurrency),
      timeout: limits.timeout ?? DEFAULTS.timeout,
      budget: limits.budget,
    },
    depth: 0,
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
    const verdict = await holds(check, scope, ctx);
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
      run.error = (err as Error).message;
      run.events.push({ step: "-", at: Date.now(), kind: "failed", detail: run.error });
    }
  }

  await deps.store.save(run);
  return run;
}

/** Start a workflow. */
export async function startRun(
  spec: WorkflowSpec,
  input: Record<string, unknown>,
  deps: WorkflowDeps,
): Promise<Run> {
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

/**
 * Answer a waiting run's approval and continue. A rejection records the
 * decision and ends the run rather than running the remaining steps.
 */
export async function resumeRun(
  runId: string,
  decision: { approved: boolean; note?: string; approver?: string; signature?: string },
  spec: WorkflowSpec,
  deps: WorkflowDeps,
): Promise<Run> {
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

  // A rejection is a single veto: it ends the run. It is recorded in the same
  // ledger as an approval before anything else happens — a veto is as much a
  // governance act as a signature, and an audit trail that cannot say who
  // stopped a run is not an audit trail.
  if (!decision.approved) {
    (run.approvals ??= []).push({
      step,
      approver: decision.approver,
      signature: decision.signature ?? approvalStamp(run.id, step, decision.approver),
      at: Date.now(),
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

  // Record a non-repudiable, DISTINCT approval (a quorum needs distinct approvers).
  run.approvals ??= [];
  if (
    decision.approver &&
    run.approvals.some((a) => a.step === step && a.approver === decision.approver && a.approved !== false)
  ) {
    throw new Error(`${decision.approver} already approved step "${step}" — a quorum needs distinct approvers`);
  }
  run.approvals.push({
    step,
    approver: decision.approver,
    signature: decision.signature ?? approvalStamp(run.id, step, decision.approver),
    at: Date.now(),
    approved: true,
  });

  const got = run.approvals.filter((a) => a.step === step && a.approved !== false).length;
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
