/**
 * The built-in runtime.
 *
 * It decides which model should answer before spending anything, asks it, and
 * only asks a stronger one when the first turns out to have been guessing. How
 * that is decided is in src/harness/routing.ts; what is here is the spending.
 * Tool calling and memory are the rest of it. It has no dependencies and needs
 * nothing installed alongside it.
 */

import { join } from "node:path";

import type { AgentPlan, LocalTool } from "../compile/plan.js";
import type { GuardSpec } from "../define.js";
import type { Store } from "../stores/types.js";
import { budgetFor, trim, type Budget } from "./budget.js";
import { collectTools, splitToolName, type McpClient } from "./mcp.js";
import { NoteBook, renderNotes } from "./consolidate.js";
import { Memory, StoredMemory, renderRecall, type Recollection } from "./memory.js";
import { Ledger, consensusOf, divergence, route, type Faults, type Shape } from "./routing.js";
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

const spent = (usage: Usage): number => usage.inputTokens + usage.outputTokens;

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
}

export class BuiltinHarness implements Harness {
  readonly name = "builtin";

  private readonly memory: Memory;
  private readonly notes: NoteBook;
  private readonly ledger: Ledger;
  readonly threads: Threads;
  private readonly stores?: { open(name: string): Promise<Store> };
  private readonly stored = new Map<string, StoredMemory>();
  private readonly fetchImpl: typeof fetch;
  private readonly guard?: GuardSpec;
  /** Tool discovery is per-agent and reused across requests. */
  private readonly toolCache = new Map<
    string,
    Promise<{ schemas: ToolSchema[]; clients: Map<string, McpClient>; notes: string[] }>
  >();

  constructor(options: BuiltinOptions) {
    this.memory = new Memory(options.stateDir);
    this.notes = new NoteBook(options.stateDir);
    this.ledger = new Ledger(options.stateDir);
    this.threads = options.threads ?? new Threads(join(options.stateDir, "threads"));
    this.stores = options.stores;
    this.fetchImpl = options.fetch ?? fetch;
    this.guard = options.guard;
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

    if (!plan.rungs.length) {
      return {
        text:
          "No model endpoint is configured, so this is a placeholder response. " +
          "Set PRAECISE_API_KEY, or add `models` to praecise.config.ts, then ask again.",
        path: [],
        usage,
        toolCalls: [],
        harness: "offline",
        notes: ["running offline: no model credential found"],
      };
    }

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

    // The order here is an invariant, not a preference. What never changes goes
    // first and what changes per request goes after it, and none of it changes
    // between rungs or between samples. A provider's prefix cache is only worth
    // having if the prefix is stable, and the surest way to throw it away is to
    // put something written this second in front of something that was going to
    // be read again. What the agent has learned sits between the two: it changes
    // when somebody accepts a proposal, which is to say hardly ever.
    const system = [plan.instructions, learned, recall].filter(Boolean).join("\n\n");

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

    const reading = route(shape, plan.rungs.length, await this.ledger.leaning(plan.name));
    if (reading.entry > 0) {
      note(`started at ${plan.rungs[reading.entry]!.model}: the request looked hard enough`);
    }

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

    let index = reading.entry;
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

    while (index < plan.rungs.length) {
      const rung = plan.rungs[index]!;
      const last = index === plan.rungs.length - 1;
      const spend = blank();
      const broke = { toolErrors: 0 };

      // Whether this rung's first reply is kept as it stands. It is known before
      // the model is asked, which is what makes it safe to stream: there is no
      // second sample to disagree with and no cheaper answer left to discard.
      // Whether this rung's reply is kept as it stands, known before the model
      // is asked. That is what makes it safe to hand the reply over as it
      // arrives: there is no second sample to disagree with and no cheaper
      // answer left to discard.
      const settled = last || !canVerify;

      // A declared shape is never handed over as it arrives. What a model writes
      // on the way to an object is not the object, and half of one reads as
      // nothing at all.
      const live = settled && !wantsData;

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

      // A rung reached by climbing is asked for everything it has: it was
      // reached because a cheaper answer did not hold, so there is nothing left
      // to be economical with.
      const effort = Math.min(rung.effort, index === reading.entry ? reading.effort : 1);

      const converse = (
        into: Usage,
        record: { name: string; args: unknown }[],
        live: boolean,
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

      report?.({ kind: "answering", model: `${rung.provider}/${rung.model}`, effort });

      let reply: ChatResponse;
      try {
        reply = await converse(spend, toolCalls, live);
      } catch (err) {
        lastError = err as Error;
        add(usage, spend);
        usage.decidingTokens += spent(spend);
        // Nothing shown is taken back, so a rung that has already spoken keeps
        // the request even when it then fails part way through.
        if (streamed) break;
        note(
          `${rung.provider}/${rung.model} failed, trying the next model: ${lastError.message}`,
        );
        climbing(`it failed to answer`);
        index++;
        continue;
      }

      path.push(`${rung.provider}/${rung.model}`);
      add(usage, spend);

      // A refusal and a failure are both reasons to ask someone else, and
      // neither is the router being wrong, so neither is recorded as a climb.
      if (reply.finishReason === "refusal" && !last && !streamed) {
        usage.decidingTokens += spent(spend);
        note(`${rung.model} declined to answer; asking a stronger model`);
        climbing("it declined to answer");
        index++;
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

      if (settled) {
        accepted = parsed;
        after = faults;
        break;
      }

      // Ask the same model the same question again, at the same time, and see
      // whether it says the same thing. A model that knows the answer gives it
      // twice; a model that is guessing does not guess the same way twice. The
      // samples run together, so this costs tokens rather than waiting.
      const another = async (): Promise<string> => {
        const again = blank();
        const sample = await converse(again, [], false);
        add(usage, again);
        usage.decidingTokens += spent(again);
        return unfence(sample.text);
      };

      report?.({ kind: "checking", samples: reading.samples });

      const first = unfence(reply.text);
      const samples = [first];
      for (const outcome of await Promise.allSettled(
        Array.from({ length: reading.samples - 1 }, another),
      )) {
        if (outcome.status === "fulfilled") samples.push(outcome.value);
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
        break;
      }

      note(
        `it gave a different answer each time it was asked ` +
          `(${Math.round(agreed.agreement * 100)}% alike); asking a stronger model`,
      );
      usage.decidingTokens += spent(spend);
      climbing("it did not say the same thing twice");
      climbed = true;
      replaced = agreed.text;
      before = faults;
      index++;
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
        verified,
        agreement,
        climbed,
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
    clients: Map<string, McpClient>;
    locals: LocalTool[];
    json: boolean;
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
        signal: args.signal,
        fetch: this.fetchImpl,
        onText: args.onText,
      });

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

        const outcome = await runTool(call.name, call.args, clients, args.locals);
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
async function runTool(
  name: string,
  input: Record<string, unknown>,
  clients: Map<string, McpClient>,
  locals: LocalTool[],
): Promise<{ text: string; failed: boolean }> {
  try {
    const local = locals.find((candidate) => candidate.name === name);
    if (local) return { text: asText(await local.run(input)), failed: false };

    const split = splitToolName(name);
    const client = split && clients.get(split.service);
    if (!split || !client) return { text: `Error: no such tool "${name}".`, failed: true };
    return { text: await client.call(split.tool, input), failed: false };
  } catch (err) {
    return { text: `Error calling ${name}: ${(err as Error).message}`, failed: true };
  }
}

export { ProviderError };
