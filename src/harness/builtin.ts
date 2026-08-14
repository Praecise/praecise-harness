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

import { join } from "node:path";

import type { AgentPlan, LocalTool } from "../compile/plan.js";
import { schemaFromReturns } from "../compile/plan.js";
import type { GuardSpec, Preference } from "../define.js";
import type { Store } from "../stores/types.js";
import { budgetFor, trim, type Budget } from "./budget.js";
import { collectTools, splitToolName, type ToolSource } from "./mcp.js";
import { NoteBook, renderNotes } from "./consolidate.js";
import { SkillBook, renderSkills } from "./procedure.js";
import { collectResources } from "./mcp.js";
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
  AskOptions,
  ChatResponse,
  Harness,
  Message,
  Progress,
  ToolSchema,
  Usage,
} from "./types.js";
import { ProviderError } from "./types.js";
import { adapterFor } from "./wire/index.js";

/** Cap on tool round-trips within a single rung, so a loop cannot run away. */
const MAX_TOOL_TURNS = 6;

/** Below this much difference, a stronger model said what the cheaper one said. */
const SAME_ANSWER = 0.25;

const blank = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  decidingTokens: 0,
});

function add(into: Usage, from: Usage): void {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cachedTokens += from.cachedTokens;
}

const spent = (usage: { inputTokens: number; outputTokens: number }): number =>
  usage.inputTokens + usage.outputTokens;

interface Parsed {
  text: string;
  data?: unknown;
  note?: string;
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
  /**
   * Where conversations are kept. Files under the state directory unless the
   * app says otherwise — and made once above here, so the runtime and whoever
   * is listing conversations are looking at the same ones.
   */
  threads?: Threads;
  /** Refuse rather than answer with a placeholder. See `AppConfig.strict`. */
  strict?: boolean;
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
  const status = error instanceof ProviderError ? error.status : 0;
  return status === 429 || (status >= 500 && status < 600);
}

/** Attempts against one rung before its failure counts as the rung's, not the moment's. */
const RETRIES = 2;

/**
 * How long to wait, doubling, with jitter.
 *
 * Jitter is not decoration: without it every request that hit the same limit retries at
 * the same instant and rebuilds the spike that caused it. Deliberately short — this is a
 * rate limit clearing, not an outage being waited out, and a request holding a user is
 * not the place to be patient.
 */
const backoff = (attempt: number): number => (200 << attempt) * (0.5 + Math.random());

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
  private readonly strict: boolean;
  private readonly preference: Preference;
  private readonly explore: number;
  private readonly random?: () => number;
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
    this.strict = options.strict ?? false;
    this.preference = options.preference ?? "balanced";
    this.explore = options.explore ?? 0;
    this.random = options.random;
  }

  /** Files unless the agent named a store, and only if there are stores to name. */
  private remembering(plan: AgentPlan): Recollection {
    const name = plan.memoryStore;
    if (!name || !this.stores) return this.memory;
    let backed = this.stored.get(name);
    if (!backed) {
      const stores = this.stores;
      backed = new StoredMemory(() => stores.open(name));
      this.stored.set(name, backed);
    }
    return backed;
  }

  private tools(plan: AgentPlan) {
    let pending = this.toolCache.get(plan.name);
    if (!pending) {
      // Local functions are already loaded, so they are advertised first and a
      // slow or unreachable MCP server cannot delay them.
      pending = collectTools(plan.services, this.fetchImpl).then((found) => ({
        ...found,
        schemas: [
          ...plan.locals.map((local) => ({
            name: local.name,
            description: local.description,
            parameters: local.parameters,
          })),
          ...found.schemas,
        ],
      }));
      this.toolCache.set(plan.name, pending);
    }
    return pending;
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
    const usage = blank();

    // Everything worth telling a developer afterwards is also worth telling an
    // interface now, so the two are the same list written to twice.
    const report = options.onProgress;
    const notes: string[] = [];
    const note = (text: string): void => {
      notes.push(text);
      report?.({ kind: "note", text });
    };

    if (!plan.rungs.length) return this.unanswered(plan, usage);

    // What fits, divided once. Every rung of a ladder is the same endpoint, so
    // the first one is as good as any to ask how much room there is.
    const budget = budgetFor(plan.rungs[0]!.room);

    const { schemas, clients, notes: toolNotes } = await this.tools(plan);
    for (const text of toolNotes) note(text);

    const remembering = this.remembering(plan);
    const recalled = plan.memory
      ? await remembering.recall(plan.name, input, plan.memoryRecall).catch(() => {
          note("could not read memory");
          return [];
        })
      : [];
    const recall = renderRecall(recalled, budget.recall);
    const learned = plan.memory ? renderNotes(await this.notes.notes(plan.name)) : "";
    // Procedures an agent has been given and a person has accepted — a WAY of doing
    // something, as opposed to a fact it has learned. They were being written to a store
    // and read by nothing, which made the whole fourth memory type write-only: an agent
    // could accumulate procedures it was never able to use. `skills()` returns only what
    // cleared the acceptance floor, so nothing unreviewed reaches a prompt.
    const procedures = plan.memory ? renderSkills(await this.skills.skills(plan.name)) : "";
    // What the services this agent uses PUBLISH, for the ones an author named. Read every
    // request on purpose: a cached answer to "what is true now" is worse than none, which
    // is also why these are an explicit list rather than everything a server offers — a
    // resource that changes per request invalidates the prefix cache from here onward,
    // and that should be a choice somebody made rather than a default they inherited.
    const attached = await collectResources(plan.services, clients);
    for (const problem of attached.notes) note(problem);

    // The order here is an invariant, not a preference. What never changes goes
    // first and what changes per request goes after it, and none of it changes
    // between rungs or between samples. A provider's prefix cache is only worth
    // having if the prefix is stable, and the surest way to throw it away is to
    // put something written this second in front of something that was going to
    // be read again. What the agent has learned sits between the two: it changes
    // when somebody accepts a proposal, which is to say hardly ever.
    // Procedures sit beside what was learned, for the same reason: both change only
    // when somebody accepts a proposal, so both belong in the stable part of the prefix.
    const system = [plan.instructions, learned, procedures, attached.text, recall]
      .filter(Boolean)
      .join("\n\n");

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
      tools: tools.length,
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

    const path: string[] = [];
    const toolCalls: { name: string; args: unknown }[] = [];
    const wantsData = Boolean(plan.returns);

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
        live: boolean,
        effort: number = attempt.effort,
      ) =>
        this.converse({
          agent: plan.name,
          rung,
          effort,
          system,
          input,
          history,
          tools: rung.tools ? tools : [],
          clients,
          locals: plan.locals,
          json: wantsData,
          schema: plan.returns ? schemaFromReturns(plan.returns) : undefined,
          budget,
          signal: options.signal,
          usage: into,
          toolCalls: record,
          broke,
          report,
          onText:
            live && report
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
          // Nothing shown is taken back, so a rung that has already spoken keeps
          // the request even when it then fails part way through.
          if (streamed) break;

          // A rate limit or a server fault is the moment failing, not the model. Wait and
          // ask this rung again rather than escalating to a dearer one — climbing here
          // would spend more precisely because the endpoint was busy.
          if (transient(err) && tries < RETRIES) {
            tries++;
            note(`${rung.provider}/${rung.model} is busy, waiting before asking it again`);
            await new Promise((resume) => setTimeout(resume, backoff(tries - 1)));
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
      if (reply.finishReason === "refusal" && !last && !streamed) {
        usage.decidingTokens += spent(cost);
        note(`${rung.model} declined to answer; asking a stronger model`);
        climbing("it declined to answer");
        cross();
        continue;
      }

      const parsed = parseReply(reply.text, wantsData);
      if (parsed.note) note(`${rung.model}: ${parsed.note}`);

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
        drawn = await another(upcoming!.effort, false).catch(() => undefined);
        if (drawn) samples.push(unfence(drawn.text));
      } else {
        for (const outcome of await Promise.allSettled(
          Array.from({ length: wanted - 1 }, () => another(attempt.effort, true)),
        )) {
          if (outcome.status === "fulfilled") samples.push(unfence(outcome.value.text));
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
        accepted = agreed.text === first ? parsed : parseReply(agreed.text, wantsData);
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

    if (plan.memory && accepted.text) {
      await remembering
        .record(plan.name, { thread: options.thread, input, answer: accepted.text })
        .catch(() => note("could not write to memory"));
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
      harness: this.name,
      notes: notes.length ? notes : undefined,
    };
  }

  /** One rung's conversation, including any tool round-trips it asks for. */
  private async converse(args: {
    agent: string;
    rung: AgentPlan["rungs"][number];
    /** How much room to ask for on this rung, 0..1. */
    effort: number;
    system: string;
    input: string;
    history: Message[];
    tools: ToolSchema[];
    clients: Map<string, ToolSource>;
    locals: LocalTool[];
    json: boolean;
    /** The declared shape, as a schema an endpoint can constrain decoding to. */
    schema?: Record<string, unknown>;
    /** What fits in this request, so a chatty tool cannot spend the whole of it. */
    budget: Budget;
    signal?: AbortSignal;
    usage: Usage;
    toolCalls: { name: string; args: unknown }[];
    /** Tool calls that came back an error, counted for the record. */
    broke: { toolErrors: number };
    report?: (event: Progress) => void;
    /**
     * Set when this rung's reply is kept as it stands, so its text can be handed
     * over as it arrives. Every turn is handed over, including what a model says
     * on the way to a tool: that is not the answer, but it is not replaced by
     * the answer either — it is what the agent said, before it went and looked.
     */
    onText?: (text: string) => void;
  }): Promise<ChatResponse> {
    const { rung, clients } = args;
    const chat = adapterFor(rung.wire);
    const messages: Message[] = [...args.history, { role: "user", content: args.input }];
    // Once per request, not once per tool turn: the same endpoint refuses the same
    // parameter every turn, and repeating it turns a useful warning into noise.
    const told = new Set<string>();

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const reply = await chat({
        model: rung.model,
        baseUrl: rung.baseUrl,
        apiKey: rung.apiKey,
        system: args.system,
        messages,
        effort: args.effort,
        depth: rung.depth,
        tools: args.tools.length ? args.tools : undefined,
        // Tool-calling turns must stay free-form; only the final answer is JSON.
        json: args.json && !args.tools.length,
        // A schema and a tool list cannot both constrain the same reply.
        schema: args.tools.length ? undefined : args.schema,
        signal: args.signal,
        fetch: this.fetchImpl,
        onText: args.onText,
      });

      // A parameter the endpoint refused is worth one line to the author, and worth
      // saying once rather than on every tool turn of the same request.
      for (const said of reply.notes ?? []) {
        if (told.has(said)) continue;
        told.add(said);
        args.report?.({ kind: "note", text: said });
      }

      args.usage.inputTokens += reply.usage.inputTokens;
      args.usage.outputTokens += reply.usage.outputTokens;
      args.usage.cachedTokens += reply.usage.cachedTokens;

      if (!reply.toolCalls.length) return reply;

      messages.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls });

      for (const call of reply.toolCalls) {
        args.toolCalls.push({ name: call.name, args: call.args });
        args.report?.({ kind: "tool", name: call.name, args: call.args });

        const refusal = await this.refuse(args.agent, call.name, call.args, args.locals);
        if (refusal !== undefined) {
          // Not counted against the rung. A refusal says nothing about whether
          // the model was good enough, and a stronger one would be refused too;
          // counting it would send the router climbing for no reason.
          args.report?.({ kind: "refused", name: call.name, why: refusal });
          messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: refusal });
          continue;
        }

        const outcome = await runTool(call.name, call.args, clients, args.locals, args.signal);
        if (outcome.failed) args.broke.toolErrors++;
        args.report?.({ kind: "tool result", name: call.name, failed: outcome.failed });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: trim(outcome.text, args.budget.toolOutput),
        });
      }
    }

    // Out of tool turns: ask once more with tools withheld so it must conclude.
    return chat({
      model: rung.model,
      baseUrl: rung.baseUrl,
      apiKey: rung.apiKey,
      system: args.system,
      messages,
      effort: args.effort,
      depth: rung.depth,
      json: args.json,
      schema: args.schema,
      signal: args.signal,
      fetch: this.fetchImpl,
      onText: args.onText,
    });
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
  ): Promise<string | undefined> {
    if (!this.guard) return undefined;
    const local = locals.find((candidate) => candidate.name === tool);
    try {
      const said = await this.guard.run({
        agent,
        tool,
        origin: local ? "local" : "remote",
        effect: local?.effect,
        args: input,
      });
      return said?.trim() ? said : undefined;
    } catch (err) {
      return `Not allowed: ${(err as Error).message}`;
    }
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
): Promise<{ text: string; failed: boolean }> {
  try {
    const local = locals.find((candidate) => candidate.name === name);
    if (local) return { text: asText(await local.run(input)), failed: false };

    const split = splitToolName(name);
    const client = split && clients.get(split.service);
    if (!split || !client) return { text: `Error: no such tool "${name}".`, failed: true };
    return { text: await client.call(split.tool, input, { signal }), failed: false };
  } catch (err) {
    return { text: `Error calling ${name}: ${(err as Error).message}`, failed: true };
  }
}

export { ProviderError };
