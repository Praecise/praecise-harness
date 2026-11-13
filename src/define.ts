import type { CodeModeSpec } from "./harness/codemode.js";
import type { SelfDeclaration } from "./harness/selves.js";
import type { Answer, AskCaller, Message, NativeTool } from "./harness/types.js";
import type { StandardOutput, StandardSchemaV1 } from "./schema.js";
/**
 * The authoring surface. Everything a developer writes goes through one of the
 * helpers here, and none of them mention models, routing, tiers, gates, or
 * retrieval — those are derived (see src/compile). If a runtime concept appears
 * in this file, the abstraction has leaked.
 */

/**
 * How much the answer is worth. This is the ONLY dial on cost/capability;
 * concrete models and escalation thresholds are derived from it and from
 * whichever provider credentials happen to be present.
 */
export type Quality = "fast" | "balanced" | "best";

/**
 * The `Quality` union as a value, cheapest first.
 *
 * Frozen because it is published. `readonly` is a compiler fiction that erases at
 * build time, so without this a consumer of the package can `push` onto the
 * framework's own enumeration and every later reader — the dashboard's quality
 * picker, the router's ladder, the model planner — sees the mutation. Freezing
 * turns that from a working mutation into a silent no-op, or a TypeError under
 * strict mode. A consumer who wants a mutable ladder takes a copy.
 */
export const QUALITIES: readonly Quality[] = Object.freeze(["fast", "balanced", "best"] as const);

/**
 * A structured result, declared one of three ways.
 *
 * Fields and plain-English hints — `{ label: "one of: refund, shipping" }` — which
 * constrain the structure and leave each value as text. A JSON Schema object, for typed
 * data: numbers, lists, nested objects, a fixed set of words. Or a Standard Schema v1
 * validator, which is what the schema of most validation libraries is, and which also
 * types `answer.data`.
 *
 * A JSON Schema or a Standard Schema is sent to the endpoint for constrained decoding
 * where the endpoint has it, and the answer is checked against it afterwards either
 * way. An answer that fails is a failed answer: the same model is asked again with more
 * room, then a stronger one, and if the strongest fails too the request ends with a
 * `ShapeError` carrying what was wrong. Fields and hints are not checked beyond being
 * JSON, as before. See `src/schema.ts` for which JSON Schema keywords are checked.
 */
export type Returns = Record<string, string> | Record<string, unknown> | StandardSchemaV1;

/** What `answer.data` is for a declared `returns`: the schema's output where it is a Standard Schema, else unknown. */
export type DataOf<Declared> = Declared extends StandardSchemaV1 ? StandardOutput<Declared> : unknown;

/**
 * Who may reach this once the app is published.
 *
 * `"internal"` is the one worth explaining: the thing still exists and other
 * agents in the app still use it, it simply never appears outside. Marking the
 * parts of an app that were never meant for strangers is also what keeps the
 * published surface small, and a small surface is what stops a caller acting
 * when it should have declined.
 */
export type Access = "open" | "gated" | "internal";

/**
 * What calling this does to the world, so a caller can weigh it before acting
 * rather than after. `"read"` changes nothing, `"write"` changes something and
 * calling it twice is the same as calling it once, `"destructive"` is neither.
 */
export type Effect = "read" | "write" | "destructive";

/** What every published thing declares about itself, whatever kind it is. */
export interface Published {
  /** Who may reach it. Default `"open"`. */
  access?: Access;
  /** What calling it does. Default `"write"` — the cautious reading. */
  effect?: Effect;
  /**
   * Which group it belongs to, so a caller can take one part of the app rather
   * than all of it. Defaults to the folder it was found in.
   */
  group?: string;
}

// ── Agents ─────────────────────────────────────────────────────────────────

export interface AgentSpec<Declared extends Returns = Returns> extends Published {
  readonly kind: "agent";
  /** Defaults to the filename (`agents/support.ts` ⇒ `support`). */
  name?: string;
  /** One sentence: what this agent is for. Becomes its instructions. */
  role: string;
  /** Shown in the dashboard and advertised over MCP. */
  description?: string;
  /**
   * Files, globs, or inline text this agent should know. Paths resolve from the
   * project root; `memory/**` is included for every agent automatically, so
   * this is for narrowing or for pulling in something outside that folder.
   */
  knows?: string[];
  /**
   * Which authored skills (`skills/<name>/SKILL.md`) this agent may use, by name.
   * Left out, it has every skill in the folder; `false` or an empty list is none.
   * Only names and descriptions go into its instructions — a skill's body is read
   * when the agent decides the skill applies.
   */
  skills?: string[] | false;
  /** What it may act through — a `functions/` or a `tools/` entry, by filename. */
  tools?: string[];
  /**
   * Code mode: instead of one tool per operation, the agent gets a single `code`
   * tool and writes a program against its services as a typed API, run in a
   * Praecise Silo with the credentials kept outside it. Worth it once an agent
   * has more than a handful of tools or chains calls; `true` takes the defaults.
   * Services launched as local programs stay ordinary tools.
   */
  code?: boolean | CodeModeSpec;
  /** Defaults to the project's quality, else "balanced". */
  quality?: Quality;
  /**
   * How many times this agent may go to its tools before it must answer. Default 16.
   *
   * A ceiling on one request, not a target. Long work stays inside the room it has
   * because old results are cleared and, past that, summarised — so this is a bound on
   * how long an agent may keep going, not on how much it can hold.
   */
  turns?: number;
  /**
   * Let this agent ask the strongest model on its ladder for advice while a cheaper one
   * does the work. Off by default; needs a ladder of more than one model to mean anything.
   */
  advisor?: boolean;
  /**
   * Let this agent start the agents it names in `tools` in the background: the other
   * agent works while this one carries on, and this one may check on it, tell it
   * something more, cancel it, and collect its answer. Off by default, and it means
   * nothing for an agent that names no other agent.
   */
  background?: boolean;
  /** Hard constraints. Enforced as instructions, and shown in the dashboard. */
  rules?: string[];
  /**
   * Remember across conversations. Off unless asked for.
   *
   * Carrying the whole conversation beats recalling a summary of it on every
   * measure except cost, so memory is worth turning on when a thread runs long
   * enough that replaying it stops being cheap — not by default, and not to
   * make an agent "smarter".
   */
  memory?: boolean | MemorySpec;
  /** Ask for a structured result instead of prose. See `Returns` for the three ways to say what. */
  returns?: Declared;
  /**
   * A check of the app's own on the structured result, after it has passed the shape.
   *
   * Say nothing to accept it, or answer with a sentence to refuse it: totals that do
   * not add up, an id that does not exist. A refused answer is treated exactly as one
   * outside the shape is — asked for again, deeper and then from a stronger model, and
   * an error after the strongest. Declaring this holds the answer to that even where
   * `returns` is only fields and hints. Means nothing without `returns`.
   */
  read?(data: DataOf<Declared>): string | undefined | void | Promise<string | undefined | void>;
  /** Few-shot examples. */
  examples?: { input: string; output: string }[];
  /** First message shown in the chat UI. */
  greeting?: string;
  /**
   * The self this agent is: an identity and a memory that persist across every
   * request and every way it is reached. Declared here, the harness reads the
   * self's context before each request and records the work after it, through
   * the app's self provider (`selves` in praecise.config.ts). A handle with
   * `{person}` is a self per person, filled from the caller.
   */
  self?: SelfDeclaration;
}

/**
 * How an agent remembers.
 *
 * `write: "append"` keeps each observation and rebuilds what it knows by
 * reading them back, so a bad entry stays one bad entry. `"replace"` lets the
 * model rewrite its own summary, which reads better and drifts badly — once a
 * mistake is folded into the summary the original is gone and every later
 * rewrite inherits it. Append unless something genuinely needs the other.
 */
export interface MemorySpec {
  /** A `stores/` name. Defaults to files under the state directory. */
  store?: string;
  write?: "append" | "replace";
  /** How many past entries may be recalled into context. Default 3. */
  recall?: number;
}

export type AgentInput<Declared extends Returns = Returns> = Omit<AgentSpec<Declared>, "kind">;

/**
 * Declare an agent. `export default agent({ ... })` from a file in `agents/`.
 *
 * What comes back remembers the type of `returns`, so asking with the agent itself in
 * place of its name — `app.ask(triage, "…")` — gives an answer whose `data` is typed
 * where `returns` is a Standard Schema.
 */
export function agent<Declared extends Returns = Returns>(spec: AgentInput<Declared>): AgentSpec<Declared> {
  return { ...spec, kind: "agent" };
}

// ── Workflows ──────────────────────────────────────────────────────────────

/**
 * Any `{{name}}` in a string is replaced before the step runs. It can reference
 * a workflow input, an earlier step's id, or a field inside one
 * (`{{research.angles}}`). A string that is *only* a reference keeps its type,
 * so `with: "{{draft}}"` passes an object through intact.
 */
export type Ref = string;

/**
 * Every step carries an id and may declare what it waits for.
 *
 * `after` is the whole difference between a list and a graph. With no `after`
 * anywhere, steps run in order and the run is a plain sequence. The moment one
 * step names its dependencies, the runner schedules from a ready set instead
 * and independent steps go in parallel. There is one scheduler either way — a
 * sequence is just a graph whose ready set never holds more than one node.
 */
interface StepBase {
  id: string;
  /** Step ids that must finish first. Declaring this turns the run into a graph. */
  after?: string[];
}

/** Delegate to an agent — the default kind of step. */
export interface AskStep extends StepBase {
  ask: Ref;
  /** Named agent to use. Omitted ⇒ a general-purpose agent for this workflow. */
  agent?: string;
  quality?: Quality;
  returns?: Returns;
}

/** Call a local function by name, or a service tool as `service.tool`. */
export interface UseStep extends StepBase {
  use: string;
  with?: unknown;
}

/** Pause until a human approves. The run is persisted and survives a restart. */
export interface ApproveStep extends StepBase {
  approve: Ref;
  /**
   * Governance for the human gate.
   *
   * `quorum` above 1 is the two-person rule, and praecise will only run it when the
   * app has wired a `verify` into the workflow's deps — it counts identities a
   * signature proved, never the `approver` string a caller typed, because two names
   * from one caller are one person. A workflow that asks for a quorum without a
   * verifier is refused at the start rather than cleared by whoever gets there first.
   *
   * With a signer and a verifier wired, what praecise records is non-repudiable:
   * who approved, over what claim, checked before it was stored. Without them it
   * records an ATTRIBUTED decision — a name and a timestamp, marked `unsigned`.
   * Whether an approver is authorized to approve remains the app's to decide.
   */
  requires?: { quorum?: number };
}

/**
 * Pause until an event arrives from outside. The run is persisted, like one at an
 * approval, and the event that matches continues it — once.
 *
 * `wait` is the CloudEvent `type` awaited, written out and not interpolated, so
 * what an app waits for can be read off its workflows. `source` and `subject`
 * narrow it and are interpolated, which is how a run waits for ITS event and not
 * the next one of that type: `subject: "{{order.id}}"`.
 *
 * The step's output is the event: `{ type, source, id, subject, time, data,
 * timedOut: false }`. An event that arrives while no run is waiting for it is
 * not kept; this is a wait, not a queue.
 */
export interface WaitStep extends StepBase {
  wait: string;
  /** Only an event from this `source`. */
  source?: Ref;
  /** Only an event about this `subject`. */
  subject?: Ref;
  /** Seconds to wait. Absent ⇒ for as long as it takes. */
  timeout?: number;
  /**
   * What running out of time does. `"fail"` (the default) fails the run and says
   * what it waited for. `"continue"` carries on with `{ timedOut: true }` as the
   * step's output, for a workflow that has something to do about silence.
   */
  onTimeout?: "fail" | "continue";
}

/** Run `do` once per item of a list. */
export interface EachStep extends StepBase {
  each: Ref;
  /** Binding name for the current item. Default "item". */
  as?: string;
  do: Step[];
  /** Cap on iterations, and on how many run at once. */
  max?: number;
  concurrency?: number;
}

/** Branch on a value. */
export interface WhenStep extends StepBase {
  when: Ref;
  is: Record<string, Step[]>;
  otherwise?: Step[];
}

/**
 * Something that has to hold before a run may continue.
 *
 * Ordered by how much they can be trusted. `passes` is checked by running
 * something, so the model cannot talk its way past it. `asks` is a model's
 * opinion, which is the weakest signal available and is unreliable when it
 * judges work it produced — prefer it only where nothing verifiable exists.
 */
export type Check =
  | { passes: string; in?: string }
  | { equals: Ref; to: unknown }
  | { asks: Ref };

/** Repeat until a check holds. `max` is required — an unbounded loop is a bug. */
export interface RepeatStep extends StepBase {
  repeat: Step[];
  until: Check;
  max: number;
}

/**
 * Let a model lay out the remaining work, then run it as a graph.
 *
 * The plan is produced once and executed structurally, which is what keeps it
 * affordable: deciding what to do next on every step is itself a model call.
 * `from` is the palette of declared agents the plan may use, and `max` bounds
 * how much it may invent. Revision happens at batch boundaries, scoped to the
 * part that failed, and is recorded as a new plan version rather than a silent
 * overwrite.
 */
export interface PlanStep extends StepBase {
  plan: Ref;
  /** Declared agents this plan may draw on. Omitted ⇒ all of them. */
  from?: string[];
  /**
   * The tools the provisioned steps may call.
   *
   * Least privilege, and a non-escalation bound: a plan builds only from what it
   * is granted here and can never widen its own authority. **Omitted ⇒ none.**
   * Saying nothing about tools cannot be what hands a model-authored graph every
   * tool the app has, `effect: "destructive"` included — that would make the
   * least deliberate thing an author can write the most powerful one.
   *
   * Say what a plan may reach for. If it needs nothing, it gets nothing and the
   * planner is told so.
   */
  tools?: string[];
  /** Ceiling on provisioned steps. Default 8. */
  max?: number;
  /** Re-plan the failed portion when a step fails. Default true. */
  revise?: boolean;
}

export type Step =
  | AskStep
  | UseStep
  | ApproveStep
  | WaitStep
  | EachStep
  | WhenStep
  | RepeatStep
  | PlanStep;

export interface WorkflowSpec extends Published {
  readonly kind: "workflow";
  /** Defaults to the filename. */
  name?: string;
  description?: string;
  /** Declared inputs — names to plain-English hints. Drives the run form + MCP schema. */
  input?: Record<string, string>;
  /** Shared knowledge for every `ask` in this workflow. */
  knows?: string[];
  /**
   * The CloudEvent types that start a run of this workflow when one is published
   * on the app's bus (`App.publish`, `POST /api/events`). Exact types; no patterns.
   */
  on?: string | string[];
  steps: Step[];
  /**
   * What has to be true of the result before the run may call itself done.
   *
   * Every step running without throwing says the work happened, not that it
   * worked, and those two come apart exactly where it matters: a step that
   * produced something plausible and wrong finishes as cleanly as one that got
   * it right. State the outcome and it is checked before the run reports
   * success. Where the outcome is a question rather than a command, it is put
   * to something that did not do the work and cannot see how it was done.
   */
  outcome?: Check | Check[];
}

export type WorkflowInput = Omit<WorkflowSpec, "kind">;

/** Every `id` in a list of steps, as a union of literals. */
export type StepIds<Steps> = Steps extends readonly { id: infer Id }[]
  ? Id extends string
    ? Id
    : string
  : string;

/**
 * The same steps, with `after` restricted to ids that exist.
 *
 * A workflow's dependency edges are the part most worth checking early. `after: ["clasify"]`
 * is a typo that produces a step which is never ready, so the run stalls or the graph
 * quietly runs in the wrong order — and it is caught today only when the project loads,
 * which is after the file was written, saved, and the dev server restarted. Here it is a
 * red underline on the word itself.
 *
 * `readonly` throughout because `const` inference produces readonly tuples, and requiring
 * a mutable array would force every author to write `as const` off or spread the list.
 */
/**
 * `Omit` over a union, distributed.
 *
 * A plain `Omit<Step, "after">` collapses the union of step kinds to the keys they all
 * share, which is `id` — so `ask`, `use` and `each` all stop being allowed. Distributing
 * over the union keeps each kind whole.
 */
type WithoutAfter<S> = S extends unknown ? Omit<S, "after"> : never;

export type CheckedSteps<Steps extends readonly Step[]> = {
  readonly [Index in keyof Steps]: WithoutAfter<Steps[Index]> & {
    readonly after?: readonly StepIds<Steps>[];
  };
};

export interface TypedWorkflow<Steps extends readonly Step[]> extends Published {
  name?: string;
  description?: string;
  input?: Record<string, string>;
  knows?: string[];
  on?: WorkflowSpec["on"];
  steps: Steps & CheckedSteps<Steps>;
  outcome?: WorkflowSpec["outcome"];
}

/**
 * Declare a workflow. `export default workflow({ ... })` from a file in `workflows/`.
 *
 * `const Steps` is doing the work: without it the array widens to `Step[]`, every `id`
 * becomes `string`, and `after` accepts anything — which is the behaviour this replaces.
 */
export function workflow<const Steps extends readonly Step[]>(
  spec: TypedWorkflow<Steps>,
): WorkflowSpec {
  return { ...spec, kind: "workflow" } as unknown as WorkflowSpec;
}

// ── Evaluations ────────────────────────────────────────────────────────────

/**
 * One thing that has to be true of an answer.
 *
 * Every grader reads what came out — the text, the structured result, which
 * tools were reached for — and none reads how it was arrived at. An agent that
 * gets to the right answer by a route nobody anticipated has passed; a grader
 * that insisted on the route would fail it for being better than expected.
 *
 * Ordered, like `Check`, by how far they can be trusted. The first seven are
 * decided by comparison and cannot be argued with. `judge` is a model's reading
 * of a rubric: use it where nothing comparable exists, and note that it may
 * answer "unknown", which is counted as neither a pass nor a failure. `check`
 * is code, for whatever the others cannot say.
 */
export type Grader =
  /** The answer text contains this — every one of them, when a list. */
  | { contains: string | string[] }
  /** The answer text contains none of these. */
  | { excludes: string | string[] }
  /** The answer text matches this regular expression source. */
  | { matches: string }
  /** The structured result is exactly this. */
  | { equals: unknown }
  /** The structured result has these fields with these values; others are ignored. */
  | { fields: Record<string, unknown> }
  /** These tools were called, in any order and among any others. */
  | { calls: string | string[] }
  /** None of these tools was called. */
  | { avoids: string | string[] }
  /** A rubric a model grades the answer against. `agent` lends the judge its models. */
  | { judge: string; agent?: string }
  /**
   * The answer says what the recorded one did. Only for a case that carries `recorded`.
   * A structured result is compared field for field. Text is compared as written, and
   * where it differs `"judge"` asks a model whether the two say the same thing while
   * `"exact"` fails it. `agent` lends the judge its models.
   */
  | { reference: "judge" | "exact"; agent?: string }
  /** Code. `true` passes, `false` fails, and a string fails with that as the reason. */
  | { check: (answer: Answer, test: EvalCase) => boolean | string | Promise<boolean | string> };

/** The grader discriminants. A grader carries exactly one. */
export const GRADER_KINDS = [
  "contains",
  "excludes",
  "matches",
  "equals",
  "fields",
  "calls",
  "avoids",
  "judge",
  "reference",
  "check",
] as const;

export type GraderKind = (typeof GRADER_KINDS)[number];

/** One tool call of a recorded run: what was asked for, and what came back. */
export interface RecordedTool {
  name: string;
  args: unknown;
  /** The result as the model was given it. */
  result: string;
  /** Set when the tool reported an error. */
  failed?: true;
}

/**
 * What a recorded run did, kept with the case made from it.
 *
 * `answer` and `data` are the reference a `reference` grader compares against. With
 * `tools` present the case is REPLAYED: a tool the agent calls is answered from this
 * list and never run, so the same input meets the same world every time. A call the
 * recording does not hold is answered with an error, not passed through to the tool.
 */
export interface RecordedRun {
  answer: string;
  data?: unknown;
  tools?: RecordedTool[];
  /** When the run happened, and the recording it was captured from. */
  at?: number;
  id?: string;
}

/** Scoring live answers with a suite's graders. See `EvaluationSpec.online`. */
export interface OnlineEval {
  /** The share of live answers to score, 0..1. */
  sample: number;
  /** What has to be true of a live answer. Any grader but `reference`. */
  expect: Grader[];
  /**
   * The score below which `notify` is told, 0..1. A score is the share of the
   * graders that passed, of those that could be decided. Left out, nobody is told.
   */
  threshold?: number;
}

/** One input, and what has to be true of the answer to it. */
export interface EvalCase<Input = string | Record<string, unknown>> {
  name: string;
  /** What is asked: text for an agent, the declared inputs for a workflow. */
  input: Input;
  /** Every one has to hold for a trial to pass. */
  expect: Grader[];
  /** A ceiling on what one trial may spend, in tokens, in money, or both. Going over fails the trial. */
  budget?: { tokens?: number; spend?: Money };
  /** The recorded run this case was captured from. See `RecordedRun`. */
  recorded?: RecordedRun;
}

export interface EvaluationSpec {
  readonly kind: "evaluation";
  /** Defaults to the filename (`evals/support.ts` ⇒ `support`). */
  name?: string;
  description?: string;
  /** The agent under test. Exactly one of `agent` and `workflow`. */
  agent?: string;
  /** The workflow under test. */
  workflow?: string;
  /**
   * How many times each case is run. Default 1.
   *
   * A model does not give the same answer twice, so one passing run says the
   * answer is reachable and nothing about how often. More than one trial is
   * what turns "it worked" into a rate.
   */
  trials?: number;
  /**
   * What a case has to do to count: `"all"` — every trial passes — or `"any"` —
   * at least one does. Default `"all"`, because an agent somebody relies on has
   * to be right each time, not once in three.
   */
  bar?: "any" | "all";
  cases: EvalCase[];
  /**
   * Score a sample of this agent's live answers with these graders.
   *
   * Scoring starts after the answer has been returned and can neither delay nor fail
   * the request. The result goes to the app's `tracer` in the answer's own trace, and
   * to `notify` when it falls below `threshold`. A suite may have `online` and no
   * cases; `praecise eval` then has nothing of it to run. Agents only.
   */
  online?: OnlineEval;
}

interface EvaluationShared {
  name?: string;
  description?: string;
  trials?: number;
  bar?: "any" | "all";
  online?: OnlineEval;
}

/** `input` is typed by the target: text for an agent, an object for a workflow. */
export type EvaluationInput = EvaluationShared &
  (
    | { agent: string; workflow?: never; cases: EvalCase<string>[] }
    | { workflow: string; agent?: never; cases: EvalCase<Record<string, unknown>>[] }
  );

/** Declare an eval suite. `export default evaluation({ ... })` from a file in `evals/`. */
export function evaluation(spec: EvaluationInput): EvaluationSpec {
  return { ...spec, kind: "evaluation" };
}

// ── Knowledge ──────────────────────────────────────────────────────────────

export interface KnowledgeSpec {
  readonly kind: "knowledge";
  name?: string;
  description?: string;
  /** The text itself. Plain `.md` files in `memory/` need no wrapper. */
  content: string;
}

export type KnowledgeInput = Omit<KnowledgeSpec, "kind">;

/** Declare knowledge from code (for generated or fetched text). */
export function knowledge(spec: KnowledgeInput): KnowledgeSpec {
  return { ...spec, kind: "knowledge" };
}

// ── Tools (services) ───────────────────────────────────────────────────────

/**
 * An approval `approvals.verify` accepted: who it proved, what digest the claim
 * covered, and the signature itself, so the action can present it onward to
 * whoever checks it next.
 */
export interface VerifiedApproval {
  subject: string;
  digest: string;
  signature?: string;
}

/**
 * Whether a tool's output may be relied on. Text from outside the app is
 * "untrusted": an instruction found in it is data, not a request.
 */
export type Trust = "trusted" | "untrusted";

/**
 * A side effect described in terms an authority can check: what kind of
 * operation, with whom, for how much of what, where.
 *
 * Fields are strings so amounts keep their exact decimal form; `detail` carries
 * whatever else a particular authority needs. `tainted` is set by the runtime,
 * never by the tool: it means something untrusted was read earlier in the same
 * conversation or run, so the values here may have been put there by it.
 */
export interface Action {
  operation: string;
  counterparty?: string;
  amount?: string;
  asset?: string;
  network?: string;
  model?: string;
  detail?: Record<string, unknown>;
  tainted?: boolean;
}

export interface ToolSpec {
  readonly kind: "tool";
  name?: string;
  description?: string;
  /**
   * An MCP server endpoint.
   *
   * Optional only because a server can instead be a local PROGRAM — see `command`.
   * Exactly one of the two is required, and declaring both is refused rather than
   * silently preferring one, because which was meant is not recoverable from a guess.
   */
  url?: string;
  /**
   * An OpenAPI description, so an ordinary HTTP API becomes tools without an MCP
   * server in front of it.
   *
   * A URL to the document, or the document itself when it is already in hand. Most APIs
   * worth reaching have one of these and do not have an MCP server, and the alternative
   * is restating a description that already exists and is already accurate.
   *
   * The third of three mutually exclusive kinds of service, alongside `url` and
   * `command`. Which one a service is has to be a statement rather than a guess.
   */
  openapi?: string | Record<string, unknown>;
  /**
   * Override where the operations are sent, when the document's own `servers` is wrong
   * or absent — a staging host, or a document that describes paths and leaves the origin
   * to whoever deploys it.
   */
  baseUrl?: string;
  /**
   * A local MCP server to launch, as a program and its arguments.
   *
   * A large share of published MCP servers are distributed this way — as something you
   * run, not something you call — so a framework that speaks only HTTP cannot reach
   * them at all.
   *
   * Passed to the operating system as an argv array and spawned WITHOUT a shell, so an
   * argument containing a semicolon is an inert string rather than a second command.
   * That is why this is a list and not a line of text: a framework that launches
   * processes for an author does not get to be relaxed about quoting.
   */
  command?: string[];
  /** Extra environment for a launched server. Inherits the app's otherwise. */
  env?: Record<string, string>;
  /**
   * Resource URIs to attach from this server, or `["*"]` for everything it lists.
   *
   * A server's TOOLS are things the model may choose to do; its RESOURCES are things
   * the application decides the agent should know — a runbook, the current price list,
   * whatever the server publishes as a document. Naming them here is that decision,
   * and it is deliberately an explicit list rather than the default: a client that
   * silently hoovered up every resource a server offered would put an unbounded and
   * unpredictable amount of someone else's text into the agent's prompt.
   *
   * Each named resource is read on every request, because a cached answer to "what is
   * true right now" is worse than none — an agent quoting a stale document sounds
   * exactly as confident as one quoting a fresh one.
   */
  resources?: string[];
  /** Environment variable holding the credential. Default `<NAME>_API_KEY`. */
  credential?: string;
  /**
   * Whether this service's outputs may be relied on. A service is outside the
   * app, so the default is "untrusted"; say "trusted" for one you operate.
   */
  trust?: Trust;
  /** Sent as `Authorization: Bearer` unless this says otherwise. */
  auth?: "bearer" | "header";
  /** Header name when `auth: "header"`. */
  header?: string;
}

export type ToolInput = Omit<ToolSpec, "kind">;

/**
 * Register an MCP service the app can act through. Put it in `tools/`; agents
 * then reference it by filename in their `tools` list.
 */
export function tool(spec: ToolInput): ToolSpec {
  return { ...spec, kind: "tool" };
}

// ── Functions (code you wrote) ─────────────────────────────────────────────

export interface FunctionSpec extends Published {
  readonly kind: "function";
  name?: string;
  /** What it does. The model reads this to decide when to call it. */
  description?: string;
  /** Argument names to plain-English hints. Becomes the schema the model sees. */
  input?: Record<string, string>;
  /**
   * The arguments as JSON Schema, for a function whose arguments are not all text: a
   * number, a pair of coordinates, one of a fixed set of words. Used instead of `input`
   * wherever a schema is shown — to a model, and over MCP — and passed through untouched.
   */
  schema?: Record<string, unknown>;
  /** Set when this is a tool an endpoint may know natively. See `NativeTool`; `computer()` sets it. */
  native?: NativeTool;
  /** Also serve it over HTTP, e.g. `http: "POST /webhook"`. */
  http?: string;
  /** `opts.idempotencyKey` arrives when a workflow `use` step calls this — stable
   *  across a crash-retry, so a side-effecting function can dedupe on it. Ignoring
   *  the second argument is fine for anything without a side effect. */
  run(args: Record<string, unknown>, opts?: FunctionRunOptions): unknown | Promise<unknown>;
  /**
   * What calling this does, stated as an action the app's authority can judge.
   *
   * Computed by the runtime from the validated arguments, so a model that names
   * one amount in its reasoning and passes another is judged on the one passed.
   * Absent for anything that only reads.
   */
  action?(args: Record<string, unknown>): Action;
  /**
   * Whether this function's output can steer later actions. "untrusted" for
   * anything that returns text from outside the app (a fetched page, an inbox),
   * so actions taken after reading it are marked tainted. Default "trusted".
   */
  trust?: Trust;
}

export type FunctionInput = Omit<FunctionSpec, "kind">;

/** The second argument a function's `run` receives. */
export interface FunctionRunOptions {
  /** Stable across a crash-retry of the same workflow step, distinct between runs. */
  idempotencyKey?: string;
  /** The run calling, when a workflow `use` step calls this. */
  run?: string;
  /** The step calling, scoped (`each.2.charge`), when a workflow `use` step calls this. */
  step?: string;
  /** The app's fetch: paid on a 402 where the app has a payer. */
  fetch?: typeof fetch;
  /** Verified approvals of this exact call, when a step-up was answered. */
  approvals?: VerifiedApproval[];
  /** Aborts when the run or the request this call belongs to is cancelled. */
  signal?: AbortSignal;
  /**
   * Put an event on the app's bus: every workflow that declared `on` for its type
   * starts a run, and every run waiting for it continues. Resolves with those runs
   * once each has stopped. Called from a workflow step, the event's id is derived
   * from the step, so a step that is retried publishes the same event and nothing
   * runs twice.
   */
  publish?: Publish;
  /**
   * The conversation up to and including the turn that made this call, when a model's
   * tool loop calls this. Every call made in one turn is handed the same last message.
   */
  transcript?: readonly Message[];
  /**
   * Who the request this call belongs to is for, as the app said when it asked: an
   * ask's `caller`, or the `caller` a workflow run or a direct call was started with.
   */
  caller?: AskCaller;
  /** Whatever the app sent along with that request (`AskOptions.context`), untouched. */
  context?: unknown;
}

/** `publish` as a function receives it. See `FunctionRunOptions.publish`. */
export type Publish = (
  type: string,
  data?: unknown,
  rest?: { subject?: string; id?: string },
) => Promise<{ id: string; workflow: string; status: string }[]>;

/** What `run` receives, given the fields that were declared. */
export type Args<Fields> = Fields extends Record<string, string>
  ? Record<keyof Fields, unknown>
  : Record<string, unknown>;

/**
 * The same spec, with `run`'s parameter derived from `input`.
 *
 * This exists to delete one annotation, and that annotation was the single largest piece
 * of ceremony left in authoring. Writing
 *
 *     run: ({ value }: { value: unknown }) => ...
 *
 * restates in a type what the line above already said in `input`, and a reader has to
 * check the two agree. Worse, getting it wrong is quiet: destructuring a field that was
 * never declared compiles, arrives as `undefined`, and produces a confident wrong answer
 * rather than an error — which is exactly what happened when `praecise run band 14` bound
 * nothing and returned a band computed from `NaN`.
 *
 * With the field names inferred, `({ value })` is typed and `({ valeu })` does not
 * compile. The declaration is the single source, as it always claimed to be.
 */
export interface TypedFunction<Fields extends Record<string, string>> extends Published {
  name?: string;
  description?: string;
  input?: Fields;
  http?: string;
  run(args: Args<Fields>, opts?: FunctionRunOptions): unknown | Promise<unknown>;
  action?(args: Args<Fields>): Action;
  trust?: Trust;
}

/**
 * Expose your own code. Put it in `functions/`; agents list it under `tools`.
 *
 * `const Fields` is what makes the inference work: without it TypeScript widens the
 * `input` object to `Record<string, string>` and the key names — the whole point — are
 * lost before `run` is checked.
 */
export function fn<const Fields extends Record<string, string>>(
  spec: TypedFunction<Fields>,
): FunctionSpec {
  return { ...spec, kind: "function" } as FunctionSpec;
}

// ── Prompts (a person invokes these) ───────────────────────────────────────

export interface PromptSpec {
  readonly kind: "prompt";
  name?: string;
  description?: string;
  input?: Record<string, string>;
  /** The template. `{{name}}` is filled from `input`. */
  text: string;
}

export type PromptInput = Omit<PromptSpec, "kind">;

/**
 * Every `{{placeholder}}` in a template, as a union of the names inside the braces.
 *
 * Recursive over the string type, which is how a template literal is taken apart at the
 * type level. It stops at the first segment with no more braces, so a template with no
 * placeholders yields `never` and a template with three yields all three.
 */
export type Placeholders<Text extends string> =
  Text extends `${string}{{${infer Name}}}${infer Rest}`
    ? Trim<Name> | Placeholders<Rest>
    : never;

/** `{{ name }}` and `{{name}}` are the same placeholder, so the spaces come off. */
type Trim<Text extends string> = Text extends ` ${infer Rest}`
  ? Trim<Rest>
  : Text extends `${infer Rest} `
    ? Trim<Rest>
    : Text;

/**
 * A prompt whose template can only name fields it declared.
 *
 * The failure this prevents is specific and silent: `{{custmer}}` in a template with a
 * `customer` field interpolates to nothing, and what reaches the model is a sentence with
 * a hole in it. Nothing throws, the answer is merely worse, and the cause is invisible in
 * the output. Checking the template against the declared fields turns that into a
 * compile error on the misspelled word.
 */
export interface TypedPrompt<Fields extends Record<string, string>, Text extends string> {
  name?: string;
  description?: string;
  input?: Fields;
  text: [Placeholders<Text>] extends [keyof Fields]
    ? Text
    : `this template names {{${Exclude<Placeholders<Text>, keyof Fields> & string}}}, which is not in \`input\``;
}

/**
 * A canned request offered to whoever is driving.
 *
 * When the template names something `input` does not declare, `text` resolves to `never`
 * and the assignment fails — the error lands on the template, which is where the mistake
 * is. A prompt that declares no `input` is unconstrained, because a template with no
 * fields to fill has nothing to get wrong.
 */
export function prompt<
  const Fields extends Record<string, string>,
  const Text extends string,
>(spec: TypedPrompt<Fields, Text>): PromptSpec {
  return { ...spec, kind: "prompt" } as PromptSpec;
}

// ── Resources (the app attaches these) ─────────────────────────────────────

export interface ResourceSpec {
  readonly kind: "resource";
  name?: string;
  description?: string;
  /** Stable identifier a client can attach, e.g. `orders://recent`. */
  uri: string;
  mime?: string;
  read(): string | Promise<string>;
}

export type ResourceInput = Omit<ResourceSpec, "kind">;

/** Context the application supplies, rather than the model asking for it. */
export function resource(spec: ResourceInput): ResourceSpec {
  return { ...spec, kind: "resource" };
}

// ── Stores ─────────────────────────────────────────────────────────────────

export type StoreKind = "sql" | "vector" | "document" | "graph" | "timeseries";

/**
 * Somewhere to keep things.
 *
 * The lifecycle is the same whichever family you pick — declare it, migrate
 * it, scope it, watch it, snapshot it. The query surface is not, and is left
 * native on purpose: the ways you search a table, a vector index, and a graph
 * have little in common, and flattening them produces something bad at all
 * three. Agents get `remember` / `recall` / `search` / `history` on any of them.
 */
export interface StoreSpec {
  readonly kind: "store";
  name?: string;
  description?: string;
  of: StoreKind;
  /** Connection string or path. Omitted ⇒ local file, or the cloud. */
  url?: string;
  /** Environment variable holding the connection string. */
  credential?: string;
  /** Vector stores only. */
  dimensions?: number;
}

export type StoreInput = Omit<StoreSpec, "kind">;

/** Declare a store. Put it in `stores/`; agents and steps reference it by name. */
export function store(spec: StoreInput): StoreSpec {
  return { ...spec, kind: "store" };
}

// ── Blueprints and templates ───────────────────────────────────────────────

export interface FileContents {
  path: string;
  contents: string;
}

/**
 * A piece you can drop into an app that already exists.
 *
 * A blueprint may be written out file by file, or stated in plain English and
 * worked out from there — a `.md` file in `blueprints/` is read as `intent`.
 * What makes the second kind possible is that an app describes itself: every
 * role, every tool and function schema, every store shape is already written
 * down, so there is a known set of parts to build from rather than a blank
 * page. Whatever it produces is written to disk as ordinary files you can read
 * and change.
 */
export interface BlueprintSpec {
  readonly kind: "blueprint";
  name?: string;
  description?: string;
  /** What this should accomplish, in prose. */
  intent?: string;
  /** Files to write verbatim. The rest is derived from `intent`. */
  files?: FileContents[];
  /** Services it will need, so missing keys can be reported before anything runs. */
  needs?: string[];
}

export type BlueprintInput = Omit<BlueprintSpec, "kind">;

export function blueprint(spec: BlueprintInput): BlueprintSpec {
  return { ...spec, kind: "blueprint" };
}

/** A whole starting app, used by `praecise init --template <name>`. */
export interface TemplateSpec {
  readonly kind: "template";
  name?: string;
  description?: string;
  files: FileContents[];
}

export type TemplateInput = Omit<TemplateSpec, "kind">;

export function template(spec: TemplateInput): TemplateSpec {
  return { ...spec, kind: "template" };
}

// ── Middleware ─────────────────────────────────────────────────────────────

export interface Call {
  agent: string;
  input: string;
  quality: Quality;
}

export interface Reply {
  text: string;
  data?: unknown;
}

/**
 * Wraps every call an agent makes. Throw to refuse it.
 *
 * `middleware.ts` at the project root, exporting one of these.
 */
export interface MiddlewareSpec {
  readonly kind: "middleware";
  run(call: Call, next: () => Promise<Reply>): Promise<Reply>;
}

export type MiddlewareInput = Omit<MiddlewareSpec, "kind">;

export function middleware(spec: MiddlewareInput | MiddlewareSpec["run"]): MiddlewareSpec {
  return typeof spec === "function" ? { kind: "middleware", run: spec } : { ...spec, kind: "middleware" };
}

// ── Guard ──────────────────────────────────────────────────────────────────

/**
 * One thing in the work that led to a tool call: something the person said, or a call
 * the agent made. What tools returned and what the model wrote are deliberately not
 * among them — neither was written by anyone the app answers to.
 */
export type Recent = { said: string } | { called: string; args: Record<string, unknown> };

/** A tool an agent is about to reach for, before anything has been called. */
export interface Attempt {
  /** The agent making the call. */
  agent: string;
  /** The tool, named as the model named it. */
  tool: string;
  /** A function in this app, or something a service published. */
  origin: "local" | "remote";
  /**
   * What it says calling it does. Only a function of this app's own declares
   * one; a tool from a service is whatever that service makes of it, so a
   * guard that cares should decide on `origin` instead of assuming.
   */
  effect?: Effect;
  args: Record<string, unknown>;
  /**
   * How the call reached the app.
   *
   * Absent means the runtime's own tool loop — a model, mid-turn, and `agent`
   * names which one. Everything else came through a door somebody opened: a
   * workflow step, an HTTP caller, the published MCP surface, the CLI. Without
   * this a guard sees `agent: "app"` for all four and cannot write the rule it
   * most wants to write, which is that a tool is for workflows and not for
   * whoever can reach the port.
   */
  via?: "workflow" | "http" | "mcp" | "cli" | "app";
  /** Which run and step, when `via` is `"workflow"`. */
  at?: { run?: string; step?: string };
  /** What the call does, where the tool declares it (see `FunctionSpec.action`). */
  action?: Action;
  /** Set when untrusted output was read earlier in the same conversation or run. */
  tainted?: boolean;
  /**
   * Approvals already given for this exact call, each with the identity that
   * signed it and the digest it signed. Only ever filled from verified approvals.
   */
  approvals?: VerifiedApproval[];
  /**
   * The work that led to this call, when it came from the runtime's own tool loop: what
   * the person asked, and the calls the agent has made since, oldest first and this one
   * included. For a check that weighs a call against what was asked for. It never
   * carries a tool's output or the model's prose, so nothing in it was written by
   * content the agent merely read.
   */
  recent?: Recent[];
  /**
   * Who the request this call belongs to is for, as the app said when it asked
   * (`AskOptions.caller`, or `caller` on `callTool` and on a workflow run). Absent where
   * the app named nobody. Written by the app and read by the app: no model sees it.
   */
  caller?: AskCaller;
  /** Whatever the app sent along with the request (`AskOptions.context`), untouched. */
  context?: unknown;
}

/**
 * Says which tool calls the app will actually make.
 *
 * `guard.ts` at the project root, exporting one of these. Answer with nothing
 * to allow the call, or with a sentence to refuse it — and that sentence is
 * handed back as the tool's own result.
 *
 * Refusing that way rather than by throwing is the whole point. A model told
 * that a refund over five hundred needs a person can say so to the customer; a
 * model handed an exception can only stop, and the run ends somewhere nobody
 * chose. The reason is written for the model to read, so write it as one.
 */
export interface GuardSpec {
  readonly kind: "guard";
  run(attempt: Attempt): string | undefined | Promise<string | undefined>;
}

export type GuardInput = Omit<GuardSpec, "kind">;

export function guard(spec: GuardInput | GuardSpec["run"]): GuardSpec {
  return typeof spec === "function" ? { kind: "guard", run: spec } : { ...spec, kind: "guard" };
}

// ── Hooks ──────────────────────────────────────────────────────────────────

/** A tool has run, and the model has not yet read what it returned. */
export interface ToolOutcome {
  /** The agent that made the call. */
  agent: string;
  /** The tool, by the name the guard saw. */
  tool: string;
  origin: "local" | "remote";
  effect?: Effect;
  args: Record<string, unknown>;
  /** What the tool returned, as the text the model would read. */
  result: string;
  /** Whether the call came back an error. */
  failed: boolean;
  /** How many attachments came back with it: screenshots, files. */
  attachments: number;
  /** Set when untrusted output had already been read in this conversation. */
  tainted?: boolean;
}

/** An agent has answered without asking for a tool, and is about to stop. */
export interface Stopping {
  agent: string;
  /** What it is about to give as its answer. */
  text: string;
  /** The work that led to it, the question included. */
  transcript: readonly Message[];
  /** How many times this conversation has already been sent back. */
  sentBack: number;
}

/** The earlier part of a long piece of work is about to be replaced by a summary. */
export interface Compacting {
  agent: string;
  /** The turns that would be replaced. The question, and the most recent turns, are not among them. */
  transcript: readonly Message[];
  /** The same turns as the text a model would be asked to summarise. */
  text: string;
}

/** Nothing leaves the result as it is; `result` replaces it; `reject` withholds it and is what the model reads instead. */
export type AfterTool = undefined | void | { result: string } | { reject: string };

/** Nothing lets it be summarised as usual; `keep` forbids the summary; `summary` is used in place of one a model would write. */
export type BeforeCompact = undefined | void | { keep: true } | { summary: string };

/**
 * Says what happens at three moments a guard does not reach.
 *
 * `hooks.ts` at the project root, exporting one of these; a plugin may bring one too,
 * and they are asked in order with the app's own first. Each answers as a guard does:
 * say nothing and what was going to happen happens.
 *
 * `afterTool` sees every result before the model does. It may rewrite it — take a
 * secret out, cut it down — or withhold it with a sentence, which the model reads as
 * that tool's result. A result that was withheld never enters the conversation, so it
 * does not mark later actions as tainted.
 *
 * `beforeStop` is asked when an agent answers instead of calling a tool. A sentence
 * back sends it to work again with that sentence as the reason — the tests have not
 * been run, the form still has an empty field. An agent can be sent back three times in
 * one conversation and no more: a check that is never satisfied must not become a loop.
 *
 * `beforeCompact` is asked when a transcript has outgrown its room and the earlier work
 * is about to be replaced by notes a model writes. `{ keep: true }` forbids that —
 * old tool results are cleared harder instead, because a transcript that does not fit
 * is a request that is refused — and `{ summary }` supplies the notes, so nothing is
 * asked of a model at all.
 */
export interface HooksSpec {
  readonly kind: "hooks";
  afterTool?(outcome: ToolOutcome): AfterTool | Promise<AfterTool>;
  beforeStop?(stopping: Stopping): string | undefined | void | Promise<string | undefined | void>;
  beforeCompact?(compacting: Compacting): BeforeCompact | Promise<BeforeCompact>;
}

export type HooksInput = Omit<HooksSpec, "kind">;

export function hooks(spec: HooksInput): HooksSpec {
  return { ...spec, kind: "hooks" };
}

// ── Project config (all optional) ──────────────────────────────────────────

/**
 * Where something comes from. Three ways, and they read the same for models,
 * stores, and file conversion: use what is supported out of the box, point at
 * something you host, or hand over one Praecise Cloud key and let the cloud do it.
 */
export interface Provider {
  /** An endpoint you host yourself. */
  url?: string;
  /** Environment variable holding the credential. */
  credential?: string;
  /**
   * The header the credential is sent in, where the endpoint does not take a bearer.
   *
   * Some gated endpoints read `Authorization: Bearer` as an anonymous caller and refuse
   * it, and expect a key header of their own. Naming it here keeps the credential where
   * it belongs: it is still resolved from `credential`, so nothing in the app has to
   * read the secret in order to put it somewhere. Left out, a bearer is sent as before.
   */
  credentialHeader?: string;
  /**
   * Extra headers every request to this endpoint carries — a tenant id, a routing hint,
   * a second credential beside the first.
   *
   * Applied last, so an entry here wins over anything the wire would otherwise send,
   * including the credential header above.
   */
  headers?: Record<string, string>;
  /**
   * Fields this endpoint needs that the protocol does not name, merged into the body.
   *
   * What a request asks for wins, and `model` and the conversation are never replaceable
   * from here — this fills gaps rather than overriding decisions. It exists because
   * deployments have real needs the wire formats have no word for, and the alternative
   * to a line in a config file is a patched copy of the framework.
   */
  body?: Record<string, unknown>;
}

/**
 * What a million tokens cost on one model, by what the tokens were.
 *
 * `input` and `output` are required; the rest are for an endpoint that charges them
 * differently. Left out, tokens read from a kept prefix and tokens written to one are
 * charged as input, and reasoning as output — which is what an endpoint that draws no
 * such line bills.
 */
export interface Rates {
  input: number;
  output: number;
  /** Input the endpoint read from a prefix it had kept. */
  cachedRead?: number;
  /** Input the endpoint was asked to keep for next time. */
  cacheWrite?: number;
  /** Output that was reasoning rather than answer. */
  reasoning?: number;
}

/**
 * What an endpoint charges, per rung, in a currency it names.
 *
 * Keyed as the models are: `fast`, `balanced`, `best`. A rung that runs on another
 * rung's model — an endpoint naming only `balanced` runs all three on it — is charged
 * what that model costs.
 */
export interface Prices {
  /** The currency every figure is in, as an ISO 4217 code: `"USD"`, `"EUR"`. */
  currency: string;
  fast?: Rates;
  balanced?: Rates;
  best?: Rates;
}

/** An amount of money, in a named currency. */
export interface Money {
  amount: number;
  /** An ISO 4217 code, matching the one the endpoints' prices are declared in. */
  currency: string;
}

export interface ModelProvider extends Provider {
  /**
   * The request shape the endpoint speaks, named after the field each one
   * carries its conversation in. Default "chat", which most endpoints accept.
   *
   * Three ship — "messages", "chat", "contents". Any other name must have been
   * given to `registerWire` before the app loads; an unregistered name is refused
   * with the list of the ones that are known, rather than failing later inside a
   * request with nothing to say about the line that caused it.
   */
  speaks?: string;
  /**
   * A model per rung, cheapest first. `quality` picks between them, and naming
   * only one is fine — every rung then runs on it.
   */
  fast?: string;
  balanced?: string;
  best?: string;
  /**
   * How the endpoint takes a request for more depth: a named effort level, a
   * token budget, or not at all. Defaults to "budget" on `messages`, else none.
   */
  thinking?: "effort" | "budget" | "none";
  /**
   * The words this endpoint takes for depth, shallowest first. Default
   * `["low", "medium", "high"]`. An endpoint with levels above `high` names them here —
   * `["low", "medium", "high", "xhigh"]` — and full effort then asks for the last.
   */
  levels?: string[];
  /**
   * The most tokens one reply may take. Left out, each wire uses its own ceiling, which
   * is modest; an endpoint that writes long answers, or thinks at length before it
   * writes, says so here.
   */
  output?: number;
  /**
   * What this endpoint can be sent besides text: any of `"image"`, `"audio"`,
   * `"video"`, `"document"`. Left out, it is what the endpoint's shape has a place for —
   * images and PDFs on `messages` and `responses`, images on `chat`, all four on
   * `contents` and `interactions`. A `chat` server that takes audio or video says so
   * here. Anything an endpoint cannot be sent is shown to the model as a rendering where
   * a reader knows its media type, and otherwise left out with a note.
   */
  takes?: ("image" | "audio" | "video" | "document")[];
  /**
   * The model this endpoint turns text into vectors with, where it has one. Named, an
   * agent that remembers into a vector store is recalled by meaning rather than by
   * shared words. Sent to `{url}/embeddings`.
   */
  embeds?: string;
  /**
   * Whether to mark what is worth keeping for the next request, on an endpoint that
   * keeps a prefix only where told to. Default true. Set false for a gateway that
   * refuses the marker.
   */
  cache?: boolean;
  /** Set false if the endpoint has no tool calling. Default true. */
  tools?: boolean;
  /**
   * Whether an attachment too large to keep sending is uploaded once through the
   * endpoint's files API and named from then on, and at what size.
   *
   * Left out, an endpoint on `messages`, `responses`, `contents` or `interactions`
   * uploads past the size its shape is sure to take inline; an endpoint on `chat` does
   * not, because most servers that speak that shape store no files. `true` turns it on
   * there, `false` turns it off anywhere, and an object sets the line: `over` in bytes,
   * and `keep`, how many seconds the endpoint is asked to hold the file (a week unless
   * said). An upload that fails is sent inside the request instead, with a note.
   */
  uploads?: boolean | { over?: number; keep?: number };
  /**
   * Set false for an endpoint that has no batch API, so that `askMany` sends its
   * requests one at a time instead of finding that out. Default true where the
   * endpoint's shape has one.
   */
  batch?: boolean;
  /**
   * Where a live session with this endpoint is opened, for voice and anything else that
   * is a conversation over one connection rather than a request.
   *
   * `model` is the model a session runs on, which is rarely one of the three above.
   * `url` is the WebSocket address, where it is not the one the endpoint's shape
   * documents relative to `url` above. `speaks` names the session protocol where it is
   * not the one registered for the endpoint's own shape; `voice` and `body` are passed
   * to it, the second as session settings the protocol has names for and this does not.
   */
  realtime?: {
    model: string;
    url?: string;
    speaks?: string;
    voice?: string;
    body?: Record<string, unknown>;
  };
  /**
   * The type this endpoint's own computer-use tool is declared as, exactly as its
   * documentation gives it. Named, an agent's `computer()` tool is sent to this endpoint
   * as that tool rather than as a described function; left out, it is sent as a function,
   * which works everywhere. Read only by the `messages` shape. A version that needs a
   * beta header needs it in `headers` too. The framework ships no such string: it names
   * a provider's release, and belongs to the app for the reason a model id does.
   */
  computer?: string;
  /**
   * What this endpoint charges, per million tokens. Left out, nothing asked of it is
   * priced: answers carry token counts and no cost, and a spending limit refuses a run
   * that reaches it rather than counting it as free.
   *
   * Declared rather than looked up, for the reason `room` is: the framework ships no
   * list of models, and a price list written into it would be out of date before it
   * was released.
   */
  prices?: Prices;
  /**
   * How many tokens the endpoint's context holds. Everything carried into a
   * request is a share of this, so an endpoint with room to spare uses it.
   *
   * Declared rather than looked up: the framework ships no list of models, and
   * one written into it would be wrong within the month. Left out, a modest
   * figure is assumed, which is the safe direction to be wrong in.
   */
  room?: number;
}

/**
 * Ceilings on a run.
 *
 * These are inherited by anything a run provisions, all the way down. A limit
 * that stops applying one level in is not a limit — it is the reason a request
 * to clone a repository can quietly cost a million tokens.
 */
export interface Limits {
  /** How deep provisioning may nest. Default 3. */
  depth?: number;
  /** How many steps may run at once. Default 4. */
  concurrency?: number;
  /** Seconds any one step may take. Default 600. */
  timeout?: number;
  /** Tokens one run may spend. */
  budget?: number;
  /**
   * Model calls one request to an agent may make, when the request does not say
   * (`AskOptions.maxCalls`). Every call counts: tool turns, samples, climbs, summaries,
   * and the calls of an agent asked on the way. Left out, there is no limit.
   */
  calls?: number;
  /**
   * Money one run may spend, in the currency the endpoints' `prices` are declared in.
   *
   * Counted from those declarations, so it holds only where every model a run reaches
   * has one: a run answered by a model with no price, or one priced in another
   * currency, is stopped and told why rather than waved through as costing nothing.
   */
  spend?: Money;
  /**
   * How many times a rung that failed for a passing reason — a rate limit, a server
   * fault — is asked again before the ladder moves on. Default 2.
   *
   * Worth raising where one endpoint serves one request at a time: everything queued
   * behind the one in flight is refused rather than delayed, and crossing to another
   * model on that is paying more precisely because the cheap one was busy.
   */
  retries?: number;
  /**
   * Milliseconds to wait before the first of those, doubling with jitter. Default 200.
   *
   * The default assumes a rate limit clearing in a moment. An endpoint that is busy
   * because it is working through a queue clears on the scale of the request ahead of
   * it, which is seconds rather than milliseconds.
   */
  retryDelay?: number;
}

/**
 * What a deployment values when cost and quality pull apart.
 *
 *   "cost"     — start below the estimate and check, because a check is cheaper than a climb
 *   "balanced" — start at the estimate, check only near the edge of a rung's competence
 *   "quality"  — start at the strongest rung and stay there; no cascade at all
 *
 * This is the OPERATOR's dial, and it is deliberately not the `quality` an author sets
 * on an agent. An author says how much room a task needs; whoever runs the app says what
 * they are willing to pay for it. Those are different people holding different
 * information, and collapsing them into one setting forces whoever writes the agent to
 * guess at someone else's budget.
 */
export type Preference = "cost" | "balanced" | "quality";

/**
 * Commands a package adds to the CLI, run as `praecise <name> <command> ...`.
 *
 * Listed in `praecise.config.ts` under `plugins`. A plugin cannot replace a
 * built-in command: its commands only ever live under its own name.
 */
export interface Plugin {
  name: string;
  /** Commands run as `praecise <name> <command> ...`. */
  commands?: Record<
    string,
    {
      describe: string;
      run(argv: string[], ctx: { root: string; flags: Record<string, string | true>; out(line: string): void }): number | Promise<number>;
    }
  >;
  /**
   * A piece of an app this plugin brings, keyed by name as a folder keys things by
   * file: agents, workflows, tools, functions, prompts, resources, stores, evals.
   *
   * Merged UNDER the app's own folder. Where both define a name the app's is used and
   * the collision is reported, so installing a plugin can add to an app and can never
   * quietly change what one of its own agents is.
   */
  app?: {
    agents?: Record<string, AgentInput>;
    workflows?: Record<string, WorkflowInput>;
    tools?: Record<string, ToolInput>;
    functions?: Record<string, FunctionInput>;
    prompts?: Record<string, PromptInput>;
    resources?: Record<string, ResourceInput>;
    stores?: Record<string, StoreInput>;
    evals?: Record<string, EvaluationInput>;
  };
  /**
   * Checks this plugin makes after a tool runs, before an agent stops, and before a
   * transcript is summarised. Asked after the app's own `hooks.ts`, in the order the
   * plugins are listed. See `HooksSpec`.
   */
  hooks?: HooksInput;
  /** Storage backends this plugin brings, matched to a store by the scheme of its url. */
  drivers?: import("./stores/types.js").Driver[];
  /**
   * Run once when the app loads, before anything is planned. Where a plugin registers
   * what is process-wide: a request shape (`registerWire`), a reader for a kind of data
   * (`registerReader`).
   */
  setup?(): void | Promise<void>;
}

/** The name this type had when a plugin could only add commands. */
export type CliPlugin = Plugin;

export interface AppConfig {
  /**
   * Packages that extend this app: commands under their own name, a piece of an app
   * merged under this one's folder, storage drivers, and a `setup` for registering
   * request shapes and readers.
   */
  plugins?: Plugin[];
  /**
   * Indexes `praecise search` and `praecise add` read, in order: each the URL of an
   * Agent Skills discovery index, or an origin whose
   * `/.well-known/agent-skills/index.json` is read. Nothing is fetched from them
   * unless one of those two commands is run, and the framework ships no default.
   */
  registries?: string[];
  /**
   * Keep what each agent was asked, what its tools returned and what it answered,
   * under the state directory, so `praecise capture` can turn real exchanges into
   * eval cases. Off by default. Credentials are redacted before anything is written.
   */
  record?: boolean;
  /**
   * What this deployment values when cost and quality pull apart. Default `"balanced"`.
   * Under `"quality"` the ladder is not climbed at all: the strongest rung answers at
   * full depth, and nothing is checked, because checking exists to decide whether to
   * climb.
   */
  preference?: Preference;
  /**
   * What `/ask` — the natural-language endpoint an agent queries — is allowed to spend.
   *
   * Both fields are CEILINGS a caller may come in under and never exceed. Left out, the
   * endpoint retrieves and ranks without reaching a model at all, which costs nothing and
   * is the right answer for a caller that will read the results itself.
   */
  ask?: {
    /** The most expensive rung a generated answer may use. Default `"fast"`. */
    quality?: Quality;
    /** The most work an answer may involve: `list` < `summarize` < `generate`. */
    mode?: "list" | "summarize" | "generate";
    /** Which agent renders the answer. Defaults to the first published one. */
    agent?: string;
    /** How many retrieved items to consider. */
    limit?: number;
    /**
     * The store holding the content to mirror — the catalogue, the articles, the price
     * list. Named here, its rows are what `/ask` searches and returns as schema.org
     * objects, so an agent reads the business's real data rather than scraping the
     * human site for it.
     */
    store?: string;
    /** What those rows are: `Product`, `Article`, `FAQPage`, `Offer`. Default `Thing`. */
    type?: string;
  };
  /**
   * Share of routing decisions to send somewhere the estimate would not have sent them,
   * so that the record of what the router chose can be read back. Default 0 — off.
   *
   * Turning it on is a purchase and it is deliberately yours to make. A deterministic
   * router gives every rung it did not choose a probability of exactly zero, and a log
   * of such decisions cannot answer whether a choice was RIGHT — only whether the
   * escalations it did make paid off. Randomising a small, capped share and writing the
   * probability down is what makes the rest of the log estimable. `EXPLORATION` (2%) is
   * the value to use; anything above 5% is clamped, so the cost stays knowable before it
   * is spent. Ignored under `preference: "cost"` and `"quality"`, neither of which opted
   * into a tradeoff.
   */
  explore?: number;
  /** Shown in the dashboard. Defaults to the directory name. */
  name?: string;
  /**
   * What this app calls itself when published. Callers pin against it, so a
   * renamed tool or a changed schema deserves a bump. Default `"0.1.0"`.
   */
  version?: string;
  /** One line on what the app is for. Read by whoever is deciding to install it. */
  description?: string;
  /** Default quality for every agent that does not set its own. */
  quality?: Quality;
  /** Dev server port. Default 3000. */
  port?: number;
  /**
   * Model endpoints, keyed by name, in preference order.
   *
   * EVERY endpoint whose credential is present contributes rungs, and the ladder
   * is walked in declaration order — so a ladder may cross vendors: a local
   * gateway first, a hosted API after it, a frontier endpoint last. Each rung
   * carries its own base URL and credential, and when one fails to answer the
   * router crosses to the next rather than retrying a dead endpoint.
   *
   * Because the ladder is climbed cheapest-first, declaration order should be
   * COST order: the endpoint you would rather not pay for goes first, and the
   * one you would rather not need goes last. An endpoint whose credential is
   * unset is skipped rather than being an error, which is what lets one config
   * serve a laptop with no keys and a deployment with all of them.
   *
   * Leave this out and the app runs on Praecise Cloud with `PRAECISE_API_KEY`.
   * The cloud is a fallback for an app that declared nothing reachable, never a
   * rung appended to one that did — an app that named its endpoints has said
   * where its work goes. The framework knows no other endpoint by name: a base
   * URL and a model id belong to the app that chose them, not to the framework.
   */
  models?: Record<string, ModelProvider>;
  /** How files become text. Default: built-in for text, the model for images. */
  ingest?: Provider & { using?: "native" | "model" | "mcp" | "cloud" };
  /** Default store for agents that ask for memory without naming one. */
  store?: string;
  /** Where durable state lives. Default `.praecise`. */
  stateDir?: string;
  limits?: Limits;
  /**
   * Refuse where the framework would otherwise be friendly. Off by default; the
   * `PRAECISE_STRICT` environment variable turns it on where this says nothing,
   * so a deployment can insist on it without editing the app.
   *
   * The one thing it currently governs is the placeholder answer an app with no
   * model endpoint returns, which exists so that a folder five minutes old does
   * something. In production that same friendliness is a confident paragraph of
   * prose reported as `done`. An app that has models configured and cannot reach
   * them refuses whatever this says — that case is a misconfiguration rather
   * than a first run, and no setting should make it quiet.
   */
  strict?: boolean;
  /**
   * Where the selves agents declare live. `url` (or `SELVES_URL`) is the self
   * provider; `credential` names the variable holding its key (default
   * `SELVES_KEY`); `adminCredential` the key that may create a self from an
   * agent's template on first use (default `SELVES_ADMIN_KEY`); and
   * `ticketCredential` the secret that binds a ticket to a person before it goes
   * to a browser (default `SELVES_TICKET_SECRET`). A self is memory, not a
   * dependency: without `required`, an unreachable provider is a note and the
   * agent answers as it would have.
   */
  selves?: Provider & {
    adminCredential?: string;
    ticketCredential?: string;
    /** The surface requests come from when an agent does not say. Default "agent". */
    surface?: string;
    required?: boolean;
    timeoutMs?: number;
  };
}

/** Type-checked `praecise.config.ts`. Entirely optional — a project needs no config. */
export function defineConfig(config: AppConfig): AppConfig {
  return config;
}

// ── Narrowing helpers (used by the loader and runner) ──────────────────────

/**
 * Does this step CARRY that discriminant — as its own key, with a value?
 *
 * Not `"ask" in s`, for two reasons that both end in a step being dispatched as
 * something it is not.
 *
 * `in` is true for a key that is present and explicitly `undefined`, and the
 * shape that produces one is ordinary:
 *
 *     { id: "step", ask: draft ? "revise it" : undefined, use: "svc.fallback" }
 *
 * Under `in` that is an ask, it asks the empty string, and the fallback never
 * runs. Under this it is a `use`, which is what the author wrote.
 *
 * `in` also walks the prototype chain, so a step rebuilt by a class, by
 * `Object.create`, or by a config layer that inherits rather than merges is
 * classified by keys that are not its own and that `Object.keys` would not show.
 * Ownership is the whole question here, so it is asked directly.
 */
const carries = (s: Step, key: string): boolean =>
  Object.hasOwn(s, key) && (s as unknown as Record<string, unknown>)[key] !== undefined;

/**
 * The eight discriminants, in the order the runner dispatches them.
 *
 * Exported because more than one component decides what a step is, and the
 * ORDER used to differ between them — `runStep` took the first match, the
 * loader's `childrenOf` took a different one — which is how a step could be
 * validated as a loop and executed as an ask. There is one list now, and a step
 * that appears in it twice is refused before it runs (see `defectsIn`).
 */
export const STEP_KINDS = ["ask", "use", "approve", "wait", "each", "when", "repeat", "plan"] as const;

export type StepKind = (typeof STEP_KINDS)[number];

/** Which discriminants a step carries. Exactly one is a step; more than one is a defect. */
export function kindsOf(s: Step): StepKind[] {
  return STEP_KINDS.filter((kind) => carries(s, kind));
}

export const isAsk = (s: Step): s is AskStep => carries(s, "ask");
export const isUse = (s: Step): s is UseStep => carries(s, "use");
export const isApprove = (s: Step): s is ApproveStep => carries(s, "approve");
export const isWait = (s: Step): s is WaitStep => carries(s, "wait");
export const isEach = (s: Step): s is EachStep => carries(s, "each");
export const isWhen = (s: Step): s is WhenStep => carries(s, "when");
export const isRepeat = (s: Step): s is RepeatStep => carries(s, "repeat");
export const isPlan = (s: Step): s is PlanStep => carries(s, "plan");
