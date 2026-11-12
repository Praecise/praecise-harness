/**
 * The app: a loaded project plus everything needed to answer with it.
 *
 * The CLI and the dev server both talk to this and nothing below it. Loading is
 * cheap and repeatable, so a file change is handled by building a whole new app
 * rather than by patching a live one.
 */

import { setupPlugins } from "./project/plugins.js";
import { AsyncLocalStorage } from "node:async_hooks";

import { composeHooks } from "./harness/hooks.js";
import { cloudEvent, type CloudEvent } from "./events.js";
import { Notifier, type Notify } from "./notify.js";
import { diskBlobs, type BlobStore } from "./blobs.js";
import { embedderFor, type Embedder } from "./harness/embed.js";
import { rerankerFor } from "./harness/rerank.js";
import { openTicket, selvesFrom, type SelfProvider, type SelfVerdict, type SelvesRuntime } from "./harness/selves.js";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { planProject, planWorkflowAgent, type AgentPlan } from "./compile/plan.js";
import { resolveServices } from "./compile/services.js";
import type { AppConfig, Attempt, Effect, EvalCase, FileContents, OnlineEval, FunctionSpec, Publish, Trust, VerifiedApproval, WorkflowSpec } from "./define.js";
import { answerOfRun } from "./eval/answer.js";
import { evaluationFaults } from "./eval/defects.js";
import { runEvaluations, type EvalOptions, type EvalReport, type EvalTarget } from "./eval/run.js";
import { evaluationSpan, scoreAnswer, scoringContext } from "./eval/online.js";
import {
  Recordings,
  casesFromRecordings,
  casesFromRuns,
  newRecordingId,
  recordingTape,
  replayTape,
  type Recorder,
  type ReferenceMode,
} from "./eval/replay.js";
import { safeMessage } from "./redact.js";
import { judge as judgeClaim, type Verdict } from "./workflow/judge.js";
import { StepUpRequired, judge, type Authority } from "./authority.js";
import type { Journal, Sandbox } from "./journal.js";
import { payingFetch, type Payer } from "./payments.js";
import { signingFetch, type BotSigner } from "./botauth.js";
import { deriveFiles, writeFiles, type WriteResult } from "./project/install.js";
import { NoteBook, consolidate, type Candidate, type Note } from "./harness/consolidate.js";
import { resolveHarness, stateDirFor } from "./harness/index.js";
import { newSpanId, newTraceId, type TraceContext, type Tracer } from "./harness/trace.js";
import { createHash } from "node:crypto";

/**
 * A stable trace id derived from a name.
 *
 * Workflow events arrive without one — the older `GenAiSpan` shape has no ids at all —
 * so it is derived from the step's own identity. Deriving rather than minting is what
 * makes the steps of one run group together instead of each becoming its own trace.
 */
const traceIdFor = (name: string): string =>
  createHash("sha256").update(name).digest("hex").slice(0, 32);
import { Memory, StoredMemory, type Episode, type Recollection } from "./harness/memory.js";
import { Threads } from "./harness/threads.js";
import {
  ApiClient,
  McpClient,
  collectTools,
  effectOf,
  serviceSegment,
  splitToolName,
  toolName,
  type McpHost,
  type McpResourceContents,
  type McpTool,
  type McpToolResult,
  type ToolSource,
} from "./harness/mcp.js";
import { stream } from "./harness/stream.js";
import type { Answer, AskOptions, Asking, Batched, Harness, Progress } from "./harness/types.js";
import type { OpenOptions } from "./harness/session.js";
import type { BatchOptions } from "./harness/wire/batch.js";
import type { Session, SocketConstructor } from "./harness/wire/session.js";
import { loadProject, type Project } from "./project/load.js";
import { Stores } from "./stores/index.js";
import type { Driver, Meta, Reranker, Store } from "./stores/types.js";
import { provisioner, type Manifest } from "./workflow/provision.js";
import {
  awaits,
  cancelRun,
  recoverRun,
  resumeRun,
  signalRun,
  startRun,
  timeoutRun,
  type ApprovalClaim,
  type ApprovalDecision,
  type GenAiSpan,
  type WorkflowDeps,
} from "./workflow/run.js";
import { RunStore, type Run, type RunCipher, type RunTransition } from "./workflow/store.js";
import { CursorFile, runIdFor, type Source } from "./sources.js";
import { Gate } from "./gate.js";

/**
 * How many events deep the work in hand is: one for a run an event started, two
 * for a run started by an event that run published, and so on.
 *
 * Carried by the call itself and not by the event, so it cannot be forged from
 * outside and follows the work wherever it goes — a step, a tool an agent
 * called, a function. It is what stops a workflow that publishes the event it
 * subscribes to from running, and paying, for ever.
 */
const depth = new AsyncLocalStorage<number>();

/** The most events deep a chain of publishing may go before it is refused as a loop. */
const MOST_HOPS = 16;

/** The longest a timer can be set for. A wait that ends later is looked at again then. */
const LONGEST_TIMER = 2 ** 31 - 1;

/** The event types a workflow asked to be started by. */
export function subscriptionsOf(spec: WorkflowSpec): string[] {
  return spec.on === undefined ? [] : Array.isArray(spec.on) ? spec.on : [spec.on];
}

/**
 * Who may sign off on a gate, and how that is proved.
 *
 * Nothing here has a default, and that is deliberate. An app that wires neither
 * gets an approvals ledger that says plainly it is unsigned; an app that wires
 * both gets one that can be argued with in front of an auditor. What must never
 * exist is the third state — a ledger that looks signed because the framework
 * made something signature-shaped out of values anyone could read.
 */
export interface Approvals {
  /** Sign the claim. Anything: an OIDC id_token, a KMS signature, a WebAuthn assertion. */
  sign?(claim: ApprovalClaim): Promise<string>;
  /** Check a signature against the claim, answering with the identity it proved. */
  verify?(claim: ApprovalClaim, signature: string): Promise<string | undefined>;
  /**
   * The channels a gate answers on. Absent ⇒ any.
   *
   * The dev server presents `"http"`, which is also what every agent tool that can
   * make a request can reach. Naming a channel the agents cannot reach is what
   * stops a run approving itself.
   */
  channels?: string[];
}

export interface AppOptions {
  root?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** What a live session is opened over. The runtime's own `WebSocket` unless given. */
  WebSocket?: SocketConstructor;
  /** Cache-busting suffix so a reload re-imports changed modules. */
  revision?: string;
  /**
   * What the app is called and which version it is, when that cannot be read
   * from the folder. A packaged app is unpacked wherever the installer likes,
   * so it must carry its own identity rather than take the directory's.
   */
  name?: string;
  version?: string;
  /** Force a provider instead of using credential precedence. */
  prefer?: string;
  /**
   * Backends this app brings. One ships with the framework; a store whose url
   * names anything else is opened by whichever of these answers to its scheme.
   */
  drivers?: Driver[];
  /**
   * Turns text into vectors, for agents that remember into a vector store.
   *
   * Left out, the first model endpoint that names an `embeds` model is used, and where
   * none does nothing is embedded and recall is by words, as it always was.
   */
  embedder?: Embedder;
  /**
   * Scores what a store recalled by its words a second time, reading the question and
   * each candidate together.
   *
   * Left out, the first model endpoint that names a `reranks` model is used, and where
   * none does nothing is reordered.
   */
  reranker?: Reranker;
  /**
   * Where blobs are kept: large media held under the hash of its bytes and carried by
   * address. Left out, a plugin's `blobs` is used, and failing that a folder under the
   * app's state directory.
   */
  blobs?: BlobStore;
  /**
   * Where workflow telemetry goes. Every step emits an OTel GenAI-shaped span;
   * without a sink they fall on the floor, so an app wiring a real exporter
   * (Phoenix, LangSmith, a collector) hands the bridge in here.
   */
  emit?: (span: GenAiSpan) => void;
  /**
   * How approvals are signed, checked, and where they are allowed to arrive from.
   *
   * Left out, gates are attributed rather than non-repudiable and a `quorum`
   * above one is refused outright — praecise will not run a two-person rule it
   * has no way to count.
   */
  approvals?: Approvals;
  /**
   * The rule set every tool call answers to, asked after the guard on every path
   * a tool can be reached by. See `Authority`.
   */
  authority?: Authority;
  /**
   * Where each finished workflow step is sealed: hash-chained, signed when a
   * signer is given, and handed to the sink. See `Journal`.
   */
  journal?: Journal;
  /**
   * Who pays when a request answers 402. The injected fetch hands the demand to
   * it under the calling step's idempotency key and retries with the proof.
   */
  payer?: Payer;
  /**
   * Who this app says it is to the servers it calls. With it, every request leaving
   * through the injected fetch — tool calls and model calls — carries a Web Bot Auth
   * signature, and the dev server serves the key directory. Off unless passed.
   */
  botAuth?: BotSigner;
  /**
   * Who is told what runs do: started, waiting at a gate, done, failed, cancelled — as
   * CloudEvents, to a function or as a signed webhook (Standard Webhooks). The
   * events name the run and never carry what it produced. Delivery happens behind
   * the run and cannot fail it; one that does not arrive is listed in `problems`.
   */
  notify?: Notify;
  /**
   * Encrypts workflow runs at rest. Run files hold every step's output, so an app
   * whose steps touch anything private seals them.
   */
  runCipher?: RunCipher;
  /**
   * Where the app's work runs, when that can be snapshotted: each journalled
   * step names the snapshot it left, and recovery restores the latest one first.
   */
  sandbox?: Sandbox;
  /**
   * How many agent asks may be in flight at once. Default 8.
   *
   * A published app is reachable by whoever holds its token, and a model call is
   * the most expensive thing it can be asked for. Without a ceiling, N concurrent
   * requests are N concurrent completions and the only bound on the bill is how
   * fast the caller can open sockets.
   */
  askConcurrency?: number;
  /**
   * Longest input a single ask may carry, in characters. Default 200,000.
   *
   * The transport already caps a request body; this caps what is turned into a
   * prompt, which is the part that costs money.
   */
  maxInput?: number;
  /**
   * Where finished spans go.
   *
   * praecise emits OpenTelemetry GenAI spans and takes no opinion on the transport. The
   * dev server installs a small in-memory collector so a person can SEE what just
   * happened without configuring anything; a deployment hands over its own.
   */
  tracer?: Tracer;
  /**
   * Where a record of each exchange goes: what an agent was asked, what its tools
   * returned, what it answered. Called after the answer has been returned, and a
   * recorder that fails is listed in `problems` without failing anything. Left out,
   * `record: true` in the config keeps them as files under the state directory, which
   * is where `praecise capture` reads them from.
   */
  recorder?: Recorder;
  /**
   * Where the selves agents declare live, when the app brings its own provider
   * rather than configuring `selves` in praecise.config.ts.
   */
  selves?: SelfProvider;
  /**
   * What this app can do for the MCP servers it calls that a client cannot do alone:
   * answer a server that asks a person for something mid-call (`elicit`), and say that a
   * front end renders the interactive views tools bring (`apps`). Each is declared to a
   * server only when it is here, so a server never asks for what nothing can answer.
   */
  mcp?: McpHost;
}

/** An agent's plan with its memory and its self taken off, so nothing is read or left behind. */
const alone = (plan: AgentPlan): AgentPlan => ({
  ...plan,
  memory: false,
  memoryStore: undefined,
  memoryRecall: undefined,
  self: undefined,
});

/** Where recordings are kept, under the state directory. */
const RECORDINGS_DIR = "recordings";

/** How many answers may be waiting to be scored before new ones are let go unscored. */
const SCORING_BACKLOG = 32;

export class App {
  readonly root: string;
  readonly project: Project;
  readonly config: AppConfig;
  readonly plans: Record<string, AgentPlan>;
  readonly stateDir: string;
  readonly runs: RunStore;
  readonly stores: Stores;
  /** Large media, kept under the hash of its bytes and carried by address. */
  readonly blobs: BlobStore;
  /** Conversations, which sit here between turns rather than with the caller. */
  readonly threads: Threads;

  private readonly harness: Harness;
  private readonly notes: NoteBook;
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: typeof fetch;
  private readonly clients = new Map<string, Promise<ToolSource>>();
  private stepPlans = new Map<string, Promise<AgentPlan>>();
  private described?: Promise<Manifest>;
  private readonly emitSpan?: (span: GenAiSpan) => void;
  private readonly tracer?: Tracer;
  private readonly approvals: Approvals;
  private readonly authority?: Authority;
  private readonly journal?: Journal;
  private readonly sandbox?: Sandbox;
  private readonly notifier?: Notifier;
  private readonly asking: Gate;
  private readonly maxInput: number;
  private readonly selves?: SelvesRuntime;
  private readonly recorder?: Recorder;
  /** Work started after an answer was returned: recording it, scoring it. */
  private readonly background = new Set<Promise<void>>();
  /** One answer is scored at a time, so scoring never competes with itself for a model. */
  private readonly scoring = new Gate(1);
  private scoringWaiting = 0;
  /** The most recent recording or scoring that failed, as a sentence for an operator. */
  private observing?: string;
  private live?: Map<string, { suite: string; online: OnlineEval }[]>;
  /** The timer set for the next wait to run out, and when that is. */
  private alarm?: { timer: NodeJS.Timeout; at: number };
  private closed = false;
  private readonly mcpHost: McpHost;

  private readonly identity: { name?: string; version?: string };

  private constructor(init: {
    root: string;
    project: Project;
    plans: Record<string, AgentPlan>;
    harness: Harness;
    env: Record<string, string | undefined>;
    fetchImpl: typeof fetch;
    stores: Stores;
    blobs: BlobStore;
    threads: Threads;
    identity?: { name?: string; version?: string };
    emit?: (span: GenAiSpan) => void;
    tracer?: Tracer;
    approvals?: Approvals;
    authority?: Authority;
    journal?: Journal;
    runCipher?: RunCipher;
    sandbox?: Sandbox;
    notify?: { target: Notify; fetch: typeof fetch };
    askConcurrency?: number;
    maxInput?: number;
    selves?: SelvesRuntime;
    recorder?: Recorder;
    mcp?: McpHost;
  }) {
    this.recorder = init.recorder;
    this.mcpHost = init.mcp ?? {};
    this.authority = init.authority;
    this.journal = init.journal;
    this.sandbox = init.sandbox;
    this.selves = init.selves;
    this.identity = init.identity ?? {};
    this.emitSpan = init.emit;
    this.tracer = init.tracer;
    this.approvals = init.approvals ?? {};
    this.asking = new Gate(init.askConcurrency ?? 8);
    this.maxInput = init.maxInput ?? 200_000;
    this.root = init.root;
    this.project = init.project;
    this.config = init.project.config;
    this.plans = init.plans;
    this.harness = init.harness;
    this.env = init.env;
    this.fetchImpl = init.fetchImpl;
    this.stateDir = stateDirFor(init.root, init.project.config);
    this.notes = new NoteBook(this.stateDir);
    // Not the paying fetch: a receiver that answers 402 is not owed money.
    this.notifier = init.notify
      ? new Notifier(init.notify.target, { source: `/apps/${this.name}`, fetch: init.notify.fetch })
      : undefined;
    this.runs = new RunStore(resolve(this.stateDir, "runs"), {
      cipher: init.runCipher,
      onTransition: (change) => {
        // Every path that leaves a run waiting ends in a save, so this is the one
        // place a deadline can be seen being set.
        if (change.waitingFor?.until !== undefined) this.arm(change.waitingFor.until);
        this.notifier?.report(change);
        // Each on its own: one listener that throws must not cost the others the news.
        for (const listener of this.runWatchers) {
          try {
            listener(change);
          } catch {
            // The store drops what a listener throws for the same reason.
          }
        }
      },
    });
    this.threads = init.threads;
    this.stores = init.stores;
    this.blobs = init.blobs;
    for (const plan of Object.values(this.plans)) this.wired(plan);
  }

  /**
   * Give an agent's own functions the app's bus.
   *
   * A plan is made before there is an app, so the functions on it were wrapped
   * without anywhere to publish to. Done here, a function publishes the same way
   * whether a workflow step called it or a model did.
   */
  private wired(plan: AgentPlan): AgentPlan {
    for (const tool of plan.locals) {
      const spec = this.project.functions[tool.name];
      if (!spec) continue;
      tool.run = (args, during) =>
        spec.run(args, { publish: this.publisher(), ...(during?.signal ? { signal: during.signal } : {}) });
    }
    return plan;
  }

  /** `publish` as one call of a function is handed it. */
  private publisher(key?: string): Publish {
    let sent = 0;
    return async (type, data, rest = {}) => {
      // Named from the step where there is one, and from how many this call has
      // published, so a step that is retried publishes the same events again and
      // each finds the runs it already started.
      const id = rest.id ?? (key ? `${key}:${sent++}` : undefined);
      const event = cloudEvent(type, `/apps/${this.name}`, data, {
        ...(id ? { id } : {}),
        ...(rest.subject ? { subject: rest.subject } : {}),
      });
      return (await this.publish(event)).map((run) => ({ id: run.id, workflow: run.workflow, status: run.status }));
    };
  }

  /** Whether this app reports what its runs do, for a description of its events. */
  get notifies(): boolean {
    return Boolean(this.notifier);
  }

  static async load(options: AppOptions = {}): Promise<App> {
    const root = resolve(options.root ?? process.cwd());
    const project = await loadProject(root, { version: options.revision });
    return App.assemble(root, project, options);
  }

  /**
   * An app from a project already in hand, rather than one read from a folder.
   *
   * A folder is the usual way to describe an app and it is not the only one:
   * a project can be assembled in memory — generated, composed from parts, or
   * produced by a layer that decides the arrangement programmatically. Without
   * this, such a project is a value of the right type with nowhere to go, since
   * every other entry point here starts by reading a directory.
   *
   * `project.root` is used unless `options.root` overrides it. That path still
   * matters even when nothing was loaded from it: state, run records and store
   * files are written beneath it.
   */
  static from(project: Project, options: AppOptions = {}): Promise<App> {
    return App.assemble(resolve(options.root ?? project.root), project, options);
  }

  /** Everything after the project is in hand. Shared by `load` and `from`. */
  private static async assemble(
    root: string,
    project: Project,
    options: AppOptions,
  ): Promise<App> {
    const env = options.env ?? process.env;
    // Signing sits under paying, so the request that answers 402 and the one retried
    // with the proof are each signed, with their own nonce.
    const outbound = options.botAuth ? signingFetch(options.fetch ?? fetch, options.botAuth) : (options.fetch ?? fetch);
    const fetchImpl = options.payer ? payingFetch(outbound, options.payer) : outbound;

    // A plugin's setup runs before anything is planned: a request shape it registers has
    // to exist by the time an endpoint that speaks it is turned into rungs.
    await setupPlugins(project.config.plugins, (text) => project.warnings.push(text));
    const plans = await planProject(project, { env, prefer: options.prefer });
    const stores = new Stores(project.stores, {
      stateDir: stateDirFor(root, project.config),
      env,
      drivers: [...(options.drivers ?? []), ...(project.config.plugins ?? []).flatMap((plugin) => plugin.drivers ?? [])],
      reranker: options.reranker ?? rerankerFor(project.config.models, env, fetchImpl),
    });
    const blobs =
      options.blobs ??
      (project.config.plugins ?? []).find((plugin) => plugin.blobs)?.blobs ??
      diskBlobs(join(stateDirFor(root, project.config), "blobs"));
    // Made here rather than in the runtime, so that what answers a request and
    // what lists the conversations are the same conversations.
    const threads = new Threads(join(stateDirFor(root, project.config), "threads"));

    const selves = selvesFrom(project.config, env, fetchImpl, options.selves);
    const harness = await resolveHarness({
      selves,
      tracer: options.tracer,
      root,
      config: project.config,
      fetch: fetchImpl,
      stores,
      guard: project.guard,
      // The app's own first, then each plugin's in the order the config lists them.
      hooks: composeHooks([project.hooks, ...(project.config.plugins ?? []).map((plugin) => plugin?.hooks)]),
      authority: options.authority,
      trustOf: (service) => project.tools[service]?.trust ?? "untrusted",
      planFor: (agent) => plans[agent],
      embedder: options.embedder ?? embedderFor(project.config.models, env, fetchImpl),
      blobs,
      threads,
      env,
      WebSocket: options.WebSocket,
      host: options.mcp,
    });

    return new App({
      root,
      project,
      plans,
      harness,
      env,
      fetchImpl,
      stores,
      blobs,
      threads,
      identity: { name: options.name, version: options.version },
      emit: options.emit,
      tracer: options.tracer,
      approvals: options.approvals,
      authority: options.authority,
      journal: options.journal,
      runCipher: options.runCipher,
      sandbox: options.sandbox,
      notify: options.notify ? { target: options.notify, fetch: options.fetch ?? fetch } : undefined,
      askConcurrency: options.askConcurrency,
      maxInput: options.maxInput,
      selves,
      recorder:
        options.recorder ??
        (project.config.record
          ? new Recordings(join(stateDirFor(root, project.config), RECORDINGS_DIR)).recorder
          : undefined),
      mcp: options.mcp,
    });
  }

  get name(): string {
    return this.identity.name ?? this.project.name;
  }

  /** What this app calls itself when published. */
  get version(): string {
    return this.identity.version ?? this.config.version ?? "0.1.0";
  }

  get agentNames(): string[] {
    return Object.keys(this.plans).sort();
  }

  get workflowNames(): string[] {
    return Object.keys(this.project.workflows).sort();
  }

  /** Everything that is wrong but not fatal: bad files, missing credentials. */
  get problems(): string[] {
    return [
      ...this.project.warnings,
      ...Object.values(this.plans).flatMap((plan) =>
        plan.problems.map((problem) => `${plan.name}: ${problem}`),
      ),
      ...(this.notifier?.failure ? [`notify: ${this.notifier.failure}`] : []),
      ...(this.observing ? [this.observing] : []),
    ];
  }

  /**
   * The problems that mean this is not the app on disk: a file that would not
   * load, a spec that cannot run.
   *
   * Separate from `problems` because a command needs to answer two different
   * questions with it. "Is there anything worth mentioning" is what the
   * dashboard shows; "did I actually load what I was pointed at" is what decides
   * an exit code, and a missing description must never be allowed to answer the
   * second one — nor a missing credential, which is a fact about this machine
   * rather than about the app.
   */
  get faults(): string[] {
    return this.project.faults ?? [];
  }

  /**
   * Read back an agent's record and propose what it should carry forward.
   *
   * Nothing is adopted here. The proposal lands beside the record for someone
   * to look at, and the record itself is left exactly as it was.
   */
  async propose(agent: string): Promise<Candidate> {
    const plan = this.plans[agent];
    if (!plan) throw new Error(`no agent named "${agent}"`);

    const candidate = await consolidate(this.harness, plan, await this.remembering(plan).all(agent));
    await this.notes.propose(candidate);
    return candidate;
  }

  /** The record an agent kept, oldest first. What was said, not what it learned. */
  recorded(agent: string, limit?: number): Promise<Episode[]> {
    const plan = this.plans[agent];
    if (!plan) throw new Error(`no agent named "${agent}"`);
    return this.remembering(plan).all(agent, limit);
  }

  /**
   * Take one exchange back, leaving a note where it was.
   *
   * The record still shows that something happened and when. What it no longer
   * shows is what was said, and the agent will not answer from it again.
   */
  redact(agent: string, id: string, note: string): Promise<boolean> {
    const plan = this.plans[agent];
    if (!plan) throw new Error(`no agent named "${agent}"`);
    if (!note.trim()) throw new Error("redacting leaves a note behind: say what to leave");
    return this.remembering(plan).redact(agent, id, note);
  }

  /** Files unless the agent named a store — the rule the runtime follows too. */
  private remembering(plan: AgentPlan): Recollection {
    const name = plan.memoryStore;
    if (!name) return new Memory(this.stateDir);
    return new StoredMemory(() => this.stores.open(name));
  }

  /** The proposal waiting on an agent, if there is one. */
  pending(agent: string): Promise<Candidate | undefined> {
    return this.notes.pending(agent);
  }

  /** Adopt a proposal, in whole or by position. */
  accept(agent: string, keep?: number[]): Promise<Note[]> {
    return this.notes.accept(agent, keep);
  }

  /** Throw a proposal away. */
  reject(agent: string): Promise<void> {
    return this.notes.reject(agent);
  }

  /** What an agent currently carries into every conversation. */
  learned(agent: string): Promise<Note[]> {
    return this.notes.notes(agent);
  }

  /**
   * What an ask must be true of before any of it costs anything.
   *
   * Both bounds live here rather than at the transport because both are about
   * spend, not about bytes: the size of the prompt and how many prompts are in
   * flight. A caller that can reach `ask` at all can otherwise open as many as it
   * likes, each carrying as much as the body limit allows.
   */
  private admit(agent: string, input: string): AgentPlan {
    const plan = this.plans[agent];
    if (!plan) throw new Error(`no agent named "${agent}"`);
    if (input.length > this.maxInput) {
      throw new Error(
        `that input is ${input.length.toLocaleString()} characters and "${agent}" takes at most ` +
          `${this.maxInput.toLocaleString()}. Shorten it, or raise \`maxInput\` if this app really is meant to be asked ` +
          `questions that long — every character of it is paid for on the way in.`,
      );
    }
    return plan;
  }

  /**
   * A verdict on an answer a self gave, with the ticket the answer carried.
   *
   * Where the app binds tickets to people, the ticket must have been issued to
   * `person`; a ticket issued to somebody else reads exactly like one that has
   * expired, so a rating cannot be made on another person's answer.
   */
  async rate(ticket: string, verdict: SelfVerdict, person?: string): Promise<void> {
    if (!this.selves) throw new Error("this app has no self provider");
    const raw = this.selves.ticketSecret ? openTicket(this.selves.ticketSecret, ticket, person) : ticket;
    if (!raw) throw new Error("that answer can no longer be rated");
    await this.selves.provider.outcome(raw, verdict);
  }

  /** Ask an agent. Recall and persistence happen inside the harness. */
  async ask(agent: string, input: string, options: AskOptions = {}): Promise<Answer> {
    const plan = this.admit(agent, input);
    const sampled = this.onlineFor(agent).filter(({ online }) => Math.random() < online.sample);
    if (!this.recorder && !sampled.length) return this.asking.run(() => this.asked(plan, agent, input, options));

    // What the tools return is written down as it happens; a caller's own tape still
    // hears every call and still answers the ones it means to.
    const kept = this.recorder ? recordingTape() : undefined;
    const tape = kept
      ? {
          ...(options.tape?.play ? { play: options.tape.play.bind(options.tape) } : {}),
          record: (call: { name: string; args: unknown }, result: { text: string; failed: boolean }) => {
            kept.tape.record!(call, result);
            options.tape?.record?.(call, result);
          },
        }
      : options.tape;

    // An answer that will be scored needs one trace to be scored in. A request that
    // arrived inside a trace already has it; otherwise the request gets one here, with
    // a span of its own for the model and tool calls to sit under.
    const minted = sampled.length > 0 && !options.trace;
    const trace: TraceContext | undefined = minted
      ? { traceId: newTraceId(), spanId: newSpanId() }
      : options.trace;
    const started = Date.now();
    const root = (answer?: Answer, err?: unknown): void => {
      if (!minted || !trace) return;
      this.tracer?.({
        name: `invoke_agent ${agent}`,
        kind: "internal",
        traceId: trace.traceId,
        spanId: trace.spanId,
        startTime: started,
        endTime: Date.now(),
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.provider.name": "praecise",
          "gen_ai.agent.name": agent,
          ...(answer
            ? {
                "gen_ai.usage.input_tokens": answer.usage.inputTokens,
                "gen_ai.usage.output_tokens": answer.usage.outputTokens,
              }
            : {}),
          ...(err ? { "error.type": (err as Error)?.constructor?.name ?? "Error" } : {}),
        },
        status: err ? { code: "error", message: safeMessage(err, "ask") } : { code: "ok" },
      });
    };

    let answer: Answer;
    try {
      answer = await this.asking.run(() =>
        this.asked(plan, agent, input, { ...options, ...(tape ? { tape } : {}), ...(trace ? { trace } : {}) }),
      );
    } catch (err) {
      root(undefined, err);
      throw err;
    }
    root(answer);

    // Filler is not something the agent said: there is nothing to keep and nothing to score.
    if (answer.placeholder) return answer;

    if (kept) {
      const partial =
        options.thread !== undefined || options.history?.length
          ? "it was a turn of a conversation, and what came before it was not kept"
          : options.attachments?.length
            ? "something was sent with the question, and it was not kept"
            : undefined;
      this.later("recording an exchange", () =>
        this.recorder!({
          id: newRecordingId(),
          at: started,
          agent,
          input,
          answer: answer.text,
          ...(answer.data !== undefined ? { data: answer.data } : {}),
          tools: kept.tools.slice(),
          ...(partial ? { partial } : {}),
          ...(trace ? { traceId: trace.traceId } : {}),
        }),
      );
    }

    for (const { suite, online } of sampled) {
      // Sampling is already a decision to score some and not others; under load the
      // ones that would only queue are among the others.
      if (this.scoringWaiting >= SCORING_BACKLOG) break;
      this.scoringWaiting++;
      this.later(`scoring an answer against eval "${suite}"`, () =>
        this.scoring
          .run(() => this.score(suite, online, agent, input, answer, trace!))
          .finally(() => void this.scoringWaiting--),
      );
    }
    return answer;
  }

  /** The suites that score this agent's live answers. Read once: a reload builds a new app. */
  private onlineFor(agent: string): { suite: string; online: OnlineEval }[] {
    if (!this.live) {
      this.live = new Map();
      for (const [suite, spec] of Object.entries(this.project.evals ?? {})) {
        // A suite the loader faulted is not half-used: its graders are the part in doubt.
        if (!spec.online || spec.agent === undefined || evaluationFaults(suite, spec).length) continue;
        this.live.set(spec.agent, [...(this.live.get(spec.agent) ?? []), { suite, online: spec.online }]);
      }
    }
    return this.live.get(agent) ?? [];
  }

  /**
   * Start something that follows an answer and must not hold it up or fail it.
   *
   * What goes wrong is written down for `problems`, with the detail in the log.
   */
  private later(what: string, work: () => void | Promise<void>): void {
    const task: Promise<void> = Promise.resolve()
      .then(work)
      .catch((err) => {
        this.observing = `${what} failed at ${new Date().toISOString()}: ${safeMessage(err, what)}. The answer itself was returned as usual.`;
      })
      .finally(() => void this.background.delete(task));
    this.background.add(task);
  }

  /** Score one returned answer, report it on its trace, and tell `notify` if it fell short. */
  private async score(
    suite: string,
    online: OnlineEval,
    agent: string,
    input: string,
    answer: Answer,
    parent: TraceContext,
  ): Promise<void> {
    const context = scoringContext(parent);
    const startTime = Date.now();
    const scored = await scoreAnswer(suite, agent, online, input, answer, (rubric, material, lender) =>
      this.judging(rubric, material, lender, context),
    );
    this.tracer?.(evaluationSpan(scored, { context, parent, startTime, endTime: Date.now() }));
    if (scored.below && scored.score !== undefined && online.threshold !== undefined) {
      this.notifier?.score({ suite, agent, score: scored.score, threshold: online.threshold, trace: parent.traceId });
    }
  }

  /** Ask the judge the workflows use, told it may answer "unknown". */
  private async judging(rubric: string, material: string, agent?: string, trace?: TraceContext): Promise<Verdict> {
    const lender = agent ? this.plans[agent] : undefined;
    if (agent && !lender) throw new Error(`no agent named "${agent}"`);
    const plan = lender ?? (await this.planFor({ kind: "workflow", name: "eval", steps: [] }, undefined, "balanced"));
    return judgeClaim(this.harness, alone(plan), rubric, material, { abstain: true, ...(trace ? { trace } : {}) });
  }

  /**
   * Resolves once everything started behind an answer has finished: recordings
   * written, sampled answers scored, and what `notify` was told delivered.
   */
  async settled(): Promise<void> {
    while (this.background.size) await Promise.all(this.background);
    await this.notifier?.settled();
  }

  /**
   * Turn what was recorded into eval cases: an agent's exchanges, or a workflow's
   * finished runs, most recent `last` (default 20).
   *
   * Nothing is written here. The cases come back for the caller to look at, and
   * `praecise capture` is what puts them in `evals/`.
   */
  async capture(
    name: string,
    options: { last?: number; mode?: ReferenceMode } = {},
  ): Promise<{
    target: { agent: string } | { workflow: string };
    cases: EvalCase[];
    skipped: { id: string; why: string }[];
  }> {
    const last = options.last ?? 20;
    if (!(Number.isInteger(last) && last >= 1)) throw new Error(`last is ${String(last)}; it has to be a whole number, 1 or more`);

    if (this.plans[name]) {
      const kept = await new Recordings(join(this.stateDir, RECORDINGS_DIR)).read(name, { last });
      if (!kept.length) {
        throw new Error(
          `nothing has been recorded for "${name}". Set \`record: true\` in praecise.config.ts, ask it something, and capture again.`,
        );
      }
      return { target: { agent: name }, ...casesFromRecordings(kept, options.mode) };
    }
    if (this.project.workflows[name]) {
      const runs = (await this.runs.list())
        .filter((run) => run.workflow === name)
        .sort((a, b) => a.startedAt - b.startedAt)
        .slice(-last);
      if (!runs.length) throw new Error(`workflow "${name}" has no runs on record to capture`);
      return { target: { workflow: name }, ...casesFromRuns(runs, options.mode) };
    }
    const known = [...this.agentNames, ...this.workflowNames];
    throw new Error(`no agent or workflow named "${name}" (known: ${known.join(", ") || "none"})`);
  }

  /**
   * Ask an agent many questions as a batch.
   *
   * Each is asked exactly as `ask` would ask it — middleware, guard, memory, the
   * agent's whole ladder — and the requests they make of a model are handed over
   * together through each endpoint's batch API, where it has one. That is cheaper and
   * slower: a batch is answered when the endpoint gets to it, which may be minutes or
   * hours. Answers come back in the order asked, and a question that failed has its
   * error where its answer would be, without failing the rest.
   *
   * The whole batch is one request as far as how many may be in flight is concerned.
   */
  async askMany(agent: string, asks: readonly (string | Asking)[], options: BatchOptions = {}): Promise<Batched[]> {
    const each = asks.map((one) => (typeof one === "string" ? { input: one, options: {} } : { input: one.input, options: one.options ?? {} }));
    const plan = this.plans[agent];
    if (!plan) throw new Error(`no agent named "${agent}"`);
    return this.asking.run(() => {
      // A runtime that does not batch still answers: one at a time, as it always has.
      const batch = this.harness.batch?.(options);
      const ask = batch ? batch.ask.bind(batch) : this.harness.ask.bind(this.harness);
      return Promise.all(
        each.map(async ({ input, options: asked }): Promise<Batched> => {
          try {
            return { answer: await this.asked(this.admit(agent, input), agent, input, asked, ask) };
          } catch (error) {
            return { error: error instanceof Error ? error : new Error(String(error)) };
          }
        }),
      );
    });
  }

  /**
   * Open a live session with an agent: a conversation over one connection, for voice.
   *
   * Read what happens with `for await`, say things with `send`, cut the model off with
   * `interrupt`, and `close` it when done. The agent's tools are served through the
   * guard and the authority as they are in `ask`. Middleware is not: it wraps a request
   * and its reply, and a session is neither.
   */
  async open(agent: string, options: OpenOptions = {}): Promise<Session> {
    const plan = this.plans[agent];
    if (!plan) throw new Error(`no agent named "${agent}"`);
    if (!this.harness.open) throw new Error(`the "${this.harness.name}" runtime does not open live sessions`);
    return this.harness.open(plan, options);
  }

  private async asked(
    plan: AgentPlan,
    agent: string,
    input: string,
    options: AskOptions,
    ask: Harness["ask"] = this.harness.ask.bind(this.harness),
  ): Promise<Answer> {
    const wrapper = this.project.middleware;
    if (!wrapper) return ask(plan, input, options);

    // Middleware may substitute the reply, so the answer is rebuilt around what
    // it returns while keeping the accounting from the call that really ran.
    let answer: Answer | undefined;
    const reply = await wrapper.run(
      { agent, input, quality: plan.quality },
      async () => {
        answer = await ask(plan, input, options);
        return { text: answer.text, data: answer.data };
      },
    );

    if (!answer) {
      return {
        text: reply.text,
        data: reply.data,
        path: [],
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, decidingTokens: 0 },
        toolCalls: [],
        harness: "middleware",
      };
    }
    return { ...answer, text: reply.text, data: reply.data };
  }

  /**
   * Ask an agent and read what happens in order, ending in `done` or `failed`.
   *
   * Middleware may replace the text of a reply after the fact, and a fragment
   * already handed over cannot be replaced. So where one is installed the work
   * is still reported as it happens and only the answer waits until it is
   * final; without one, text arrives as it is written.
   */
  async *watch(agent: string, input: string, options: AskOptions = {}): AsyncGenerator<Progress> {
    // Refused before the stream opens rather than after, so an over-long input
    // fails as an error the caller can read instead of as a stream that says one
    // thing and stops.
    const plan = this.admit(agent, input);

    const held = Boolean(this.project.middleware);
    const through: Harness = {
      name: this.harness.name,
      ask: (_plan, text, opts) => this.ask(agent, text, opts),
    };

    for await (const event of stream(through, plan, input, options)) {
      if (held && event.kind === "text") continue;
      yield event;
    }
  }

  /**
   * Call a local function or `service.tool` directly, as a `use` step does.
   *
   * `opts.idempotencyKey` is passed through to the tool — into MCP `_meta` for a
   * remote call, as the function's second argument for a local one — so the
   * exactly-once contract a `use` step derives the key for is honoured by the
   * framework's own wiring, not just documented.
   *
   * The app's guard is asked first, exactly as it is before a model's tool call:
   * a `use` step, the HTTP function routes and the MCP surface all arrive here,
   * and a guard that only covered the model path would be a fence with a gate
   * left open. Unlike the model path — where a refusal is worded for the model
   * to read and route around — a direct call has no model to reason with, so a
   * refusal is thrown and the caller sees the guard's sentence as the error.
   */
  async callTool(
    ref: string,
    args: unknown,
    opts: {
      idempotencyKey?: string;
      /** How the call arrived. Defaults to "app" — a caller that did not say. */
      via?: "workflow" | "http" | "mcp" | "cli" | "app" | "ui";
      run?: string;
      step?: string;
      /** Untrusted output was read earlier in the run that is making this call. */
      tainted?: boolean;
      /** Verified approvals for this call, passed on to the authority. */
      approvals?: VerifiedApproval[];
      /** Aborts when whoever asked for this call no longer wants it. */
      signal?: AbortSignal;
    } = {},
  ): Promise<unknown> {
    const local = this.project.functions[ref];
    const input = (args ?? {}) as Record<string, unknown>;
    await this.permit(ref, local, input, opts);
    return this.dispatch(ref, local, input, opts.idempotencyKey, opts.approvals, { run: opts.run, step: opts.step, signal: opts.signal });
  }

  /**
   * Ask the guard and then the authority whether a call may be made, and throw what
   * either says if it may not.
   *
   * One function for every door a call can come through that is not a model's: a
   * workflow step, an HTTP route, the MCP endpoint, a view. Each names itself in `via`,
   * and each is refused in the same words by the same rules.
   */
  private async permit(
    ref: string,
    local: FunctionSpec | undefined,
    input: Record<string, unknown>,
    opts: {
      via?: Attempt["via"];
      run?: string;
      step?: string;
      tainted?: boolean;
      approvals?: VerifiedApproval[];
      /** What a remote tool's server said calling it does, where it said. */
      effect?: Effect;
    },
  ): Promise<void> {
    const guard = this.project.guard;
    if (!guard && !this.authority) return;

    let action: Attempt["action"];
    try {
      action = local?.action ? { ...local.action(input), ...(opts.tainted ? { tainted: true } : {}) } : undefined;
    } catch (err) {
      throw new Error(`Not allowed: the arguments do not describe an action ${ref} can take (${(err as Error).message})`, {
        cause: err,
      });
    }
    const attempt: Attempt = {
      agent: "app",
      tool: ref,
      origin: local ? "local" : "remote",
      effect: local?.effect ?? opts.effect,
      args: input,
      // Which door this came through. `agent: "app"` is the same for all of
      // them, so without this a guard cannot refuse an HTTP caller a tool it
      // happily gives a workflow step.
      via: opts.via ?? "app",
      ...(opts.run || opts.step ? { at: { run: opts.run, step: opts.step } } : {}),
      ...(action ? { action } : {}),
      ...(opts.tainted ? { tainted: true } : {}),
      ...(opts.approvals?.length ? { approvals: opts.approvals } : {}),
    };

    if (guard) {
      let said: string | undefined;
      try {
        said = await guard.run(attempt);
      } catch (err) {
        // Asked whether to act, the guard did not manage to say yes; the safe
        // reading of that is no.
        said = `Not allowed: ${(err as Error).message}`;
      }
      if (said?.trim()) throw new Error(said);
    }

    if (this.authority) {
      const verdict = await judge(this.authority, attempt);
      if ("refuse" in verdict) throw new Error(verdict.refuse);
      if ("stepUp" in verdict) throw new StepUpRequired(verdict.stepUp, verdict.digest);
    }
  }

  /**
   * A tool call made by an interactive view (an MCP App), on the view's own service.
   *
   * A view is a page some server wrote, running in a person's browser, and a call from
   * it is held to everything a model's call is and one thing more. The tool must be one
   * its server marked callable by views, and it is looked up on the service the view
   * came from and no other, so a page cannot reach across to a service it did not come
   * with. Then the guard and the authority are asked, under the name a model would have
   * called the tool by, with `via: "ui"`. What comes back is the server's result in the
   * protocol's own shape, because that is what a view is handed.
   */
  async callFromView(service: string, tool: string, args: unknown): Promise<McpToolResult> {
    const client = await this.viewClient(service);
    const listed = (await this.viewTools(client)).find((candidate) => candidate.name === tool);
    // The same sentence for a tool that does not exist and one a view may not call: a
    // page probing for what is there learns nothing from the difference.
    const visible = listed && (listed.ui?.visibility ?? ["model", "app"]).includes("app");
    if (!visible) throw new Error(`service "${service}" has no tool named "${tool}" that a view may call`);

    const input = (args ?? {}) as Record<string, unknown>;
    await this.permit(toolName(service, tool), undefined, input, { via: "ui", effect: effectOf(listed.annotations) });
    return (await client.invoke(tool, input)) ?? {};
  }

  /** A resource read by a view, from the service the view came from. */
  async readFromView(service: string, uri: string): Promise<McpResourceContents[]> {
    return (await this.viewClient(service)).readResource(uri);
  }

  /** The MCP client for a service a view names, or the reason there is none. */
  private async viewClient(service: string): Promise<McpClient> {
    // No view was ever handed out by an app that did not say a front end renders them,
    // so nothing calling in as one is a view.
    if (!this.mcpHost.apps) {
      throw new Error("this app hands out no views, so it takes no calls from one; pass `mcp: { apps: true }` where a front end renders them");
    }
    if (!this.project.tools[service]) throw new Error(`no service named "${service}" in this app`);
    const client = await this.clientFor(service);
    if (!(client instanceof McpClient)) throw new Error(`service "${service}" is an HTTP API and serves no views`);
    return client;
  }

  /** A service's tools as a view may see them, listed once per client. */
  private readonly viewLists = new WeakMap<McpClient, Promise<McpTool[]>>();
  private viewTools(client: McpClient): Promise<McpTool[]> {
    let listing = this.viewLists.get(client);
    if (!listing) {
      listing = client.listTools().then((tools) => {
        client.remember(tools);
        return tools;
      });
      this.viewLists.set(client, listing);
      listing.catch(() => this.viewLists.delete(client));
    }
    return listing;
  }

  /**
   * Be told when a workflow run changes state: started, waiting at a gate, done, failed.
   *
   * The same moments `notify` reports outward, for something inside the process that is
   * holding a connection open about a run. Returns the function that stops the telling.
   */
  onRunChange(listener: (change: RunTransition) => void): () => void {
    this.runWatchers.add(listener);
    return () => void this.runWatchers.delete(listener);
  }
  private readonly runWatchers = new Set<(change: RunTransition) => void>();

  private async dispatch(
    ref: string,
    local: FunctionSpec | undefined,
    input: Record<string, unknown>,
    idempotencyKey: string | undefined,
    approvals?: VerifiedApproval[],
    at: { run?: string; step?: string; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    // Only the idempotency key travels onward: where the call came from is the
    // guard's business, not something to put on a downstream wire.
    // The app's own fetch goes with it, so a function's requests leave through the
    // same door as everything else: paid on a 402, signed where the app signs.
    const passed = {
      idempotencyKey,
      fetch: this.fetchImpl,
      ...(approvals?.length ? { approvals } : {}),
      ...(at.signal ? { signal: at.signal } : {}),
    };
    // A local function is the app's own code, so it also learns which run and step
    // is calling, to key what it records, and is handed the app's bus; neither goes
    // onto a remote wire.
    if (local) {
      return local.run(input, {
        ...passed,
        ...(at.run !== undefined ? { run: at.run } : {}),
        ...(at.step !== undefined ? { step: at.step } : {}),
        publish: this.publisher(idempotencyKey),
      });
    }

    const split = splitToolName(ref) ?? refParts(ref);
    if (!split) throw new Error(`no function or tool named "${ref}"`);

    const client = await this.clientFor(split.service);
    return client.call(split.tool, input, passed);
  }

  /** Whether what a tool returns may be relied on: own functions by default, services not. */
  trustOf(ref: string): Trust {
    const local = this.project.functions[ref];
    if (local) return local.trust ?? "trusted";
    const split = splitToolName(ref) ?? refParts(ref);
    return (split && this.project.tools[split.service]?.trust) || "untrusted";
  }

  /** What a `plan` step may build from: every agent, function, and service tool. */
  private manifest(): Promise<Manifest> {
    return (this.described ??= this.describe());
  }

  private async describe(): Promise<Manifest> {
    const tools: Manifest["tools"] = Object.entries(this.project.functions).map(
      ([name, spec]) => ({ name, description: spec.description }),
    );
    for (const name of this.agentNames) {
      for (const tool of await this.toolsFor(name)) {
        if (!tools.some((known) => known.name === tool.name)) tools.push(tool);
      }
    }
    return {
      agents: this.agentNames.map((name) => ({
        name,
        description: this.plans[name]!.description,
      })),
      tools,
    };
  }

  private async clientFor(named: string): Promise<ToolSource> {
    // A model only ever saw the sanitised name, so that is what comes back on a call.
    // The project declares services under the author's spelling — "risk model" — and a
    // lookup by the sanitised form would miss and report the service as undeclared.
    // Exact first, so a name that never needed sanitising resolves unchanged.
    const service = this.project.tools[named]
      ? named
      : (Object.keys(this.project.tools).find((key) => serviceSegment(key) === named) ?? named);

    const existing = this.clients.get(service);
    if (existing) return existing;

    // Cached as the in-flight promise itself, synchronously, before anything here
    // awaits — not as the resolved client. A workflow's parallel seats (propose,
    // critique, verify all calling the same tool at once) were racing this
    // function: each read `existing` as undefined before any of them had reached
    // the `set` below, so each built and spawned its own stdio subprocess for
    // what was declared as one service, and every spawn past the first was never
    // reachable again to be closed. Caching the promise means every concurrent
    // caller for the same service awaits the one construction in flight.
    const building = (async (): Promise<ToolSource> => {
      const { services, problems } = resolveServices([service], this.project.tools, this.env);
      const resolved = services[0];
      if (!resolved) throw new Error(problems[0] ?? `unknown service "${service}"`);
      // A LAUNCHED server takes its secrets from the environment it inherits, so it was
      // never asked for a credential — and refusing it here for the want of one blamed the
      // author for omitting something nobody required. This is what made a stdio service
      // unreachable through `callTool`: the transport worked and the path to it did not.
      // A service that gets its token from a grant has no key to be missing either; if
      // the grant's own secrets are, that is the problem to report.
      if (this.project.tools[service]?.oauth && !resolved.oauth) {
        throw new Error(problems[0] ?? `service "${service}" declares \`oauth\` and its secrets are not set`);
      }
      if (!resolved.apiKey && !resolved.command?.length && !resolved.oauth) {
        throw new Error(`service "${service}" needs ${resolved.credential} to be set`);
      }

      // Which kind of service this is was decided when it was declared; here it is only
      // a named thing with tools.
      return resolved.openapi !== undefined
        ? new ApiClient(resolved, this.fetchImpl)
        : new McpClient(resolved, this.fetchImpl, undefined, this.mcpHost);
    })();
    this.clients.set(service, building);
    // A failed construction must not poison the cache — the next caller should
    // get a fresh attempt, not a permanently-rejected promise for a transient
    // failure (the tool's process crashing on launch, say).
    building.catch(() => this.clients.delete(service));
    return building;
  }

  private workflowDeps(spec: WorkflowSpec): WorkflowDeps {
    const planFor = (agent: string | undefined, quality?: AgentPlan["quality"]) =>
      this.planFor(spec, agent, quality);
    return {
      harness: this.harness,
      store: this.runs,
      limits: this.config.limits,
      callTool: (ref, args, opts) => this.callTool(ref, args, opts),
      trustOf: (ref) => this.trustOf(ref),
      actionOf: (ref, args) => {
        const local = this.project.functions[ref];
        try {
          return local?.action?.((args ?? {}) as Record<string, unknown>);
        } catch {
          return undefined;
        }
      },
      journal: this.journal,
      ...(this.sandbox
        ? {
            snapshot: (at: { run: string; step: string }) => this.sandbox!.snapshot(at),
            restore: (ref: string) => this.sandbox!.restore(ref),
          }
        : {}),
      planFor,
      // What the runner checks a step's `agent:` against before it starts. The
      // loader already diagnoses a step naming an agent nobody wrote; handing
      // over the registry is what lets the runner act on that diagnosis instead
      // of discovering it one paid step at a time.
      knownAgents: Object.keys(this.plans),
      // Workflow-level events reach BOTH sinks, and the bridge matters more than it
      // looks. `emit`/`GenAiSpan` predates the OpenTelemetry work here and describes what
      // a workflow did — plan, invoke_agent, invoke_workflow — as flat events with no
      // trace ids, so nothing can be joined to anything. `tracer` emits conformant spans
      // that can be.
      //
      // Feeding one into the other means a workflow run and the model calls its steps
      // made appear as ONE trace rather than two unrelated records of the same work,
      // which is the whole reason to have trace ids at all. The run id becomes the trace
      // id, so every step of a run groups under it.
      emit: (span) => {
        this.emitSpan?.(span);
        this.tracer?.({
          name: `${span.operation} ${span.name}`.trim(),
          kind: "internal",
          traceId: traceIdFor(span.step),
          spanId: newSpanId(),
          startTime: span.at,
          endTime: span.at + span.durationMs,
          attributes: {
            "gen_ai.operation.name": span.operation,
            "gen_ai.provider.name": "praecise",
            "praecise.step": span.step,
            ...span.attributes,
          },
          status: { code: "ok" },
        });
      },
      // Nothing is defaulted in. An app that wired no signer gets a ledger that
      // says so, and a quorum gate it cannot count is refused rather than run.
      sign: this.approvals.sign?.bind(this.approvals),
      verify: this.approvals.verify?.bind(this.approvals),
      approvalChannels: this.approvals.channels,
      provision: provisioner({
        harness: this.harness,
        // Laying out work is judgement, so it is asked at the workflow's own
        // quality rather than at the cheapest rung.
        planner: () => planFor(undefined, "best"),
        manifest: () => this.manifest(),
      }),
    };
  }

  /** The plan a step should run under. No agent named ⇒ a general-purpose one. */
  private planFor(
    spec: WorkflowSpec,
    agent: string | undefined,
    quality: AgentPlan["quality"] | undefined,
  ): Promise<AgentPlan> {
    if (agent) {
      const plan = this.plans[agent];
      if (!plan) return Promise.reject(new Error(`no agent named "${agent}"`));
      return Promise.resolve(plan);
    }

    const name = spec.name ?? "workflow";
    const key = `${name}:${quality ?? "-"}`;
    let pending = this.stepPlans.get(key);
    if (!pending) {
      pending = planWorkflowAgent(this.project, name, spec.knows, quality, { env: this.env }).then((plan) =>
        this.wired(plan),
      );
      this.stepPlans.set(key, pending);
    }
    return pending;
  }

  private workflowSpec(name: string): WorkflowSpec {
    const spec = this.project.workflows[name];
    if (!spec) throw new Error(`no workflow named "${name}"`);
    return spec;
  }

  /**
   * `opts.id` names the run before it starts, for a caller that has to hand the id to
   * someone else before the run has got anywhere. A run already recorded under that id
   * is returned as it stands, not started again. `opts.signal` cancels the run: it
   * stops where it is and is recorded as `cancelled`.
   */
  async startWorkflow(
    name: string,
    input: Record<string, unknown>,
    opts: { id?: string; signal?: AbortSignal } = {},
  ): Promise<Run> {
    const spec = this.workflowSpec(name);
    return startRun(spec, input, this.workflowDeps(spec), opts);
  }

  /**
   * Stop a run and record it as `cancelled`: one in flight is interrupted where
   * it stands, one waiting at a gate or for an event is ended there. A run that
   * had already finished is returned as it finished. See `cancelRun`.
   */
  cancelWorkflow(runId: string, why: { reason?: string; by?: string } = {}): Promise<Run> {
    return cancelRun(runId, { store: this.runs }, why);
  }

  /**
   * Start a run of `workflow` for every event `source` yields, until `signal`
   * aborts. Continues after the last stored cursor; an event delivered twice
   * finds the run it already started. `input` turns an event into the run's input.
   */
  async follow(
    source: Source,
    workflow: string,
    opts: { signal: AbortSignal; input?: (event: unknown) => Record<string, unknown>; onRun?: (run: Run) => void },
  ): Promise<void> {
    const spec = this.workflowSpec(workflow);
    const cursors = new CursorFile(resolve(this.stateDir, "sources"));
    const after = await cursors.read(source.name);
    for await (const { cursor, event } of source.subscribe(after, opts.signal)) {
      if (opts.signal.aborted) break;
      const input = opts.input ? opts.input(event) : { event };
      const run = await startRun(
        spec,
        { ...input, source: { name: source.name, cursor } },
        this.workflowDeps(spec),
        { id: runIdFor(spec.name ?? workflow, source.name, cursor) },
      );
      await cursors.write(source.name, cursor);
      opts.onRun?.(run);
    }
  }

  /**
   * Hand one event to `workflow`: continue the run of it that is waiting for this
   * event, or, when none is, start a run for it.
   *
   * A run stopped at a `wait` step that the event matches is continued, once; a
   * second delivery of the same event finds that run and does nothing more. With
   * nothing waiting, a run is started and named from where the event came from and
   * its id there, which the envelope guarantees is unique — so an event delivered
   * twice, as anything that retries will eventually do, finds the run the first
   * delivery started. The workflow receives the event's `data` as `event`, and
   * `type`, `subject` and `time` beside it.
   */
  async deliver(workflow: string, event: CloudEvent): Promise<Run> {
    const runs = await this.delivered(workflow, event);
    return runs[0]!;
  }

  /** `deliver`, answering with every run the event continued and not only the first. */
  private async delivered(workflow: string, event: CloudEvent): Promise<Run[]> {
    const spec = this.workflowSpec(workflow);
    const name = spec.name ?? workflow;
    const continued = await this.continued(event, (run) => run.workflow === name);
    if (continued.length) return continued;
    // Continued by an earlier delivery of this event, and no longer waiting for it.
    const taker = await this.runs.eventTaker(name, event.source, event.id);
    const took = taker ? await this.runs.load(taker) : undefined;
    if (took) return [took];
    return [await this.started(spec, workflow, event)];
  }

  private started(spec: WorkflowSpec, workflow: string, event: CloudEvent): Promise<Run> {
    return startRun(
      spec,
      {
        event: event.data ?? event.data_base64,
        type: event.type,
        ...(event.subject ? { subject: event.subject } : {}),
        ...(event.time ? { time: event.time } : {}),
        source: { name: event.source, cursor: event.id },
      },
      this.workflowDeps(spec),
      { id: runIdFor(spec.name ?? workflow, event.source, event.id) },
    );
  }

  /** Continue every waiting run the event is for and `wanted` allows, one after another. */
  private async continued(event: CloudEvent, wanted: (run: Run) => boolean): Promise<Run[]> {
    const runs: Run[] = [];
    for (const mark of await this.runs.waiting()) {
      if (mark.type !== event.type) continue;
      const run = await this.runs.load(mark.run);
      if (!run || !wanted(run) || !awaits(run, event)) continue;
      const spec = this.project.workflows[run.workflow];
      if (!spec) continue;
      const went = await signalRun(run.id, event, spec, this.workflowDeps(spec));
      if (went) runs.push(went);
    }
    return runs;
  }

  /**
   * Continue the runs that are waiting for this event, and start nothing.
   *
   * Every run stopped at a `wait` step the event matches is continued, each once.
   * Answers with those runs as they stand when each has stopped again; an empty
   * list means nothing was waiting for it, and the event is not kept.
   */
  signal(event: CloudEvent): Promise<Run[]> {
    return this.continued(event, () => true);
  }

  /**
   * Put an event on the app's bus.
   *
   * Each workflow that declared `on` for the event's type is handed it exactly as
   * `deliver` would — a waiting run of it continues, otherwise one starts — and
   * every other run waiting for the event continues. Answers with those runs once
   * each has stopped. An event nobody subscribed to or is waiting for goes nowhere.
   *
   * This is the same door an event from outside comes in by, so the same holds:
   * `source` and `id` name the run, and publishing an event twice does its work once.
   * A chain of runs publishing to each other is refused past sixteen deep, which
   * is what a workflow that publishes what it subscribes to runs into.
   */
  async publish(event: CloudEvent): Promise<Run[]> {
    const hops = (depth.getStore() ?? 0) + 1;
    if (hops > MOST_HOPS) {
      throw new Error(
        `the event ${event.type} was published ${MOST_HOPS} events deep, which is a loop and not a chain: ` +
          `a workflow here is started by an event that its own work publishes again. ` +
          `Give the event that ends the work a different type from the one that starts it.`,
      );
    }
    return depth.run(hops, async () => {
      const runs: Run[] = [];
      const told = new Set<string>();
      for (const name of this.workflowNames) {
        const spec = this.project.workflows[name]!;
        if (!subscriptionsOf(spec).includes(event.type)) continue;
        told.add(spec.name ?? name);
        runs.push(...(await this.delivered(name, event)));
      }
      runs.push(...(await this.continued(event, (run) => !told.has(run.workflow))));
      return runs;
    });
  }

  /**
   * End every wait whose time is up, and set a timer for the next one.
   *
   * A run waiting for an event is a file, and nothing in a file notices the
   * time. While the app is held, a timer does; this is what the timer calls, and
   * what whoever holds the app calls when it starts, for the waits that ran out
   * while nothing was running. A deadline is therefore honoured no earlier than
   * it falls and no later than the next moment a process holds the app.
   */
  async expire(now: number = Date.now()): Promise<Run[]> {
    const ended: Run[] = [];
    let next: number | undefined;
    for (const mark of await this.runs.waiting()) {
      if (mark.until === undefined) continue;
      if (mark.until > now) {
        next = Math.min(next ?? mark.until, mark.until);
        continue;
      }
      const run = await this.runs.load(mark.run);
      const spec = run ? this.project.workflows[run.workflow] : undefined;
      if (!run || !spec) continue;
      const went = await timeoutRun(run.id, spec, this.workflowDeps(spec), { now });
      if (went) ended.push(went);
    }
    if (next !== undefined) this.arm(next);
    return ended;
  }

  /** Make sure a timer is set no later than `until`. */
  private arm(until: number): void {
    if (this.closed || (this.alarm && this.alarm.at <= until)) return;
    if (this.alarm) clearTimeout(this.alarm.timer);
    const timer = setTimeout(
      () => {
        this.alarm = undefined;
        // What goes wrong ending a wait is on the run it went wrong for.
        void this.expire().catch(() => undefined);
      },
      Math.min(Math.max(0, until - Date.now()), LONGEST_TIMER),
    );
    // A wait is not a reason to keep a process alive: a command that started a
    // run and has printed where it stopped should exit.
    timer.unref();
    this.alarm = { timer, at: until };
  }

  async resumeWorkflow(runId: string, decision: ApprovalDecision, opts: { signal?: AbortSignal } = {}): Promise<Run> {
    const run = await this.runs.load(runId);
    if (!run) throw new Error(`no such run: ${runId}`);
    const spec = this.workflowSpec(run.workflow);
    return resumeRun(runId, decision, spec, this.workflowDeps(spec), opts);
  }

  /**
   * Re-drive a run whose driving process died mid-flight. Calling this asserts
   * the old driver is gone — see `recoverRun` for the contract, including when
   * `retryInflight` is safe to pass.
   */
  async recoverWorkflow(runId: string, opts: { retryInflight?: boolean } = {}): Promise<Run> {
    const run = await this.runs.load(runId);
    if (!run) throw new Error(`no such run: ${runId}`);
    const spec = this.workflowSpec(run.workflow);
    return recoverRun(runId, spec, this.workflowDeps(spec), opts);
  }

  /**
   * Run this app's evals: one suite by name, or all of them.
   *
   * Every trial is asked as though nothing had been asked before. An agent's
   * own plan is used with its memory and its self taken off, so a trial neither
   * reads what an earlier one left nor leaves anything for the next — and an
   * eval run on a Tuesday does not become something the agent "remembers" on
   * Wednesday. No trial is given a thread. Middleware, the guard and the
   * authority all still apply: they are part of what the app does.
   *
   * A workflow run is a real run. Its record is kept under `runs` like any
   * other, and a `use` step does what it does — evaluate a workflow whose
   * functions have side effects against somewhere those effects are harmless.
   */
  async evaluate(suite?: string, options: EvalOptions = {}): Promise<EvalReport> {
    const evals = this.project.evals ?? {};
    const names = Object.keys(evals).sort();
    if (suite !== undefined && !evals[suite]) {
      throw new Error(`no eval named "${suite}" (known: ${names.join(", ") || "none"})`);
    }
    if (!names.length) {
      throw new Error(
        "this app has no evals. Add a file to `evals/` that does `export default evaluation({ agent, cases })`.",
      );
    }
    // A suite that only scores live answers has nothing to run. Named, that is said;
    // among all of them, it is left out.
    const runnable = (name: string): boolean => !evals[name]!.online || evals[name]!.cases?.length > 0;
    if (suite !== undefined && !runnable(suite)) {
      throw new Error(`eval "${suite}" has no cases to run; it only scores live answers, through \`online\``);
    }
    const chosen = suite !== undefined ? [suite] : names.filter(runnable);
    if (!chosen.length) {
      throw new Error("this app's evals only score live answers, through `online`; none has cases to run");
    }

    // The loader said this already; what is new here is acting on it. The
    // names are checked again because only the app knows what else it holds.
    const known = { agents: this.agentNames, workflows: this.workflowNames };
    const faults = chosen.flatMap((name) => evaluationFaults(name, evals[name]!, known));
    if (faults.length) throw new Error(`these evals cannot run as written:\n  ${faults.join("\n  ")}`);

    const target: EvalTarget = {
      ask: async (agent, input, recorded) => {
        const plan = alone(this.admit(agent, input));
        if (!recorded) return this.asking.run(() => this.asked(plan, agent, input, {}));
        // A replay: the tools answer from the recording, and none of them is run.
        const { tape, misses } = replayTape(recorded);
        const answer = await this.asking.run(() => this.asked(plan, agent, input, { tape }));
        return misses.length ? { ...answer, notes: [...(answer.notes ?? []), ...new Set(misses)] } : answer;
      },
      run: async (name, input) => {
        const spec = this.workflowSpec(name);
        const deps = this.workflowDeps(spec);
        const run = await startRun(spec, input, {
          ...deps,
          planFor: async (agent, quality) => alone(await deps.planFor(agent, quality)),
        });
        return answerOfRun(spec, run);
      },
      judge: (rubric, material, agent) => this.asking.run(() => this.judging(rubric, material, agent)),
    };

    return runEvaluations(chosen.map((name) => ({ ...evals[name]!, name })), target, options);
  }

  /**
   * Install a blueprint, writing whatever it produces as ordinary files.
   *
   * A blueprint that ships files is copied. One that only states an intent is
   * worked out against this app's own description, which is what makes it
   * possible at all: there is a known set of parts, not a blank page.
   */
  async add(
    name: string,
    options: { force?: boolean } = {},
  ): Promise<WriteResult & { notes: string[] }> {
    const spec = this.project.blueprints[name];
    if (!spec) throw new Error(`no blueprint named "${name}"`);

    const missing = (spec.needs ?? []).filter((need) => {
      const { services } = resolveServices([need], this.project.tools, this.env);
      return !services[0]?.apiKey;
    });

    let files = spec.files ?? [];
    const notes = missing.map((need) => `"${need}" will not work until its credential is set`);

    if (!files.length) {
      const derived = await deriveFiles(spec, {
        describes: await this.describeInProse(),
        examples: await this.styleExamples(),
        ask: async (question) => (await this.harness.ask(await this.blueprintPlan(), question)).text,
      });
      files = derived.files;
      notes.push(...derived.notes);
    }

    return { ...(await writeFiles(this.root, files, options)), notes };
  }

  private blueprintPlan(): Promise<AgentPlan> {
    return this.planFor(
      { kind: "workflow", name: "blueprint", steps: [] },
      undefined,
      "best",
    );
  }

  /** The app in prose, for a blueprint to build against. */
  private async describeInProse(): Promise<string> {
    const manifest = await this.manifest();
    const lines = [
      `The app is called "${this.name}".`,
      manifest.agents.length
        ? `Agents:\n${manifest.agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")}`
        : "It has no agents yet.",
      manifest.tools.length
        ? `Tools and functions:\n${manifest.tools.map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ""}`).join("\n")}`
        : "",
      this.workflowNames.length ? `Workflows: ${this.workflowNames.join(", ")}` : "",
      Object.keys(this.project.stores).length
        ? `Stores:\n${Object.entries(this.project.stores)
            .map(([name, spec]) => `- ${name}: a ${spec.of} store`)
            .join("\n")}`
        : "",
    ];
    return lines.filter(Boolean).join("\n\n");
  }

  /** One existing agent and one workflow, so generated code matches the house style. */
  private async styleExamples(): Promise<FileContents[]> {
    const picks = [
      this.agentNames[0] ? `agents/${this.agentNames[0]}.ts` : undefined,
      this.workflowNames[0] ? `workflows/${this.workflowNames[0]}.ts` : undefined,
    ].filter((path): path is string => Boolean(path));

    const files: FileContents[] = [];
    for (const path of picks) {
      const contents = await readFile(resolve(this.root, path), "utf8").catch(() => undefined);
      if (contents !== undefined) files.push({ path, contents });
    }
    return files;
  }

  /** Live tool schemas for an agent — used by the dashboard, not the ask path. */
  async toolsFor(agent: string): Promise<{ name: string; description?: string }[]> {
    const plan = this.plans[agent];
    if (!plan) return [];
    const { schemas } = await collectTools(plan.services, this.fetchImpl);
    return schemas.map(({ name, description }) => ({ name, description }));
  }

  /**
   * A declared store, opened on first ask.
   *
   * For a store declared with a schema, name its record to have reads typed:
   * `app.store<RecordOf<typeof tickets>>("tickets")`.
   */
  store<M extends object = Meta, In extends object = M>(name: string): Promise<Store<M, In>> {
    return this.stores.open<M, In>(name);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.alarm) clearTimeout(this.alarm.timer);
    this.alarm = undefined;
    // Reports still on their way are let finish; each is bounded, so this is too.
    await this.settled();
    await this.harness.close?.();
    await this.stores.close();
    // Every tool client this app ever built is a launched process (stdio) or, for
    // an API client, nothing to stop — either way `close()` is required rather
    // than assumed, and the app is exactly what tracks every one that was made.
    // Left uncalled, a stdio client's subprocess outlives this app.
    const pending = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(pending.map((building) => building.then((client) => client.close(), () => undefined)));
  }
}

/** `service.tool_name` — the form a workflow author writes. */
function refParts(ref: string): { service: string; tool: string } | undefined {
  const at = ref.indexOf(".");
  if (at <= 0) return undefined;
  return { service: ref.slice(0, at), tool: ref.slice(at + 1) };
}
