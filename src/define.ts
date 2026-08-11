/**
 * The authoring surface. Everything a developer writes goes through one of the
 * four helpers here, and none of them mention models, routing, tiers, gates, or
 * retrieval — those are derived (see src/compile). If a runtime concept appears
 * in this file, the abstraction has leaked.
 */

/**
 * How much the answer is worth. This is the ONLY dial on cost/capability;
 * concrete models and escalation thresholds are derived from it and from
 * whichever provider credentials happen to be present.
 */
export type Quality = "fast" | "balanced" | "best";

export const QUALITIES: readonly Quality[] = ["fast", "balanced", "best"];

/** A named, structured result. Values are plain-English type hints. */
export type Returns = Record<string, string>;

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

export interface AgentSpec extends Published {
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
  /** What it may act through — a `functions/` or a `tools/` entry, by filename. */
  tools?: string[];
  /** Defaults to the project's quality, else "balanced". */
  quality?: Quality;
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
  /** Ask for a structured result instead of prose. */
  returns?: Returns;
  /** Few-shot examples. */
  examples?: { input: string; output: string }[];
  /** First message shown in the chat UI. */
  greeting?: string;
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

export type AgentInput = Omit<AgentSpec, "kind">;

/** Declare an agent. `export default agent({ ... })` from a file in `agents/`. */
export function agent(spec: AgentInput): AgentSpec {
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
  /** Governance for the human gate. `quorum` > 1 requires that many DISTINCT approvers
   *  (the two-person rule); praecise captures who approved + a signature, the app layer
   *  enforces whether an approver is authorized. */
  requires?: { quorum?: number };
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
  /** Ceiling on the tools the provisioned steps may call — a non-escalation bound:
   *  a plan can only build from a subset it is granted, never widen its authority.
   *  Omitted ⇒ every tool (current behaviour). */
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

/** Declare a workflow. `export default workflow({ ... })` from a file in `workflows/`. */
export function workflow(spec: WorkflowInput): WorkflowSpec {
  return { ...spec, kind: "workflow" };
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

export interface ToolSpec {
  readonly kind: "tool";
  name?: string;
  description?: string;
  /** An MCP server endpoint. */
  url: string;
  /** Environment variable holding the credential. Default `<NAME>_API_KEY`. */
  credential?: string;
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
  /** Also serve it over HTTP, e.g. `http: "POST /webhook"`. */
  http?: string;
  run(args: Record<string, unknown>): unknown | Promise<unknown>;
}

export type FunctionInput = Omit<FunctionSpec, "kind">;

/** Expose your own code. Put it in `functions/`; agents list it under `tools`. */
export function fn(spec: FunctionInput): FunctionSpec {
  return { ...spec, kind: "function" };
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

/** A canned request offered to whoever is driving. */
export function prompt(spec: PromptInput): PromptSpec {
  return { ...spec, kind: "prompt" };
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
}

export interface ModelProvider extends Provider {
  /**
   * The request shape the endpoint speaks, named after the field each one
   * carries its conversation in. Default "chat", which most endpoints accept.
   */
  speaks?: "messages" | "chat" | "contents";
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
  /** Set false if the endpoint has no tool calling. Default true. */
  tools?: boolean;
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
}

export interface AppConfig {
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
   * Model endpoints, keyed by name, in preference order. The first whose
   * credential is present is the one that runs.
   *
   * Leave this out and the app runs on Praecise Cloud with `PRAECISE_API_KEY`.
   * The framework knows no other endpoint by name — a base URL and a model id
   * belong to the app that chose them, not to the framework.
   */
  models?: Record<string, ModelProvider>;
  /** How files become text. Default: built-in for text, the model for images. */
  ingest?: Provider & { using?: "native" | "model" | "mcp" | "cloud" };
  /** Default store for agents that ask for memory without naming one. */
  store?: string;
  /** Where durable state lives. Default `.praecise`. */
  stateDir?: string;
  limits?: Limits;
}

/** Type-checked `praecise.config.ts`. Entirely optional — a project needs no config. */
export function defineConfig(config: AppConfig): AppConfig {
  return config;
}

// ── Narrowing helpers (used by the loader and runner) ──────────────────────

export const isAsk = (s: Step): s is AskStep => "ask" in s;
export const isUse = (s: Step): s is UseStep => "use" in s;
export const isApprove = (s: Step): s is ApproveStep => "approve" in s;
export const isEach = (s: Step): s is EachStep => "each" in s;
export const isWhen = (s: Step): s is WhenStep => "when" in s;
export const isRepeat = (s: Step): s is RepeatStep => "repeat" in s;
export const isPlan = (s: Step): s is PlanStep => "plan" in s;
