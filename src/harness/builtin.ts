/**
 * The built-in runtime.
 *
 * It decides which model should answer before spending anything, asks it, and asks again
 * when the first attempt turns out to have been guessing. How that is decided is in
 * src/harness/routing.ts; what is here is the spending. Tool calling and memory are the
 * rest of it. It has no dependencies and needs nothing installed alongside it.
 *
 * The order of the asking again is the constraint this file exists to hold. MORE ROOM ON
 * THE SAME MODEL COMES BEFORE ANOTHER MODEL, always, because the first is one call on a
 * prefix cache that is already warm and the second is one call on a cache that cannot be.
 * `attempts` is that order written down before anything is spent, and every escalation
 * path below moves through it rather than picking a rung of its own.
 *
 * Which escalation a given failure earns is not uniform, and the differences are the
 * point rather than special cases:
 *
 *   an endpoint that did not answer   → cross. Depth cannot fix a 500.
 *   a refusal                         → cross. Longer thought buys a better-argued no.
 *   a shape that would not parse,
 *   or a tool that errored            → more depth. Free evidence, cheapest repair.
 *   two answers that disagree         → more depth if there is any, else cross.
 *
 * And the check pays for itself where it can. When the next escalation is more depth on
 * the same model, the second answer of the comparison is DRAWN at that depth — so one
 * call buys the comparison and, if it goes badly, the escalated answer along with it.
 * Repeating the same question k times buys only the comparison; `SAMPLES` in
 * src/harness/routing.ts has the arithmetic showing how badly that trade goes.
 */

import { handleFor, renderSelf, signTicket, type AnswerSelf, type SelvesRuntime } from "./selves.js";
import { join } from "node:path";

import type { AgentPlan, LocalTool, Rung } from "../compile/plan.js";
import { DEFAULT_TURNS, narrowKnowledge, schemaFromReturns } from "../compile/plan.js";
import { READ_KNOWLEDGE } from "../compile/outline.js";
import { READ_SKILL } from "../compile/skills.js";
import type { Action, Attempt, Effect, GuardSpec, HooksSpec, Preference, Quality, Recent, Trust } from "../define.js";
import { judge, stepUpSentence, type Authority } from "../authority.js";
import { ShapeError, shapeOf } from "../schema.js";
import { CODE_TOOL, SiloExecutor, bindingsFor, codeTool, typesFor } from "./codemode.js";
import type { Store } from "../stores/types.js";
import { budgetFor, type Budget } from "./budget.js";
import { addCost, amountOf, charge, type Price } from "./cost.js";
import { COMPACTING, fit, recentOf } from "./context.js";
import { CallLimitReached, MeterRefused, Tally, meteredCall, type CallPurpose, type Meter } from "./meter.js";
import { SENT_BACK, compactingAs, objectionTo, recordingFor, sentBack, shownFor } from "./hooks.js";
import {
  ADVICE_ROOM,
  ADVISING,
  CONSULT,
  READ_RESULT,
  Crew,
  Shelf,
  consultTool,
  crewTools,
  delegateTool,
  finderTools,
  readResultTool,
  redirected,
  tooManyToList,
  type Work,
} from "./faculties.js";
import { serviceSegment,
  collectResources,
  collectTools,
  resolveService,
  splitToolName,
  type ToolSource,
} from "./mcp.js";
import { traced, type TraceContext, type Tracer } from "./trace.js";
import { NoteBook, renderNotes } from "./consolidate.js";
import type { Embedder } from "./embed.js";
import { attachedIn, show, takesOf } from "./modality.js";
import { SkillBook, renderSkills } from "./procedure.js";
import { Memory, StoredMemory, renderRecall, type Recollection } from "./memory.js";
import {
  Ledger,
  consensusOf,
  divergence,
  ladderFrom,
  route,
  type Faults,
  type Shape,
} from "./routing.js";
import { Threads } from "./threads.js";
import type {
  Answer,
  AskCaller,
  AskOptions,
  Asking,
  Batch,
  Batched,
  Attachment,
  ChatAdapter,
  ChatRequest,
  ChatResponse,
  Harness,
  Message,
  Progress,
  ToolCall,
  ToolSchema,
  ToolTape,
  Usage,
} from "./types.js";
import { ProviderError } from "./types.js";
import { LiveSession, type OpenOptions } from "./session.js";
import { sessionFor, type Session, type SocketConstructor } from "./wire/session.js";
import { Batcher, type BatchOptions, type Seat } from "./wire/batch.js";
import { Uploads } from "./wire/files.js";
import { adapterFor } from "./wire/index.js";

/** How many agents deep one request may go when the app does not say. */
const MAX_DEPTH = 3;

/** What a model may write when asked for notes on work in progress. */
const SUMMARY_ROOM = 4_096;

/** The longest an endpoint's own "try again in" is honoured for. Past this, another model is quicker. */
const PATIENCE_MS = 30_000;

/** What a request may call, and what is known about each of them. */
interface Equipped {
  locals: LocalTool[];
  /** What the model is shown. */
  schemas: ToolSchema[];
  /** Tools held back from the list, reachable through `use_tool`. */
  held: ReadonlySet<string>;
  effects: ReadonlyMap<string, Effect | undefined>;
  /** Set when the request was narrowed: a tool not among `effects` is then refused, not looked for. */
  closed: boolean;
}

/** Where an ask that is part of a batch carries its place at the pile. Not a caller's to set. */
const SEAT = Symbol("praecise.batch.seat");
type Seated = AskOptions & { [SEAT]?: Seat };

/** Where an ask carries the count of model calls its request has made. Set by the runtime, shared with every agent the request reaches. */
const TALLY = Symbol("praecise.request.tally");
type Tallied = AskOptions & { [TALLY]?: Tally };

/**
 * Where an ask carries the lists it has been narrowed to. Filled from `AskOptions.allow`
 * by the runtime, and handed on to every agent the request reaches, so nothing a request
 * was not allowed is reachable by asking another agent for it.
 */
const NARROW = Symbol("praecise.request.narrow");
interface Narrowed {
  tools: ReadonlySet<string>[];
  knows: (readonly string[])[];
}
type Bounded = AskOptions & { [NARROW]?: Narrowed };

/** Tools the runtime adds to read what an agent was given. They follow what is left, and are not named in a list. */
const READERS: ReadonlySet<string> = new Set([READ_KNOWLEDGE, READ_SKILL]);

/**
 * Whether every list a request was narrowed by lets this tool through.
 *
 * A list names a tool as the agent's `tools` does — a function, an agent, a service —
 * or one tool of a service as a model calls it. A service named lets all of its tools
 * through.
 */
function permitted(name: string, lists: readonly ReadonlySet<string>[]): boolean {
  if (!lists.length) return true;
  const service = splitToolName(name)?.service;
  return lists.every(
    (list) =>
      list.has(name) ||
      (service !== undefined && [...list].some((entry) => entry === service || serviceSegment(entry) === service)),
  );
}

/** Whether every list lets this whole service through, which is what a program run against it needs. */
function serviceAllowed(service: string, lists: readonly ReadonlySet<string>[]): boolean {
  return lists.every((list) => [...list].some((entry) => entry === service || serviceSegment(entry) === service));
}

/** Whether a failure is the app ending the request, as opposed to a model failing to answer it. */
const ends = (error: unknown): boolean => error instanceof MeterRefused || error instanceof CallLimitReached;

/** What a rung that hears is told when it writes a recording down for one that does not. */
const TRANSCRIBING =
  "You are transcribing a recording for a reader who cannot hear it. Write down what is said, word for word, " +
  "in the language it is said in, naming a speaker only where the recording makes it plain. Where there is no " +
  "speech, say in one line what can be heard. Add nothing else.";

/** Below this much difference, a stronger model said what the cheaper one said. */
const SAME_ANSWER = 0.25;

const blank = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  decidingTokens: 0,
});

function add(into: Usage, from: ChatResponse["usage"] & Pick<Usage, "cost" | "unpricedTokens">): void {
  addCost(into, from.cost);
  if (from.unpricedTokens) into.unpricedTokens = (into.unpricedTokens ?? 0) + from.unpricedTokens;
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cachedTokens += from.cachedTokens;
  // Reported only where an endpoint reported them, so an answer from one that says
  // nothing about either does not claim a zero it never measured.
  if (from.cacheWriteTokens) into.cacheWriteTokens = (into.cacheWriteTokens ?? 0) + from.cacheWriteTokens;
  if (from.reasoningTokens) into.reasoningTokens = (into.reasoningTokens ?? 0) + from.reasoningTokens;
}

const spent = (usage: { inputTokens: number; outputTokens: number }): number =>
  usage.inputTokens + usage.outputTokens;

/**
 * Count one reply against a total: its tokens, and what they cost where the rung that
 * wrote it has a price. `mixed` says another rung of the same ladder has one, which is
 * when tokens that could not be priced are worth counting — the cost is then known to
 * be short by them.
 */
function count(into: Usage, reply: ChatResponse["usage"], price: Price | undefined, mixed = false): void {
  add(into, reply);
  if (price) charge(into, price, reply);
  else if (mixed) into.unpricedTokens = (into.unpricedTokens ?? 0) + spent(reply);
}

interface Parsed {
  text: string;
  data?: unknown;
  note?: string;
  /** What was wrong with it, where it was held to a declared shape and failed. */
  issues?: string[];
}

/** Strip markdown fences some models wrap JSON in. */
function unfence(text: string): string {
  const fenced = text.match(/^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/);
  return fenced?.[1] ?? text;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

/**
 * Read a rung's reply. A model is asked for an answer and nothing else — never
 * for an answer wrapped in a report on how it feels about the answer.
 */
function parseReply(raw: string, wantsData: boolean): Parsed {
  const text = unfence(raw).trim();
  if (!wantsData) return { text };
  try {
    return { text, data: JSON.parse(text) as unknown };
  } catch {
    return { text, note: "expected JSON but the reply was not valid JSON" };
  }
}

export interface BuiltinOptions {
  /** Where memory files and the routing record live. */
  stateDir: string;
  fetch?: typeof fetch;
  /** Declared stores, for an agent that remembers into one instead. */
  stores?: { open(name: string): Promise<Store> };
  /** Asked before every tool call, where the app wrote one. */
  guard?: GuardSpec;
  /** Asked after the guard, where the app has one. */
  authority?: Authority;
  /** Asked after a tool runs, before an agent stops, and before a transcript is summarised. */
  hooks?: HooksSpec;
  /** Whether a service's outputs may be relied on; services default to untrusted. */
  trustOf?: (service: string) => Trust;
  /**
   * Where conversations are kept. Files under the state directory unless the
   * app says otherwise — and made once above here, so the runtime and whoever
   * is listing conversations are looking at the same ones.
   */
  threads?: Threads;
  /** Refuse rather than answer with a placeholder. See `AppConfig.strict`. */
  strict?: boolean;
  /**
   * How patient to be with an endpoint that is merely busy. See `Limits.retries` and
   * `Limits.retryDelay`; the defaults are the values that were fixed here before.
   */
  retries?: number;
  retryDelay?: number;
  /** What this deployment values when cost and quality pull apart. See `AppConfig.preference`. */
  preference?: Preference;
  /**
   * Share of routing decisions to randomise, so the record can be read back. See
   * `EXPLORATION` for the value to use and for why nothing is randomised unless somebody
   * asks. Zero, and therefore off, unless set.
   */
  explore?: number;
  /** Where the exploration coin comes from. Injectable so a test is a test. */
  random?: () => number;
  /**
   * Where finished spans go — the real OpenTelemetry SDK, a file, a collector, nothing.
   *
   * praecise emits spans in the GenAI semantic convention and takes no opinion on the
   * transport, because every deployment already has one and adding the OTel SDK as a
   * dependency would be the largest thing in this package by a wide margin.
   */
  tracer?: Tracer;
  /** Where the selves agents declare live, and how strictly to depend on them. */
  selves?: SelvesRuntime;
  /** The plan for another agent of this app, for an agent that names one in `tools`. */
  planFor?: (agent: string) => AgentPlan | undefined;
  /** Turns text into a vector, for an agent that remembers into a vector store. */
  embedder?: Embedder;
  /** How many agents deep one request may go. See `Limits.depth`. Default 3. */
  depth?: number;
  /** Asked before every model call, and told what each cost. See `Meter`. */
  meter?: Meter;
  /** How many model calls one request may make when it does not say. See `Limits.calls`. */
  calls?: number;
  /**
   * What a live session is opened over. The runtime's own `WebSocket` unless given —
   * injectable for the reason `fetch` is, and for a runtime whose own cannot send the
   * headers a server-side session authenticates with.
   */
  WebSocket?: SocketConstructor;
}

/**
 * Whether a failure says "not now" rather than "not this model".
 *
 * A rate limit and a server fault are both temporary properties of an endpoint, not
 * judgements about a rung's competence. Treating them as a reason to climb inverts the
 * economics of the whole ladder: load is exactly when limits are hit, so the cheap rung
 * sheds traffic to the expensive one at the busiest moment, and the bill arrives having
 * been caused by the mechanism meant to control it.
 */
function transient(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  // A limit that is about money rather than about the moment does not clear by waiting,
  // and an endpoint that sends one says so in words and sends no time to wait.
  if (error.status === 429 && !error.retryAfter && /spend_limit|insufficient_quota|billing/i.test(error.body)) {
    return false;
  }
  return error.status === 429 || (error.status >= 500 && error.status < 600);
}

/** Attempts against one rung before its failure counts as the rung's, not the moment's. */
const RETRIES = 2;

/**
 * How long to wait before the first of those.
 *
 * Deliberately short — this default assumes a rate limit clearing, not an outage being
 * waited out, and a request holding a user is not the place to be patient. A deployment
 * whose endpoint is busy for a different reason says so in `limits.retryDelay`: an
 * endpoint that serves one request at a time is busy for as long as the one ahead takes,
 * which is nothing like the same scale.
 */
const BACKOFF_MS = 200;

/**
 * How long to wait, doubling, with jitter.
 *
 * Jitter is not decoration: without it every request that hit the same limit retries at
 * the same instant and rebuilds the spike that caused it.
 */
const backoff = (attempt: number, base: number): number =>
  base * 2 ** attempt * (0.5 + Math.random());

/** Cheapest first, which is the order a ladder is climbed in. */
const TIER_ORDER = new Map<Quality, number>([
  ["fast", 0],
  ["balanced", 1],
  ["best", 2],
]);
const rankOf = (tier: Quality): number => TIER_ORDER.get(tier) ?? 0;

/**
 * The rungs a request may use, given a ceiling it asked for.
 *
 * Returns the plan's own rungs untouched when no ceiling was asked for or the ceiling is
 * at or above what the agent already declares — the common case, and it must cost nothing.
 *
 * When a ceiling does bind, everything at or below it survives. If that leaves nothing —
 * an agent whose cheapest rung is already above the ceiling — the cheapest single rung is
 * kept rather than returning an empty ladder, because "you asked for cheap so you get no
 * answer at all" serves nobody.
 */
export function ceilingFor(plan: AgentPlan, ceiling: Quality | undefined): AgentPlan["rungs"] {
  if (!ceiling) return plan.rungs;
  const limit = rankOf(ceiling);
  const kept = plan.rungs.filter((rung) => rankOf(rung.tier) <= limit);
  if (kept.length) return kept;
  const cheapest = [...plan.rungs].sort((a, b) => rankOf(a.tier) - rankOf(b.tier))[0];
  return cheapest ? [cheapest] : [];
}

/**
 * The ladder a request may actually walk, given both bounds.
 *
 * The ceiling is applied FIRST and the floor is clamped to what survives it.
 * Order matters: a caller that names a floor above its own ceiling is asking
 * for something incoherent, and the safe reading of that is the ceiling --
 * never an empty ladder (which would fail the request) and never the floor
 * (which would let a floor defeat the ceiling, and the ceiling is the bound
 * that protects the operator's wallet).
 *
 * When the floor removes every remaining rung, the DEAREST of them is kept
 * rather than nothing: the caller asked to start high, and the top of what it
 * is allowed is the closest honest answer to that. This mirrors the ceiling
 * falling back to the cheapest.
 */
export function boundsFor(
  plan: AgentPlan,
  ceiling: Quality | undefined,
  floor: Quality | undefined,
): AgentPlan["rungs"] {
  const underCeiling = ceilingFor(plan, ceiling);
  if (!floor || !underCeiling.length) return underCeiling;
  const lowest = rankOf(floor);
  const kept = underCeiling.filter((rung) => rankOf(rung.tier) >= lowest);
  if (kept.length) return kept;
  const dearest = [...underCeiling].sort((a, b) => rankOf(b.tier) - rankOf(a.tier))[0];
  return dearest ? [dearest] : [];
}

export class BuiltinHarness implements Harness {
  readonly name = "builtin";

  private readonly memory: Memory;
  private readonly notes: NoteBook;
  private readonly skills: SkillBook;
  private readonly ledger: Ledger;
  readonly threads: Threads;
  private readonly stores?: { open(name: string): Promise<Store> };
  private readonly stored = new Map<string, StoredMemory>();
  private readonly fetchImpl: typeof fetch;
  private readonly guard?: GuardSpec;
  private readonly authority?: Authority;
  private readonly hooks?: HooksSpec;
  private readonly trustOf?: (service: string) => Trust;
  private readonly strict: boolean;
  private readonly retries: number;
  private readonly retryDelay: number;
  private readonly preference: Preference;
  private readonly explore: number;
  private readonly random?: () => number;
  /**
   * Where finished spans go, if anywhere.
   *
   * Injected like every other outbound thing here. Absent, `traced` does no work at all —
   * tracing that costs something when nobody is listening is tracing people turn off.
   */
  private readonly tracer?: Tracer;
  private readonly selves?: SelvesRuntime;
  private readonly planFor?: (agent: string) => AgentPlan | undefined;
  private readonly maxDepth: number;
  private readonly meter?: Meter;
  private readonly maxCalls?: number;
  private readonly embedder?: Embedder;
  /** What a live session is opened over, where the app supplied one. */
  private readonly socket?: SocketConstructor;
  /** The names endpoints have given for large attachments uploaded to them. */
  private readonly uploads = new Uploads();
  /** Tool discovery is per-agent and reused across requests. */
  private readonly toolCache = new Map<
    string,
    Promise<{ schemas: ToolSchema[]; clients: Map<string, ToolSource>; notes: string[] }>
  >();

  constructor(options: BuiltinOptions) {
    this.memory = new Memory(options.stateDir);
    this.notes = new NoteBook(options.stateDir);
    this.skills = new SkillBook(options.stateDir);
    this.ledger = new Ledger(options.stateDir);
    this.threads = options.threads ?? new Threads(join(options.stateDir, "threads"));
    this.stores = options.stores;
    this.fetchImpl = options.fetch ?? fetch;
    this.guard = options.guard;
    this.authority = options.authority;
    this.hooks = options.hooks;
    this.trustOf = options.trustOf;
    this.strict = options.strict ?? false;
    // A count of zero is a deployment saying not to retry at all, so it is taken as
    // given rather than read as absent.
    this.retries = options.retries ?? RETRIES;
    this.retryDelay = options.retryDelay ?? BACKOFF_MS;
    this.preference = options.preference ?? "balanced";
    this.explore = options.explore ?? 0;
    this.random = options.random;
    this.tracer = options.tracer;
    this.selves = options.selves;
    this.planFor = options.planFor;
    this.embedder = options.embedder;
    this.socket = options.WebSocket;
    this.maxDepth = options.depth ?? MAX_DEPTH;
    this.meter = options.meter;
    this.maxCalls = options.calls;
  }

  /**
   * One model call, made the only way this runtime makes one: counted against the
   * request it belongs to, and put to the app's meter first.
   *
   * Every path that reaches a model goes through here — a rung's turns, the samples
   * that check an answer, a summary, an advisor, a transcription — so that a limit on
   * calls and a meter's refusal hold for all of them and not for the ones somebody
   * remembered.
   */
  private call(
    rung: Rung,
    request: ChatRequest,
    purpose: CallPurpose,
    agent: string,
    options: AskOptions,
  ): Promise<ChatResponse> {
    return meteredCall(
      this.meter,
      (options as Tallied)[TALLY] ?? new Tally(options.maxCalls ?? this.maxCalls),
      {
        agent,
        purpose,
        provider: rung.provider,
        model: rung.model,
        rung: rung.tier,
        price: rung.price,
        output: rung.output,
        caller: options.caller,
        context: options.context,
      },
      request,
      this.adapter(rung, options),
    );
  }

  /**
   * The names of everything an agent was given to act through, and of everything the
   * agents it may ask were given: its functions, the agents it names, its services.
   */
  private reach(plan: AgentPlan, seen: Set<string> = new Set()): Set<string> {
    const names = new Set<string>();
    if (seen.has(plan.name)) return names;
    seen.add(plan.name);
    for (const local of plan.locals) if (!READERS.has(local.name)) names.add(local.name);
    for (const service of plan.services) {
      names.add(service.name);
      names.add(serviceSegment(service.name));
    }
    for (const delegate of plan.delegates ?? []) {
      names.add(delegate.name);
      const other = this.planFor?.(delegate.name);
      if (other) for (const name of this.reach(other, seen)) names.add(name);
    }
    return names;
  }

  /** Files unless the agent named a store, and only if there are stores to name. */
  private remembering(plan: AgentPlan): Recollection {
    const name = plan.memoryStore;
    if (!name || !this.stores) return this.memory;
    let backed = this.stored.get(name);
    if (!backed) {
      const stores = this.stores;
      backed = new StoredMemory(() => stores.open(name), this.embedder);
      this.stored.set(name, backed);
    }
    return backed;
  }

  private tools(plan: AgentPlan) {
    let pending = this.toolCache.get(plan.name);
    if (!pending) {
      // What the services offer. The agent's own functions, and the tools the runtime
      // adds, are put in front of these per request — see `equip`.
      pending = collectTools(plan.services, this.fetchImpl).then((found) => {
        if (!plan.code) return found;
        // Code mode: the bound services become one typed API behind a single
        // `code` tool; what cannot be bound stays a tool of its own.
        const { bindings, bound, http, direct } = bindingsFor(plan.services, plan.code.allow);
        const isDirect = (name: string) => {
          const split = splitToolName(name);
          return !!split && !bound.has(split.service) && direct.some((d) => serviceSegment(d.name) === split.service);
        };
        const clients = new Map(found.clients);
        if (bindings.length) clients.set(CODE_TOOL, new SiloExecutor(bindings, plan.code));
        return {
          ...found,
          clients,
          schemas: [
            ...(bindings.length ? [codeTool(typesFor(found.schemas, bound, http), plan.code.language)] : []),
            ...found.schemas.filter((s) => isDirect(s.name)),
          ],
        };
      });
      this.toolCache.set(plan.name, pending);
    }
    return pending;
  }

  /**
   * Stop every tool client this harness ever built.
   *
   * `toolCache` is deliberately per-agent — two seats reaching the same declared
   * service are two separate transports on purpose (an isolated seat is the whole
   * point of a critique or verify role), so a run with several seats calling the
   * same external tool legitimately opens several clients. What was missing was
   * this: nothing ever stopped any of them. Every distinct seat that ever called a
   * stdio tool leaked its subprocess for the life of the process, because `close`
   * did not exist on this harness at all — `App.close()`'s `this.harness.close?.()`
   * was silently a no-op here.
   */
  async close(): Promise<void> {
    const cached = [...this.toolCache.values()];
    this.toolCache.clear();
    await Promise.all(
      cached.map((pending) =>
        pending.then(
          ({ clients }) => Promise.all([...clients.values()].map((client) => client.close())),
          () => undefined,
        ),
      ),
    );
  }

  /**
   * What to do when there is no model to ask.
   *
   * Three different situations arrive here and only one of them is benign, so
   * they are answered differently rather than all being given the same cheerful
   * paragraph:
   *
   * An app that was pointed at endpoints and cannot reach any of them refuses,
   * whatever anything is configured to prefer. That is a mistyped key or an
   * unset variable in something already deployed, and the failure mode this
   * fixes is precisely a production app returning confident invented prose and
   * reporting success. Nobody chose that, so nothing may opt into it.
   *
   * An app in strict mode refuses too, because it asked to be refused.
   *
   * An app that has never been configured gets the friendly answer — a folder
   * five minutes old should do something — but the answer says on its face what
   * it is, and carries `placeholder: true` so a caller reading it as data can
   * tell without reading English.
   */
  private unanswered(plan: AgentPlan, usage: Usage): Answer {
    if (plan.unreachable?.length) {
      throw new Error(
        `agent "${plan.name}" has model endpoints configured and could not reach any of them: ` +
          `${plan.unreachable.join("; ")}. Set the credential, or take the endpoint out of ` +
          `praecise.config.ts. Refusing to answer with placeholder text, which would be reported ` +
          `as a real answer by everything downstream.`,
      );
    }
    if (this.strict) {
      throw new Error(
        `agent "${plan.name}" has no model endpoint, and this app is strict. ` +
          `Set PRAECISE_API_KEY to run on Praecise Cloud, or add \`models\` to praecise.config.ts. ` +
          `(Unset \`strict\`, or PRAECISE_STRICT, to get a placeholder answer instead.)`,
      );
    }
    return {
      text:
        "No model endpoint is configured, so this is a placeholder response — nothing read " +
        "the question and nothing answered it. Set PRAECISE_API_KEY, or add `models` to " +
        "praecise.config.ts, then ask again.",
      path: [],
      usage,
      toolCalls: [],
      harness: "offline",
      placeholder: true,
      notes: ["running offline: no model credential found, so this answer is placeholder text"],
    };
  }

  async ask(plan: AgentPlan, input: string, options: AskOptions = {}): Promise<Answer> {
    // Agents this request starts in the background belong to it, and end with it
    // however it ends: nothing would read what one came back with afterwards.
    const crew = new Crew();
    try {
      return await this.respond(plan, input, options, crew);
    } finally {
      crew.stopAll();
    }
  }

  private async respond(plan: AgentPlan, input: string, asked: AskOptions, crew: Crew): Promise<Answer> {
    const usage = blank();
    // One count of model calls for the whole request. An agent this one asks is handed
    // the same count, so a limit on a request holds however many agents it reaches.
    // What the request has been narrowed to so far, by the agents above this one. This
    // agent's own list is added below, once what it has is known.
    const above = (asked as Bounded)[NARROW];
    const narrow: Narrowed = { tools: [...(above?.tools ?? [])], knows: [...(above?.knows ?? [])] };
    const options: AskOptions = {
      ...asked,
      [TALLY]: (asked as Tallied)[TALLY] ?? new Tally(asked.maxCalls ?? this.maxCalls),
      [NARROW]: narrow,
    } as AskOptions;

    // Everything worth telling a developer afterwards is also worth telling an
    // interface now, so the two are the same list written to twice.
    const report = options.onProgress;
    const notes: string[] = [];
    const note = (text: string): void => {
      notes.push(text);
      report?.({ kind: "note", text });
    };

    if (!plan.rungs.length) return this.unanswered(plan, usage);

    // A caller-supplied ceiling trims the ladder before the router sees it, so escalation
    // still works exactly as it does otherwise — it simply has nowhere above this to go.
    // Trimming rather than selecting keeps every cheaper rung available, which is the
    // whole point of a ladder.
    const allowed = boundsFor(plan, options.ceiling, options.floor);
    if (!allowed.length) return this.unanswered(plan, usage);
    if (allowed.length < plan.rungs.length) {
      // Both bounds are reported, because "or below" alone was misleading the
      // moment a floor existed: a caller reading that line while the cheapest
      // rung answered could not tell whether its floor had been honoured.
      const said = [
        options.ceiling ? `"${options.ceiling}" or below` : null,
        options.floor ? `"${options.floor}" or above` : null,
      ].filter(Boolean).join(" and ");
      note(`answering at ${said}, as the caller asked`);
    }
    plan = allowed.length === plan.rungs.length ? plan : { ...plan, rungs: allowed };

    // What fits, divided once. Every rung of a ladder is the same endpoint, so
    // the first one is as good as any to ask how much room there is.
    const budget = budgetFor(plan.rungs[0]!.room);

    const { schemas: offered, clients, notes: toolNotes } = await this.tools(plan);
    for (const text of toolNotes) note(text);

    // What this request may use of what the agent has. A list from above was checked
    // against the agent it was written for, so here it only ever takes away; this
    // request's own list is checked against this agent, and a name it does not have is
    // refused outright rather than read as nothing.
    for (const names of narrow.knows) plan = narrowKnowledge(plan, names, false).plan;
    if (asked.allow?.knows) {
      const fewer = narrowKnowledge(plan, asked.allow.knows);
      plan = fewer.plan;
      for (const text of fewer.notes) note(text);
      narrow.knows.push(asked.allow.knows);
    }
    if (asked.allow?.tools) {
      // What this agent has, and what the agents it may ask have: a list holds them
      // too, so it has to be able to name what it leaves them.
      const has = new Set<string>([...this.reach(plan), ...offered.map((schema) => schema.name)]);
      const beyond = new Set<string>();
      for (const delegate of plan.delegates ?? []) {
        const other = this.planFor?.(delegate.name);
        if (other) for (const name of this.reach(other, new Set([plan.name]))) beyond.add(name);
      }
      const known = (name: string): boolean => {
        if (has.has(name) || beyond.has(name)) return true;
        // One tool of a service an agent further down uses, which is not listed until that agent runs.
        const service = splitToolName(name)?.service;
        return service !== undefined && beyond.has(service) && !has.has(service);
      };
      const unknown = asked.allow.tools.filter((name) => !known(name));
      if (unknown.length) {
        throw new Error(
          `agent "${plan.name}" has no tool called ${unknown.map((name) => `"${name}"`).join(", ")}, so a request cannot allow it. ` +
            `\`allow\` only narrows what an agent, and the agents it may ask, already have` +
            (has.size ? `: ${[...has].join(", ")}.` : ", and this one has no tools."),
        );
      }
      narrow.tools.push(new Set(asked.allow.tools));
    }

    // Once anything untrusted has been read in this ask, every later action in it
    // may carry values that text put there. Kept across rungs: a climb does not
    // forget what the conversation already contains.
    const taint = { tainted: Boolean(options.tainted) };
    /** Results too long for the transcript, kept whole for as long as this request lasts. */
    const shelf = new Shelf();
    const equipped = this.equip(plan, offered, budget, shelf, usage, taint, options, crew);
    const schemas = equipped.schemas;

    // An agent that is a self has one memory, its self's; plan.memory is refused
    // beside `self` at load, and nothing below reads or writes a second record.
    const remembering = this.remembering(plan);
    const recalled = plan.memory && !plan.self
      ? await remembering.recall(plan.name, input, plan.memoryRecall).catch(() => {
          note("could not read memory");
          return [];
        })
      : [];
    const recall = renderRecall(recalled, budget.recall);
    const learned = plan.memory && !plan.self ? renderNotes(await this.notes.notes(plan.name)) : "";
    // Procedures an agent has been given and a person has accepted — a WAY of doing
    // something, as opposed to a fact it has learned. They were being written to a store
    // and read by nothing, which made the whole fourth memory type write-only: an agent
    // could accumulate procedures it was never able to use. `skills()` returns only what
    // cleared the acceptance floor, so nothing unreviewed reaches a prompt.
    const procedures = plan.memory && !plan.self ? renderSkills(await this.skills.skills(plan.name)) : "";
    // What the services this agent uses PUBLISH, for the ones an author named. Read every
    // request on purpose: a cached answer to "what is true now" is worse than none, which
    // is also why these are an explicit list rather than everything a server offers — a
    // resource that changes per request invalidates the prefix cache from here onward,
    // and that should be a choice somebody made rather than a default they inherited.
    const attached = await collectResources(plan.services, clients);
    for (const problem of attached.notes) note(problem);

    // The self this agent is. Read after everything stable, because it changes
    // with every request: what it has learned, what it has been reading, and a
    // ticket for what comes of this answer.
    const self = await this.readSelf(plan, input, options, report, note);

    // The order here is an invariant, not a preference. What never changes goes
    // first and what changes per request goes after it, and none of it changes
    // between rungs or between samples. A provider's prefix cache is only worth
    // having if the prefix is stable, and the surest way to throw it away is to
    // put something written this second in front of something that was going to
    // be read again. What the agent has learned sits between the two: it changes
    // when somebody accepts a proposal, which is to say hardly ever.
    // Procedures sit beside what was learned, for the same reason: both change only
    // when somebody accepts a proposal, so both belong in the stable part of the prefix.
    const lasting = [plan.instructions, learned, procedures].filter(Boolean).join("\n\n");
    const system = [lasting, attached.text, recall, self?.text].filter(Boolean).join("\n\n");

    // Naming a conversation is enough to be in one: what was said before is
    // read back from where it was kept, so nothing has to be held between
    // turns. A caller that would rather keep its own turns still can, and its
    // own win — it can see them and this cannot.
    const history =
      options.history ??
      (options.thread ? await this.threads.carry(options.thread, budget.conversation) : []);

    const tools = plan.rungs[0]?.tools ? schemas : [];
    const shape: Shape = {
      asked: input.length,
      carried:
        system.length + history.reduce((total, message) => total + message.content.length, 0),
      turns: history.length,
      // The tools an agent works with. The one that reads the rest of a long result is
      // not a reason to think a request is harder.
      tools: tools.filter((tool) => tool.name !== READ_RESULT).length,
      structured: Boolean(plan.returns),
    };

    const reading = route(
      shape,
      plan.rungs.length,
      await this.ledger.leaning(plan.name),
      this.preference,
      { epsilon: this.explore, random: this.random },
    );
    if (reading.entry > 0) {
      note(`started at ${plan.rungs[reading.entry]!.model}: the request looked hard enough`);
    }
    if (reading.explored) {
      note(
        `sent to ${plan.rungs[reading.entry]!.model} at random rather than by the estimate, ` +
          `so the record of what the router chose can be read back`,
      );
    }

    // Every escalation this request may make, in order, decided before anything is spent.
    //
    // Depth first, and only then another model. A deeper pass on the rung already
    // answering is one call on a prefix cache that is already warm; crossing is one call
    // on a cache that cannot be, because a cache belongs to the model that filled it. The
    // rung's own cap clamps the depth ladder, so a rung that will not take a depth
    // argument contributes exactly one attempt and its only escalation is a crossing.
    //
    // A rung reached by crossing is asked for everything it has: it was reached because a
    // cheaper answer did not hold, so there is nothing left to be economical with.
    const attempts: { rung: number; effort: number }[] = [
      ...ladderFrom(reading.effort, plan.rungs[reading.entry]!.effort).map((effort) => ({
        rung: reading.entry,
        effort,
      })),
      ...plan.rungs
        .slice(reading.entry + 1)
        .map((rung, offset) => ({ rung: reading.entry + 1 + offset, effort: rung.effort })),
    ];

    // Checking an answer means asking the same question again, and a tool that
    // changes something must not be called three times to settle an argument
    // about wording. Nothing here can prove a tool on the far end of someone
    // else's server is safe to repeat, so an agent with tools is routed on the
    // estimate alone.
    const canVerify = reading.verify && tools.length === 0;
    if (reading.verify && !canVerify) {
      note("did not check this answer against itself: repeating a tool call is not free");
    }

    report?.({
      kind: "routing",
      entry: `${plan.rungs[reading.entry]!.provider}/${plan.rungs[reading.entry]!.model}`,
      rungs: plan.rungs.length,
      verify: canVerify,
      difficulty: reading.difficulty,
    });

    // A film taken apart for a rung that cannot hear has its sound written down by the
    // cheapest rung that can, where the ladder has one.
    const listener = plan.rungs.find((rung) => takesOf(rung.wire, rung.takes).has("audio"));
    const transcribe = listener
      ? (audio: Attachment): Promise<string | undefined> => this.transcribe(plan.name, listener, audio, usage, options)
      : undefined;

    /** Whether anything on this ladder is priced, so what is not can be said to be missing. */
    const priced = plan.rungs.some((rung) => rung.price !== undefined);
    const path: string[] = [];
    const toolCalls: { name: string; args: unknown }[] = [];
    const evidence: unknown[] = [];
    const wantsData = Boolean(plan.returns);
    const declared = plan.returns ? shapeOf(plan.returns) : undefined;
    /**
     * Whether an answer outside the declared shape is a failed answer.
     *
     * It is where the shape is one an answer can be checked against — a JSON Schema, a
     * Standard Schema — or the agent brought a check of its own. Fields and hints say
     * nothing checkable about a value, so an agent that declares only those is treated
     * as it always was: a reply that is not JSON is noted, and stands.
     */
    const strict = Boolean(declared && (declared.checked || plan.read));
    /** Hold a reply to the declared shape and the agent's own check, where it is held to either. */
    const toShape = async (parsed: Parsed): Promise<Parsed> => {
      if (!declared || !strict) return parsed;
      if (parsed.note) return { ...parsed, issues: [`$: ${parsed.note}`] };
      const checked = await declared.check(parsed.data);
      if (checked.issues) {
        return {
          text: parsed.text,
          note: `the reply was not in the declared shape (${checked.issues.slice(0, 3).join("; ")})`,
          issues: checked.issues,
        };
      }
      if (plan.read) {
        let said: string | undefined | void;
        try {
          said = await plan.read(checked.value);
        } catch (err) {
          // Asked whether the answer is good, the check did not manage to say yes.
          said = `the agent's check on its answer failed (${(err as Error)?.message ?? String(err)})`;
        }
        if (typeof said === "string" && said.trim()) {
          return { text: parsed.text, note: `the agent's own check refused the reply (${said.trim()})`, issues: [said.trim()] };
        }
      }
      // As the shape produced it: a validator may fill a default or turn text into a date.
      return { text: parsed.text, data: checked.value };
    };

    /** Which escalation is being made now. */
    let at = 0;
    let index = reading.entry;
    /** Tries against the CURRENT attempt, reset whenever the ladder moves. */
    let tries = 0;
    /** Depth steps taken on the entry rung, for the record. */
    let deepened = 0;
    /**
     * An answer already asked for and paid for, waiting for the attempt it belongs to.
     *
     * This is what makes a check cheaper than a repeat. When the next escalation is more
     * depth on the same model, the second answer of the comparison is DRAWN at that depth
     * — so if the two disagree, the escalated answer is already here and asking for it
     * again would be paying twice for the one call this whole design turns on.
     */
    let inHand: ChatResponse | undefined;
    let accepted: Parsed | undefined;
    let agreement: number | undefined;
    let verified = false;
    let climbed = false;
    let changed: number | undefined;
    /** The answer a climb is replacing, once there is one, and what was wrong with it. */
    let replaced: string | undefined;
    let before: Faults | undefined;
    let after: Faults | undefined;
    let lastError: Error | undefined;
    /** What the reply that stands made besides text. */
    let produced: Attachment[] | undefined;
    /**
     * Whether a fragment of an answer has already been handed to the caller.
     *
     * Once it has, this rung is the one that answers. Climbing away from it now
     * would mean taking back something already shown, and no amount of a better
     * answer later is worth an interface that rewrites itself.
     */
    let streamed = false;

    while (at < attempts.length) {
      const attempt = attempts[at]!;
      index = attempt.rung;
      const rung = plan.rungs[index]!;
      const last = at === attempts.length - 1;
      const upcoming = attempts[at + 1];
      /** Whether the next escalation is more depth on this same model. */
      const deeper = upcoming !== undefined && upcoming.rung === index;
      const spend = blank();
      const broke = { toolErrors: 0 };

      // Whether this reply is compared against another before it stands, known before the
      // model is asked. Not the same question as whether there is anywhere left to
      // escalate to: an attempt with depth above it can still be the one that answers,
      // and only a demonstrable fault moves it. That is what makes it safe to hand the
      // reply over as it arrives — there is no second answer coming to disagree with it.
      const checking = canVerify && !last;
      const settled = !checking;

      // A declared shape is never handed over as it arrives. What a model writes
      // on the way to an object is not the object, and half of one reads as
      // nothing at all.
      const live = settled && !wantsData;

      // Where a crossing would go — the next RUNG, not the next attempt. Depth left on
      // this rung is skipped by every path that calls this, so reading the next attempt
      // here would report a climb to the model already answering.
      const climbing = (why: string): void => {
        const next = plan.rungs[index + 1];
        if (next) {
          report?.({
            kind: "climbing",
            from: `${rung.provider}/${rung.model}`,
            to: `${next.provider}/${next.model}`,
            why,
          });
        }
      };

      /** Skip whatever depth is left on this rung; a crossing abandons the whole rung. */
      const cross = (): void => {
        while (at < attempts.length && attempts[at]!.rung === index) at++;
        tries = 0;
      };

      const converse = (
        into: Usage,
        record: { name: string; args: unknown }[],
        streaming: boolean,
        effort: number = attempt.effort,
      ) =>
        this.converse({
          agent: plan.name,
          trace: options.trace,
          tape: options.tape,
          caller: options.caller,
          context: options.context,
          rung,
          asking: options,
          // A conversation that cannot become the answer was drawn to check one.
          purpose: record === toolCalls ? "answer" : "sample",
          top: index === plan.rungs.length - 1,
          effort,
          system,
          stable: lasting.length,
          input,
          attachments: options.attachments,
          transcribe,
          history,
          tools: rung.tools ? tools : [],
          clients,
          locals: equipped.locals,
          held: equipped.held,
          effects: equipped.effects,
          closed: equipped.closed,
          shelf,
          turns: plan.turns ?? DEFAULT_TURNS,
          note,
          json: wantsData,
          schema: plan.returns ? schemaFromReturns(plan.returns) : undefined,
          budget,
          signal: options.signal,
          // Only the conversation that may become the answer is steered. A sample drawn
          // to check it would take a message meant for the work and throw it away.
          steer: record === toolCalls ? options.steer : undefined,
          usage: into,
          toolCalls: record,
          priced,
          broke,
          taint,
          evidence,
          report,
          onText:
            streaming && report
              ? (text) => {
                  streamed = true;
                  report({ kind: "text", text });
                }
              : undefined,
        });

      report?.({ kind: "answering", model: `${rung.provider}/${rung.model}`, effort: attempt.effort });

      // An answer drawn as the check on the attempt below is this attempt's answer, and
      // it has already been paid for and counted.
      const held = inHand;
      inHand = undefined;

      let reply: ChatResponse;
      if (held) {
        reply = held;
      } else {
        try {
          reply = await converse(spend, toolCalls, live);
        } catch (err) {
          lastError = err as Error;
          add(usage, spend);
          usage.decidingTokens += spent(spend);
          // The app ended the request: its meter refused, or it has made all the calls
          // it may. Neither is a model failing, so nothing is retried and nothing climbs.
          if (ends(err)) throw err;
          // Nothing shown is taken back, so a rung that has already spoken keeps
          // the request even when it then fails part way through.
          if (streamed) break;

          // A rate limit or a server fault is the moment failing, not the model. Wait and
          // ask this rung again rather than escalating to a dearer one — climbing here
          // would spend more precisely because the endpoint was busy.
          if (transient(err) && tries < this.retries) {
            tries++;
            note(`${rung.provider}/${rung.model} is busy, waiting before asking it again`);
            // An endpoint that says how long to wait knows better than a guess does —
            // up to a point, past which another model is quicker than this one's queue.
            const asked = err instanceof ProviderError ? err.retryAfter : undefined;
            const wait = asked ? Math.min(asked, PATIENCE_MS) : backoff(tries - 1, this.retryDelay);
            await new Promise((resume) => setTimeout(resume, wait));
            continue;
          }

          // An endpoint that did not answer is not an endpoint that needed more room to
          // think, so this skips whatever depth is left on it and crosses outright.
          note(
            `${rung.provider}/${rung.model} failed, trying the next model: ${lastError.message}`,
          );
          climbing(`it failed to answer`);
          cross();
          continue;
        }
      }

      path.push(`${rung.provider}/${rung.model}`);
      if (!held) add(usage, spend);
      /** What this attempt cost, wherever the answer came from. */
      const cost = held ? held.usage : spend;

      // A refusal and a failure are both reasons to ask someone else, and
      // neither is the router being wrong, so neither is recorded as a climb.
      // Depth is skipped here too: a refusal is a decision about the request rather than
      // a judgement about how hard it was, and asking the same model to think longer
      // about a request it declined only buys a more considered refusal.
      const declined = reply.stop === "refusal" || reply.stop === "filter" || reply.finishReason === "refusal";
      if (declined && !last && !streamed) {
        usage.decidingTokens += spent(cost);
        note(`${rung.model} declined to answer; asking a stronger model`);
        climbing("it declined to answer");
        cross();
        continue;
      }

      const parsed = await toShape(parseReply(reply.text, wantsData));
      if (parsed.note) note(`${rung.model}: ${parsed.note}`);
      // Whatever this reply made besides text belongs to it, and to the answer if it stands.
      produced = reply.attachments;
      // A reply that ran out of room looks exactly like one that chose to stop there.
      if (reply.stop === "length") {
        note(`${rung.model} ran out of room before it finished; raise \`output\` on its endpoint if answers are being cut off`);
      }

      // Everything about this answer that could be checked for free. A declared
      // shape either parsed or it did not; a tool either answered or it did not.
      const faults: Faults = { malformed: Boolean(parsed.note), toolErrors: broke.toolErrors };

      if (replaced !== undefined) {
        changed = divergence(replaced, parsed.text);
        note(
          changed < SAME_ANSWER
            ? "the stronger model said much the same thing; that climb bought little"
            : "the stronger model answered differently",
        );
      }

      /** Ask this same model again with more room to think, and take that answer. */
      const deepen = (why: string): void => {
        deepened++;
        note(`${why}; asking ${rung.model} again with more room to think`);
        at++;
        tries = 0;
      };

      const broken = faults.malformed || faults.toolErrors > 0;

      // An answer held to a shape and found outside it is a failed answer, and is
      // repaired the way this file repairs everything: more room on the same model
      // first, then another model. After the strongest there is nobody left to ask, and
      // handing back something the app said it would not accept is not an answer.
      if (strict && faults.malformed) {
        if (deeper) {
          deepen("the reply was not in the shape asked for");
          continue;
        }
        if (!last) {
          usage.decidingTokens += spent(cost);
          note(`${rung.model} did not answer in the declared shape; asking a stronger model`);
          climbing("its answer was not in the declared shape");
          climbed = true;
          before = faults;
          cross();
          continue;
        }
        throw new ShapeError(plan.name, parsed.issues ?? [], parsed.text);
      }

      if (settled) {
        // Free evidence that this attempt did not work, and somewhere cheaper than
        // another model to spend it. A shape that would not parse and a tool that
        // errored are the only two things about an answer this framework can know for
        // nothing, so they are the only two allowed to escalate without being paid for.
        if (deeper && broken && !streamed) {
          deepen(faults.malformed ? "the reply was not in the shape asked for" : "a tool errored");
          continue;
        }
        accepted = parsed;
        after = faults;
        break;
      }

      // Ask again and see whether the same answer comes back — a model that knows says it
      // twice, a model that is guessing does not guess the same way twice.
      //
      // Where this rung has depth left, the second answer is drawn AT that depth rather
      // than as a repeat. One call then buys two things: the comparison, and — if the
      // comparison goes badly — the escalation itself, already in hand, on a model whose
      // prefix cache is still warm. A repeat buys only the comparison, and `SAMPLES`
      // shows how badly that trade goes on a ladder whose rungs are close in price. The
      // repeat is what is left when the rung is capped at no depth at all.
      const another = async (effort: number, deciding: boolean): Promise<ChatResponse> => {
        const again = blank();
        const sample = await converse(again, [], false, effort);
        add(usage, again);
        // A draw that becomes the answer was not spent deciding; only one that is
        // discarded was. Which of the two it is is not known until it has been compared,
        // so the deeper draw is charged later, and only if it is thrown away.
        if (deciding) usage.decidingTokens += spent(again);
        return sample;
      };

      const wanted = deeper ? 2 : reading.samples;
      report?.({ kind: "checking", samples: wanted });

      const first = unfence(reply.text);
      const samples = [first];
      /** The deeper draw, kept whole so that keeping it costs nothing more. */
      let drawn: ChatResponse | undefined;
      if (deeper) {
        drawn = await another(upcoming!.effort, false).catch((err: unknown) => {
          // A check that could not be afforded leaves the answer unchecked; a meter that
          // said no has ended the request.
          if (err instanceof MeterRefused) throw err;
          return undefined;
        });
        if (drawn) samples.push(unfence(drawn.text));
      } else {
        for (const outcome of await Promise.allSettled(
          Array.from({ length: wanted - 1 }, () => another(attempt.effort, true)),
        )) {
          if (outcome.status === "fulfilled") samples.push(unfence(outcome.value.text));
          else if (outcome.reason instanceof MeterRefused) throw outcome.reason;
        }
      }

      if (samples.length < 2) {
        note("could not check this answer against itself; it stands unchecked");
        accepted = parsed;
        after = faults;
        break;
      }

      verified = true;
      const agreed = consensusOf(samples);
      agreement = agreed.agreement;
      report?.({
        kind: "checked",
        agreement: agreed.agreement,
        kept: agreed.agreement >= reading.bar,
      });

      if (agreed.agreement >= reading.bar) {
        // Keep the answer the others backed rather than the one that arrived
        // first, which is a fact about timing and not about the answer.
        const backed = agreed.text === first ? parsed : await toShape(parseReply(agreed.text, wantsData));
        // The first reply is known to be in the shape; the one the others backed is kept only if it is too.
        accepted = strict && backed.note ? parsed : backed;
        after = { malformed: Boolean(accepted.note), toolErrors: broke.toolErrors };
        // The answer held, so whatever was drawn to find that out existed only to find it
        // out — including the deeper draw, which is now being thrown away.
        if (drawn) usage.decidingTokens += spent(drawn.usage);
        break;
      }

      if (drawn) {
        // The two answers disagree, and the deeper of them is the better-informed one and
        // is already here. Nothing crosses to another model on this evidence: two depths
        // of one model disagreeing says the request needed more room, which is exactly
        // what has just been spent on it.
        inHand = drawn;
        deepen(
          `it answered differently with more room to think ` +
            `(${Math.round(agreed.agreement * 100)}% alike)`,
        );
        continue;
      }

      note(
        `it gave a different answer each time it was asked ` +
          `(${Math.round(agreed.agreement * 100)}% alike); asking a stronger model`,
      );
      usage.decidingTokens += spent(cost);
      climbing("it did not say the same thing twice");
      climbed = true;
      replaced = agreed.text;
      before = faults;
      cross();
    }

    if (!accepted) {
      throw lastError ?? new Error("every model failed to answer");
    }

    const entry = plan.rungs[reading.entry]!;
    await this.ledger
      .record({
        at: Date.now(),
        agent: plan.name,
        shape,
        difficulty: reading.difficulty,
        entry: reading.entry,
        rungs: plan.rungs.length,
        propensity: reading.propensity,
        explored: reading.explored,
        verified,
        agreement,
        climbed,
        deepened: deepened || undefined,
        before,
        after,
        changed,
        settled: index,
      })
      .catch(() => note("could not record what the router chose"));

    // The conversation is kept whether or not the agent remembers across them.
    // These are different things: one is what was said in this conversation, the
    // other is what the agent carries into every other one.
    if (options.thread) {
      await this.threads
        .append(options.thread, plan.name, [
          { role: "user", content: input },
          { role: "assistant", content: accepted.text },
        ])
        .catch(() => note("could not add to the conversation"));
    }

    if (plan.memory && !plan.self && accepted.text) {
      await remembering
        .record(plan.name, { thread: options.thread, input, answer: accepted.text })
        .catch(() => note("could not write to memory"));
    }

    // What the self did, against the ticket its context came with, so what
    // comes of it later reaches exactly what it drew on.
    if (self?.raw && accepted.text && this.selves) {
      // The agent and the app each get a last look at what is about to leave: either
      // may shorten it, replace it, or keep it from being sent at all.
      const work = await recordingFor(
        plan.self?.record,
        this.hooks,
        { task: options.task ?? input, answer: accepted.text, tools: toolCalls.map((call) => call.name) },
        {
          agent: plan.name,
          handle: self.answer.handle,
          ...(options.caller !== undefined ? { caller: options.caller } : {}),
          ...(options.context !== undefined ? { context: options.context } : {}),
        },
        note,
      );
      if (work) {
        await this.selves.provider
          .record(self.raw, work)
          .catch(() => note(`could not record this work for ${self.answer.handle}`));
      }
    }

    for (const left of crew.stopAll()) {
      note(`${left} was still working in the background when the answer was given, and was stopped`);
    }

    if (usage.unpricedTokens) {
      note(
        `${usage.unpricedTokens.toLocaleString()} tokens were spent on a model with no declared price, ` +
          `so the cost of this answer leaves them out`,
      );
    }

    return {
      text: accepted.text,
      data: accepted.data,
      agreement,
      path,
      usage,
      routing: {
        difficulty: reading.difficulty,
        entry: `${entry.provider}/${entry.model}`,
        verified,
        climbed,
      },
      toolCalls,
      ...(produced?.length ? { attachments: produced } : {}),
      harness: this.name,
      notes: notes.length ? notes : undefined,
      self: self?.answer,
      ...(taint.tainted ? { tainted: true } : {}),
      ...(evidence.length ? { evidence } : {}),
    };
  }

  /**
   * Read the self an agent declares, for one request. Undefined when it declares
   * none, when no provider is configured, or when the provider could not be
   * reached and the app did not make selves required.
   */
  private async readSelf(
    plan: AgentPlan,
    input: string,
    options: AskOptions,
    report: AskOptions["onProgress"],
    note: (text: string) => void,
  ): Promise<{ text: string; raw?: string; answer: AnswerSelf } | undefined> {
    if (!plan.self) return undefined;
    if (!this.selves) {
      note(`${plan.name} declares the self "${plan.self.handle}" but this app has no self provider; answering without its memory`);
      return undefined;
    }
    const person = options.caller?.person;
    const handle = handleFor(plan.self, person);
    if (!handle) {
      const why = `${plan.name} is a self per person and this request names nobody`;
      if (this.selves.required) throw new Error(why);
      note(`${why}; answering without its memory`);
      return undefined;
    }
    const template = plan.self.template && plan.self.perPerson && person
      ? { ...plan.self.template, subject: plan.self.template.subject ?? person }
      : plan.self.template;
    try {
      const context = await this.selves.provider.context(handle, {
        surface: options.surface ?? plan.self.surface ?? this.selves.surface ?? "agent",
        task: options.task ?? input,
        interactive: !options.background,
        template,
      });
      if (!context) return undefined;
      const secret = this.selves.ticketSecret;
      const ticket = context.ticket ? (secret ? signTicket(secret, context.ticket, person) : context.ticket) : undefined;
      const answer: AnswerSelf = { handle, ticket, bound: Boolean(context.ticket && secret), drewOn: context.drewOn ?? [] };
      report?.({ kind: "self", handle, ticket, drewOn: answer.drewOn });
      return { text: renderSelf(context), raw: context.ticket, answer };
    } catch (err) {
      const why = `could not read what ${handle} remembers: ${(err as Error).message}`;
      if (this.selves.required) throw new Error(why, { cause: err });
      note(`${why}; answering without its memory`);
      return undefined;
    }
  }

  /** A request to one rung, with everything about the rung filled in. */
  private request(
    rung: Rung,
    over: Pick<ChatRequest, "system" | "messages" | "effort"> & Partial<ChatRequest>,
  ): ChatRequest {
    return {
      model: rung.model,
      baseUrl: rung.baseUrl,
      apiKey: rung.apiKey,
      // What this particular endpoint needs, as its provider declared it. Carried on
      // every call rather than only the first, because a tool turn is a request too.
      credentialHeader: rung.credentialHeader,
      headers: rung.headers,
      body: rung.body,
      depth: rung.depth,
      levels: rung.levels,
      cache: rung.cache,
      ...(rung.computer ? { computer: rung.computer } : {}),
      ...(rung.output ? { maxTokens: rung.output } : {}),
      fetch: this.fetchImpl,
      ...over,
    };
  }

  /**
   * Hand a piece of work to another agent and bring back only what it concluded.
   *
   * The agent asked runs as any request does — its own ladder, its own tools, its own
   * guard — and what it spent is counted against the request that asked. How deep this
   * may go is bounded, because two agents that can each ask the other is a loop with a
   * model in it, and the bound is said to the model as a reason rather than thrown.
   */
  private async delegate(
    name: string,
    task: string,
    usage: Usage,
    taint: { tainted: boolean },
    options: AskOptions,
    /** Set when the agent is started in the background: its own signal, and how it is steered and watched. */
    work?: Work,
  ): Promise<string> {
    const other = this.planFor?.(name);
    if (!other) return `Error: no agent called "${name}" is available to ask.`;
    const depth = (options.depth ?? 0) + 1;
    if (depth > this.maxDepth) {
      return (
        `Not asked: this request is already ${depth - 1} agent(s) deep and ${this.maxDepth} is the limit. ` +
        `Do this part yourself, or answer with what you have.`
      );
    }
    const answer = await this.ask(other, task, {
      signal: work?.signal ?? options.signal,
      ...(work ? { steer: work.steer, onProgress: work.onProgress } : {}),
      // The agent asked is part of this request: its model calls count against the same limit.
      ...((options as Tallied)[TALLY] ? { [TALLY]: (options as Tallied)[TALLY] } : {}),
      trace: options.trace,
      ceiling: options.ceiling,
      caller: options.caller,
      context: options.context,
      surface: options.surface,
      background: options.background,
      tainted: taint.tainted,
      depth,
      // And it is held to what this request was narrowed to.
      ...((options as Bounded)[NARROW] ? { [NARROW]: (options as Bounded)[NARROW] } : {}),
      // An agent asked from inside a batch is asked in it too.
      ...((options as Seated)[SEAT] ? { [SEAT]: (options as Seated)[SEAT] } : {}),
    } as AskOptions);
    // An answer that arrives after its agent was stopped is not read by anyone, and the
    // request it would be charged to may already have been answered.
    if (work?.signal.aborted) throw new Error(`${name} was stopped`);
    add(usage, answer.usage);
    usage.decidingTokens += answer.usage.decidingTokens;
    // What the other agent read, this one is now relying on.
    if (answer.tainted) taint.tainted = true;
    if (answer.placeholder) return `Error: ${name} has no model to answer with.`;
    return answer.data !== undefined ? JSON.stringify(answer.data) : answer.text;
  }

  /** Ask the strongest rung what it would do next, without handing it the job. */
  private async advise(
    plan: AgentPlan,
    question: string,
    transcript: string,
    usage: Usage,
    options: AskOptions,
  ): Promise<string> {
    const { signal } = options;
    const top = plan.rungs[plan.rungs.length - 1]!;
    const thinks = top.depth !== "none" && top.effort > 0;
    const reply = await this.call(
      top,
      this.request(top, {
        system: `${ADVISING}\n\nThe instructions it is working under:\n\n${plan.instructions}`,
        messages: [
          {
            role: "user",
            content: `The work so far:\n\n${transcript || "(nothing yet)"}\n\nWhat it wants to know:\n\n${question}`,
          },
        ],
        effort: top.effort,
        // Thought and advice share one pool where the model thinks, so the cap on the
        // advice is given on top of room to arrive at it.
        maxTokens: thinks ? ADVICE_ROOM * 3 : ADVICE_ROOM,
        signal,
      }),
      "advice",
      plan.name,
      options,
    );
    count(usage, reply.usage, top.price, plan.rungs.some((rung) => rung.price));
    return reply.text.trim() || "The advisor had nothing to add.";
  }

  /**
   * How a rung is spoken to for this request: directly, or through the pile the request
   * is being batched in, where it is in one and the endpoint has not opted out.
   */
  private adapter(rung: Rung, options: AskOptions): ChatAdapter {
    const direct = adapterFor(rung.wire);
    const seat = (options as Seated)[SEAT];
    if (!seat || rung.batch === false) return direct;
    return (request) => seat.chat(rung.wire, direct, request);
  }

  /**
   * Asks whose requests to a model are handed over together, through each endpoint's
   * batch API where it has one.
   *
   * Every ask made through what this returns runs as any other does — its ladder, its
   * tools, its guard, its memory — and differs only in when its replies arrive. The
   * requests of all of them that are waiting at the same moment go as one batch per
   * endpoint and model. An endpoint whose shape has no batch API is asked directly.
   */
  batch(options: BatchOptions = {}): Batch {
    const batcher = new Batcher(options);
    return {
      ask: async (plan, input, asked = {}) => {
        const seat = batcher.seat();
        try {
          return await this.ask(plan, input, { ...asked, [SEAT]: seat } as AskOptions);
        } finally {
          seat.leave();
        }
      },
    };
  }

  /**
   * Open a live session with an agent: a conversation over one connection, for voice
   * and anything else that is not one request after another.
   *
   * The agent is the same agent — its instructions, what it has learned, its tools —
   * and a tool the model calls mid-conversation goes through the guard and the
   * authority exactly as it does in a request. What is different is the endpoint: a
   * session runs on the model an endpoint names under `realtime`, over the protocol
   * registered for that endpoint's shape.
   */
  async open(plan: AgentPlan, options: OpenOptions = {}): Promise<Session> {
    const rung = plan.rungs.find((candidate) => candidate.realtime);
    if (!rung?.realtime) {
      throw new Error(
        `agent "${plan.name}" has no endpoint to open a session with. Add \`realtime: { model: "…" }\` to one of the ` +
          `endpoints under \`models\` in praecise.config.ts: a session runs on a model of its own, which the framework does not name.`,
      );
    }
    const opener = sessionFor(rung.realtime.speaks ?? rung.wire);
    const WebSocket = this.socket ?? (globalThis as { WebSocket?: SocketConstructor }).WebSocket;
    if (!WebSocket) throw new Error("this runtime has no WebSocket to open a session over. Node 22 has one; elsewhere, pass `WebSocket` when the app is made.");

    const usage = blank();
    const taint = { tainted: Boolean(options.tainted) };
    const shelf = new Shelf();
    const budget = budgetFor(rung.room);
    const asking: AskOptions = { signal: options.signal, trace: options.trace, caller: options.caller, context: options.context, surface: options.surface };
    const { schemas: offered, clients, notes } = await this.tools(plan);
    // Agents started in the background during a session stop when the session's signal does.
    const crew = new Crew();
    options.signal?.addEventListener("abort", () => void crew.stopAll(), { once: true });
    const equipped = this.equip(plan, offered, budget, shelf, usage, taint, asking, crew);
    const learned = plan.memory && !plan.self ? renderNotes(await this.notes.notes(plan.name)) : "";
    const procedures = plan.memory && !plan.self ? renderSkills(await this.skills.skills(plan.name)) : "";

    const inner = await opener({
      model: rung.realtime.model,
      baseUrl: rung.baseUrl,
      url: rung.realtime.url,
      apiKey: rung.apiKey,
      credentialHeader: rung.credentialHeader,
      headers: rung.headers,
      body: rung.realtime.body,
      system: [plan.instructions, learned, procedures].filter(Boolean).join("\n\n"),
      tools: rung.tools ? equipped.schemas : [],
      output: options.output,
      voice: options.voice ?? rung.realtime.voice,
      signal: options.signal,
      WebSocket,
    });

    return new LiveSession(
      inner,
      usage,
      {
        count: (cost) => add(usage, cost),
        call: async (call, emit) => {
          // The same order as a request: the real tool behind a stand-in, the guard, the
          // call, and what came back cut to what fits.
          const real: ToolCall = { ...call, ...redirected(call, equipped.held) };
          emit({ kind: "tool", call: real });
          const refusal = await this.refuse(plan.name, real.name, real.args, equipped.locals, taint.tainted, undefined, asking);
          if (refusal !== undefined) {
            emit({ kind: "refused", name: real.name, why: refusal });
            return refusal;
          }
          const outcome = await runTool(real.name, real.args, clients, equipped.locals, options.signal, this.tracer, options.trace, [], asking);
          if (this.untrusted(real.name, equipped.locals)) taint.tainted = true;
          emit({ kind: "tool result", name: real.name, failed: outcome.failed });
          // A result goes back to the model as text on every protocol, so what a tool
          // attached is rendered where a reader knows it and named where none does.
          const back = await show(outcome.attachments, new Set(), budget.toolOutput, { signal: options.signal });
          for (const text of back.notes) emit({ kind: "note", text });
          return shelf.place([outcome.text, back.text].filter(Boolean).join("\n\n"), budget.toolOutput);
        },
        // A session is sent pictures beside what is said; the rest is read for it.
        show: (attachments) => show(attachments, new Set(["image"]), budget.toolOutput, { signal: options.signal }),
      },
      notes,
    );
  }

  /** Ask many questions of one agent as a batch. Answers come back in the order asked, each with its own failure. */
  async askMany(plan: AgentPlan, asks: readonly (string | Asking)[], options: BatchOptions = {}): Promise<Batched[]> {
    const batch = this.batch(options);
    return Promise.all(
      asks.map(async (one): Promise<Batched> => {
        const { input, options: asked } = typeof one === "string" ? { input: one, options: undefined } : one;
        try {
          return { answer: await batch.ask(plan, input, asked) };
        } catch (error) {
          return { error: error instanceof Error ? error : new Error(String(error)) };
        }
      }),
    );
  }

  /** Have a rung that hears write down what is said in a recording, for one that does not. */
  private async transcribe(agent: string, rung: Rung, audio: Attachment, usage: Usage, options: AskOptions): Promise<string | undefined> {
    const reply = await this.call(
      rung,
      this.request(rung, {
        system: TRANSCRIBING,
        messages: [{ role: "user", content: "Transcribe this recording.", attachments: [audio] }],
        effort: 0,
        signal: options.signal,
      }),
      "transcription",
      agent,
      options,
    );
    add(usage, reply.usage);
    return reply.text.trim() || undefined;
  }

  /**
   * Everything this request may call: what the author named, and what running it adds.
   *
   * Composed per request because the tools the runtime contributes hold the request's own
   * state — the shelf its long results sit on, the usage a delegated answer is charged to.
   * The list itself is the same for every request an agent gets, in the same order, which
   * is what lets an endpoint keep it.
   */
  private equip(
    plan: AgentPlan,
    remote: ToolSchema[],
    budget: Budget,
    shelf: Shelf,
    usage: Usage,
    taint: { tainted: boolean },
    options: AskOptions,
    crew: Crew,
  ): Equipped {
    // What the request was narrowed to, if it was. Nothing is added below that a list
    // left out, and what is left out is not in `effects` either, which is how a call to
    // it is known and refused.
    const lists = (options as Bounded)[NARROW]?.tools ?? [];
    const may = (name: string): boolean => permitted(name, lists);
    const own: LocalTool[] = plan.locals.filter((local) => READERS.has(local.name) || may(local.name));
    const delegates = (plan.delegates ?? []).filter((delegate) => may(delegate.name));
    if (lists.length) {
      // A program written against the services runs with all of them in reach, so it is
      // offered only where every one of them is allowed whole.
      const reach = plan.code ? [...bindingsFor(plan.services, plan.code.allow).bound.keys()] : [];
      const programs = reach.every((service) => serviceAllowed(service, lists));
      remote = remote.filter((schema) => (schema.name === CODE_TOOL ? programs : may(schema.name)));
    }
    for (const delegate of delegates) {
      own.push(
        delegateTool(
          delegate,
          (task) => this.delegate(delegate.name, task, usage, taint, options),
          plan.background
            ? (task, during) =>
                crew.start(
                  delegate.name,
                  (work) => this.delegate(delegate.name, task, usage, taint, options, work),
                  during?.signal ?? options.signal,
                )
            : undefined,
        ),
      );
    }
    if (plan.background && delegates.length) own.push(...crewTools(crew));
    if (plan.advisor && plan.rungs.length > 1) {
      own.push(consultTool((question, transcript) => this.advise(plan, question, transcript, usage, options)));
    }
    // Too many to list: they are found by description and called by name instead.
    const held = tooManyToList(remote, plan.rungs[0]?.room ?? 0) ? remote : [];
    if (held.length) own.push(...finderTools(held));
    if (own.length || remote.length) own.push(readResultTool(shelf, budget.toolOutput));

    return {
      locals: own,
      schemas: [
        ...own.map((local) => ({
          name: local.name,
          description: local.description,
          parameters: local.parameters,
          ...(local.effect ? { effect: local.effect } : {}),
          ...(local.native ? { native: local.native } : {}),
        })),
        ...(held.length ? [] : remote),
      ],
      held: new Set(held.map((schema) => schema.name)),
      closed: lists.length > 0,
      effects: new Map<string, Effect | undefined>([
        ...remote.map((schema) => [schema.name, schema.effect] as const),
        ...own.map((local) => [local.name, local.effect] as const),
      ]),
    };
  }

  /** One rung's conversation, including any tool round-trips it asks for. */
  private async converse(args: {
    agent: string;
    rung: AgentPlan["rungs"][number];
    /** The request this conversation belongs to: how its rung is spoken to, and what it is counted against. */
    asking: AskOptions;
    /** What this conversation is for, as the meter is told. */
    purpose: CallPurpose;
    /** Whether this is the strongest rung the request may reach. */
    top: boolean;
    /** How much room to ask for on this rung, 0..1. */
    effort: number;
    system: string;
    /** How much of the start of `system` is the same on every request. */
    stable: number;
    input: string;
    /** What was sent with the question besides its text. */
    attachments?: Attachment[];
    /** Writes down a recording this rung cannot hear, where another rung can. */
    transcribe?: (audio: Attachment) => Promise<string | undefined>;
    history: Message[];
    tools: ToolSchema[];
    clients: Map<string, ToolSource>;
    /** Where in a trace this turn sits, so a tool call joins the same trace. */
    trace?: TraceContext;
    /** Hears, or answers, the tool calls of this request. */
    tape?: ToolTape;
    /** Who the request is for and what the app sent with it, for the guard, the authority and functions. */
    caller?: AskCaller;
    context?: unknown;
    locals: LocalTool[];
    /** Tools held back from the list, reachable through `use_tool`. */
    held: ReadonlySet<string>;
    /** What calling each tool does, where anything said. */
    effects: ReadonlyMap<string, Effect | undefined>;
    /** Set when the request was narrowed to some of the agent's tools: nothing outside `effects` is called. */
    closed?: boolean;
    /** Where results too long for the transcript are kept whole. */
    shelf: Shelf;
    /** How many times the tools may be gone to before the model must answer. */
    turns: number;
    json: boolean;
    /** The declared shape, as a schema an endpoint can constrain decoding to. */
    schema?: Record<string, unknown>;
    /** What fits in this request, so a chatty tool cannot spend the whole of it. */
    budget: Budget;
    signal?: AbortSignal;
    usage: Usage;
    toolCalls: { name: string; args: unknown }[];
    /** Whether any rung of this ladder has a declared price. */
    priced: boolean;
    /** Tool calls that came back an error, counted for the record. */
    broke: { toolErrors: number };
    /** Set once untrusted output has entered this conversation. */
    taint: { tainted: boolean };
    /** What the caller has to add while the work is under way. See `AskOptions.steer`. */
    steer?: () => string[];
    /** Evidence endpoints returned with their replies, in order. */
    evidence: unknown[];
    report?: (event: Progress) => void;
    /** Something worth telling the developer, kept with the answer. */
    note: (text: string) => void;
    /**
     * Set when this rung's reply is kept as it stands, so its text can be handed
     * over as it arrives. Every turn is handed over, including what a model says
     * on the way to a tool: that is not the answer, but it is not replaced by
     * the answer either — it is what the agent said, before it went and looked.
     */
    onText?: (text: string) => void;
  }): Promise<ChatResponse> {
    const { rung, clients } = args;
    // Whatever an endpoint offers as proof of what it ran is kept with the answer,
    // so a journal can carry it beside the step that relied on it.
    const chat = async (request: ChatRequest, purpose: CallPurpose = args.purpose): Promise<ChatResponse> => {
      const reply = await this.call(rung, request, purpose, args.agent, args.asking);
      if (reply.evidence !== undefined) args.evidence.push(reply.evidence);
      count(args.usage, reply.usage, rung.price, args.priced);
      return reply;
    };
    const asking = (messages: Message[], over: Partial<ChatRequest>): ChatRequest =>
      this.request(rung, {
        system: args.system,
        stable: args.stable,
        messages,
        effort: args.effort,
        signal: args.signal,
        onText: args.onText,
        ...over,
      });

    // Who reads each thing that came with the question: this endpoint, a reader, or
    // nobody. Decided per rung, because the next model up may take what this one cannot.
    const takes = takesOf(rung.wire, rung.takes);
    const showing = { signal: args.signal, transcribe: args.transcribe };
    const sent = await show(args.attachments, takes, args.budget.toolOutput, showing);
    for (const said of sent.notes) args.note(said);
    /** What is too large to keep sending is handed to this endpoint once and named after. */
    const stored = async (attachments: Attachment[]): Promise<Attachment[]> => {
      if (!attachments.length) return attachments;
      const referred = await this.uploads.refer(
        rung.wire,
        { baseUrl: rung.baseUrl, apiKey: rung.apiKey, credentialHeader: rung.credentialHeader, headers: rung.headers, signal: args.signal, fetch: this.fetchImpl },
        attachments,
        rung.uploads,
      );
      for (const said of referred.notes) args.note(said);
      return referred.attachments;
    };
    sent.attachments = await stored(sent.attachments);
    let messages: Message[] = [
      ...args.history,
      {
        role: "user",
        content: [args.input, sent.text].filter(Boolean).join("\n\n"),
        ...(sent.attachments.length ? { attachments: sent.attachments } : {}),
      },
    ];
    /** What the model made that is not text, across every turn of this conversation. */
    const made: Attachment[] = [];
    const finish = (reply: ChatResponse): ChatResponse => {
      if (reply.attachments?.length) made.push(...reply.attachments);
      return made.length ? { ...reply, attachments: made } : reply;
    };
    /** The request's own question. Nothing at or before it is ever rewritten. */
    const anchor = args.history.length;
    // The strongest rung has nobody stronger to ask.
    const tools = args.top ? args.tools.filter((tool) => tool.name !== CONSULT) : args.tools;
    // Once per request, not once per tool turn: the same endpoint refuses the same
    // parameter every turn, and repeating it turns a useful warning into noise.
    const told = new Set<string>();

    /** Notes on a stretch of work, from the model doing it, when the record outgrows its room. */
    const summarise = async (text: string): Promise<string> =>
      (
        await chat(
          this.request(rung, {
            system: COMPACTING,
            messages: [{ role: "user", content: text }],
            effort: 0,
            maxTokens: SUMMARY_ROOM,
            signal: args.signal,
          }),
          "summary",
        )
      ).text;

    // The app's word on a stretch of work about to be replaced by notes, where it has one.
    const hooks = this.hooks;
    const compacting = hooks?.beforeCompact
      ? (stretch: readonly Message[], text: string) =>
          compactingAs(hooks, { agent: args.agent, transcript: stretch, text }, args.note)
      : undefined;
    /** How many times this conversation tried to stop and was sent back to work. */
    let returned = 0;

    for (let turn = 0; turn < args.turns; turn++) {
      // Whatever the caller has said since the last step is read before the next one.
      for (const said of args.steer?.() ?? []) messages.push({ role: "user", content: said });

      const fitted = await fit(messages, args.budget.transcript, anchor, summarise, compacting);
      messages = fitted.messages;
      for (const said of fitted.notes) args.note(said);

      const reply = await traced(
        this.tracer,
        {
          operation: "chat",
          provider: rung.provider,
          model: rung.model,
          parent: args.trace,
        },
        async () =>
          chat(
            asking(messages, {
              tools: tools.length ? tools : undefined,
              // Tool-calling turns must stay free-form; only the final answer is JSON.
              json: args.json && !tools.length,
              // A schema and a tool list cannot both constrain the same reply.
              schema: tools.length ? undefined : args.schema,
            }),
          ),
        // What the span records about the answer, in the convention's own names.
        (answer) => ({
          inputTokens: answer.usage.inputTokens,
          outputTokens: answer.usage.outputTokens,
          ...(rung.price
            ? { cost: { amount: amountOf(answer.usage, rung.price), currency: rung.price.currency } }
            : {}),
          attributes: {
            "gen_ai.usage.cache_read.input_tokens": answer.usage.cachedTokens,
            ...(answer.usage.cacheWriteTokens
              ? { "gen_ai.usage.cache_write.input_tokens": answer.usage.cacheWriteTokens }
              : {}),
            ...(answer.usage.reasoningTokens
              ? { "gen_ai.usage.reasoning.output_tokens": answer.usage.reasoningTokens }
              : {}),
            ...(answer.finishReason ? { "gen_ai.response.finish_reasons": answer.finishReason } : {}),
          },
        }),
      );

      // A parameter the endpoint refused is worth one line to the author, and worth
      // saying once rather than on every tool turn of the same request.
      for (const said of reply.notes ?? []) {
        if (told.has(said)) continue;
        told.add(said);
        args.report?.({ kind: "note", text: said });
      }

      if (!reply.toolCalls.length) {
        // It is about to stop, and the app may have a reason it should not: work it can
        // see is unfinished. Bounded, because a check that is never satisfied must not
        // become a loop with a model in it.
        //
        // And the caller may have said something while this reply was being written. A
        // message that arrives as the work ends is still read, not dropped: the agent is
        // shown it and goes on.
        const said = args.steer?.() ?? [];
        const reason =
          !said.length && returned < SENT_BACK
            ? await objectionTo(hooks, { agent: args.agent, text: reply.text, transcript: messages, sentBack: returned }, args.note)
            : undefined;
        if (reason) {
          returned++;
          args.note(`was sent back to work rather than allowed to stop: ${reason}`);
        }
        if (said.length || reason) {
          if (reply.attachments?.length) made.push(...reply.attachments);
          messages.push(
            { role: "assistant", content: reply.text, ...(reply.replay?.length ? { replay: reply.replay } : {}) },
            ...(reason ? [sentBack(reason)] : said).map((content) => ({ role: "user" as const, content })),
          );
          continue;
        }

        // A declared shape and a tool list cannot constrain the same reply, so a
        // turn that offers tools decodes free-form. That is right for a turn that
        // might call one — and wrong for this one, which did not. The answer that
        // ends the conversation was returned exactly as written, and `returns`
        // quietly became advice for every agent that happened to hold a tool.
        //
        // So the concluding answer is asked for once more with the tools withheld,
        // which is the same move the out-of-turns path below already makes, for the
        // same reason. The cost is one short constrained call on the last turn only,
        // and only when a shape was declared.
        if (!args.schema || !tools.length) return finish(reply);

        messages.push({ role: "assistant", content: reply.text });
        return finish(await chat(asking(messages, { json: args.json, schema: args.schema })));
      }

      if (reply.attachments?.length) made.push(...reply.attachments);
      messages.push({
        role: "assistant",
        content: reply.text,
        toolCalls: reply.toolCalls,
        // What this endpoint wants back with the results: its own reasoning, untouched.
        ...(reply.replay?.length ? { replay: reply.replay } : {}),
      });
      /** The work as it stood when these calls were made, for a tool that reads it. */
      const transcript = messages.slice();

      const settle = async (call: ToolCall): Promise<Message> => {
        // A call made through `use_tool` IS a call to the tool it names: the guard, the
        // trace and the record all see the real one, so nothing is reachable by going
        // through the stand-in that would have been refused directly.
        const real = redirected(call, args.held) ?? call;
        args.toolCalls.push({ name: real.name, args: real.args });
        args.report?.({ kind: "tool", name: real.name, args: real.args });

        // A request narrowed to some of an agent's tools reaches no other, however the
        // call was arrived at: by name, through the tool that finds tools, or from memory
        // of a list it was once shown.
        if (args.closed && !args.effects.has(real.name)) {
          const why = `Not available: "${real.name}" is not among the tools this request may use.`;
          args.report?.({ kind: "refused", name: real.name, why });
          return { role: "tool", toolCallId: call.id, name: call.name, content: why };
        }

        const refusal = await this.refuse(
          args.agent,
          real.name,
          real.args,
          args.locals,
          args.taint.tainted,
          // What was asked and what has been done, for a check that weighs one against the other.
          recentOf(messages, anchor, args.input),
          args,
        );
        if (refusal !== undefined) {
          // Not counted against the rung. A refusal says nothing about whether
          // the model was good enough, and a stronger one would be refused too;
          // counting it would send the router climbing for no reason.
          args.report?.({ kind: "refused", name: real.name, why: refusal });
          return { role: "tool", toolCallId: call.id, name: call.name, content: refusal };
        }

        // A replayed request is answered from its recording: the tool is not run, so
        // nothing it would have done happens a second time.
        const played = args.tape?.play?.({ name: real.name, args: real.args });
        const outcome: { text: string; failed: boolean; attachments?: Attachment[] } = played
          ? { text: played.text, failed: played.failed === true }
          : await runTool(
              real.name,
              real.args,
              clients,
              args.locals,
              args.signal,
              this.tracer,
              args.trace,
              transcript,
              args,
            );
        args.tape?.record?.({ name: real.name, args: real.args }, { text: outcome.text, failed: outcome.failed });
        if (outcome.failed) args.broke.toolErrors++;
        args.report?.({ kind: "tool result", name: real.name, failed: outcome.failed });
        // The app sees what came back before the model does, and may rewrite or withhold it.
        const shown = await shownFor(hooks, {
          agent: args.agent,
          tool: real.name,
          origin: args.locals.some((candidate) => candidate.name === real.name) ? "local" : "remote",
          effect: args.effects.get(real.name),
          args: real.args,
          result: outcome.text,
          failed: outcome.failed,
          attachments: outcome.attachments?.length ?? 0,
          ...(args.taint.tainted ? { tainted: true } : {}),
        });
        if (shown.rejected !== undefined) {
          // What was withheld never enters the conversation, so it marks nothing after it.
          args.report?.({ kind: "refused", name: real.name, why: shown.rejected });
          return { role: "tool", toolCallId: call.id, name: call.name, content: shown.rejected };
        }
        if (this.untrusted(real.name, args.locals)) args.taint.tainted = true;
        // What came back that is not text follows the rule for anything sent with a
        // question: the endpoint reads it, a reader renders it, or a note says it was left out.
        const back = await show(outcome.attachments, takes, args.budget.toolOutput, showing);
        for (const said of back.notes) args.note(said);
        back.attachments = await stored(back.attachments);
        return {
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          // A result that fits goes in whole. One that does not is kept whole on the
          // shelf, and the transcript gets enough of it to see what it is.
          content: args.shelf.place([shown.text, back.text].filter(Boolean).join("\n\n"), args.budget.toolOutput),
          ...(back.attachments.length ? { attachments: back.attachments } : {}),
        };
      };

      // Calls that only read may run together: nothing about one can change what
      // another finds. Anything that writes — or that nobody declared — runs in the
      // order the model asked for it, because that order may be the point.
      const together =
        reply.toolCalls.length > 1 &&
        reply.toolCalls.every(
          (call) => args.effects.get((redirected(call, args.held) ?? call).name) === "read",
        );
      if (together) {
        messages.push(...(await Promise.all(reply.toolCalls.map(settle))));
      } else {
        for (const call of reply.toolCalls) messages.push(await settle(call));
      }
    }

    // Out of tool turns: ask once more with tools withheld so it must conclude.
    args.note(`went to its tools ${args.turns} times, which is the limit; asked to conclude with what it has`);
    return finish(await chat(asking(messages, { json: args.json, schema: args.schema })));
  }

  /**
   * Ask the app whether this call is one it makes. A sentence back means no.
   *
   * A guard that throws is treated as a refusal rather than allowed to end the
   * run: the app was asked whether to do something and did not manage to say
   * yes, and the safe reading of that is no.
   */
  private async refuse(
    agent: string,
    tool: string,
    input: Record<string, unknown>,
    locals: LocalTool[],
    tainted = false,
    recent?: Recent[],
    who: { caller?: AskCaller; context?: unknown } = {},
  ): Promise<string | undefined> {
    if (!this.guard && !this.authority) return undefined;
    const local = locals.find((candidate) => candidate.name === tool);
    let action: Action | undefined;
    try {
      action = local?.action ? { ...local.action(input), ...(tainted ? { tainted: true } : {}) } : undefined;
    } catch (err) {
      return `Not allowed: the arguments do not describe an action this tool can take (${(err as Error).message})`;
    }
    const attempt: Attempt = {
      agent,
      tool,
      origin: local ? "local" : "remote",
      effect: local?.effect,
      args: input,
      ...(action ? { action } : {}),
      ...(tainted ? { tainted: true } : {}),
      ...(recent?.length ? { recent } : {}),
      // The app's own word on who this is for, back in the app's own hands.
      ...(who.caller !== undefined ? { caller: who.caller } : {}),
      ...(who.context !== undefined ? { context: who.context } : {}),
    };
    if (this.guard) {
      try {
        const said = await this.guard.run(attempt);
        if (said?.trim()) return said;
      } catch (err) {
        return `Not allowed: ${(err as Error).message}`;
      }
    }
    if (!this.authority) return undefined;
    const verdict = await judge(this.authority, attempt);
    if ("refuse" in verdict) return verdict.refuse;
    if ("stepUp" in verdict) return stepUpSentence(verdict.stepUp);
    return undefined;
  }

  /** Whether a tool's output may carry instructions nobody in the app wrote. */
  private untrusted(tool: string, locals: LocalTool[]): boolean {
    const local = locals.find((candidate) => candidate.name === tool);
    if (local) return local.trust === "untrusted";
    const split = splitToolName(tool);
    return (split && this.trustOf ? this.trustOf(split.service) : "untrusted") === "untrusted";
  }
}

/**
 * Invoke a tool, local or remote, returning its output as text for the model.
 *
 * A failure comes back as content rather than being thrown, because a model
 * that is told what went wrong can narrow the call and try again, where one
 * handed an exception can only stop. Whether it failed is reported alongside:
 * that is one of the two things about an answer this framework can check for
 * nothing, and the router keeps it.
 */
/**
 * A cancelled request must stop the TOOL too, not only the model.
 *
 * The signal reached every model call and stopped at the tool boundary, so abandoning a
 * request left a long MCP call running against someone else's server — work nobody would
 * read, still being paid for, on a request the caller had already given up on.
 */
async function runTool(
  name: string,
  input: Record<string, unknown>,
  clients: Map<string, ToolSource>,
  locals: LocalTool[],
  signal?: AbortSignal,
  tracer?: Tracer,
  parent?: TraceContext,
  transcript: readonly Message[] = [],
  who: { caller?: AskCaller; context?: unknown } = {},
): Promise<{ text: string; failed: boolean; attachments?: Attachment[] }> {
  const local = locals.find((candidate) => candidate.name === name);
  const split = local ? undefined : splitToolName(name);
  const client = split ? resolveService(clients, split.service) : undefined;

  return traced(
    tracer,
    {
      operation: "execute_tool",
      // A function of this app is not somebody else's system, and saying otherwise in a
      // trace makes local work look like a network call.
      provider: local ? "praecise" : (split?.service ?? "unknown"),
      toolName: name,
      parent,
    },
    async (context) => {
      try {
        if (local) {
          const result = await local.run(input, { transcript, signal, caller: who.caller, context: who.context });
          const attached = attachedIn(result);
          return attached
            ? { text: asText((result as { result: unknown }).result), failed: false, attachments: attached }
            : { text: asText(result), failed: false };
        }
        const attachments: Attachment[] = [];
        const media = (attachment: Attachment): void => void attachments.push(attachment);
        const runner = name === CODE_TOOL ? clients.get(CODE_TOOL) : undefined;
        if (runner) return { text: await runner.call("run", input, { signal, trace: context }), failed: false };
        if (!split || !client) return { text: `Error: no such tool "${name}".`, failed: true };
        // The trace ids travel with the call, so the server's work joins this trace
        // instead of becoming an orphan nobody attributes the latency to.
        const text = await client.call(split.tool, input, { signal, trace: context, media });
        return { text, failed: false, ...(attachments.length ? { attachments } : {}) };
      } catch (err) {
        return { text: `Error calling ${name}: ${(err as Error).message}`, failed: true };
      }
    },
    // A tool that reported an error is a failed span even though nothing threw: the
    // model was told it failed, and a trace that shows it green is lying.
    (outcome) => ({ attributes: outcome.failed ? { "error.type": "ToolError" } : {} }),
  );
}

export { ProviderError };
