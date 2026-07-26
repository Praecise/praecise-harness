/**
 * The built-in runtime.
 *
 * It decides which model should answer before spending anything, asks it, and
 * only asks a stronger one when the first turns out to have been guessing. How
 * that is decided is in src/harness/routing.ts; what is here is the spending.
 * Tool calling and memory are the rest of it. It has no dependencies and needs
 * nothing installed alongside it.
 */

import type { AgentPlan, LocalTool } from "../compile/plan.js";
import type { Store } from "../stores/types.js";
import { collectTools, splitToolName, type McpClient } from "./mcp.js";
import { Memory, StoredMemory, renderRecall, type Recollection } from "./memory.js";
import { Ledger, consensusOf, divergence, route, type Faults, type Shape } from "./routing.js";
import type {
  Answer,
  AskOptions,
  ChatResponse,
  Harness,
  Message,
  ToolSchema,
  Usage,
} from "./types.js";
import { ProviderError } from "./types.js";
import { adapterFor } from "./wire/index.js";

/** Cap on tool round-trips within a single rung, so a loop cannot run away. */
const MAX_TOOL_TURNS = 6;

/** Cap on how much of one tool's output is allowed into the context. */
const MAX_TOOL_OUTPUT = 100_000;

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

/**
 * Trim a tool result to something a context can hold. The middle goes: a head
 * carries the shape of the data and a tail often carries the total or the
 * conclusion, and one chatty tool must not cost the rest of the conversation.
 * The model is told what is missing so it can narrow the call and ask again.
 */
function fit(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  const keep = Math.floor((MAX_TOOL_OUTPUT - 200) / 2);
  const dropped = text.length - keep * 2;
  return (
    `${text.slice(0, keep)}\n\n` +
    `[${dropped.toLocaleString()} characters omitted from the middle of this result. ` +
    `Call the tool again with a narrower request if you need what is missing.]\n\n` +
    `${text.slice(-keep)}`
  );
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
}

export class BuiltinHarness implements Harness {
  readonly name = "builtin";

  private readonly memory: Memory;
  private readonly ledger: Ledger;
  private readonly stores?: { open(name: string): Promise<Store> };
  private readonly stored = new Map<string, StoredMemory>();
  private readonly fetchImpl: typeof fetch;
  /** Tool discovery is per-agent and reused across requests. */
  private readonly toolCache = new Map<
    string,
    Promise<{ schemas: ToolSchema[]; clients: Map<string, McpClient>; notes: string[] }>
  >();

  constructor(options: BuiltinOptions) {
    this.memory = new Memory(options.stateDir);
    this.ledger = new Ledger(options.stateDir);
    this.stores = options.stores;
    this.fetchImpl = options.fetch ?? fetch;
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
    const notes: string[] = [];
    const usage = blank();

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

    const { schemas, clients, notes: toolNotes } = await this.tools(plan);
    notes.push(...toolNotes);

    const remembering = this.remembering(plan);
    const recalled = plan.memory
      ? await remembering.recall(plan.name, input, plan.memoryRecall).catch(() => {
          notes.push("could not read memory");
          return [];
        })
      : [];
    const recall = renderRecall(recalled);

    // The order here is an invariant, not a preference. What never changes goes
    // first and what changes per request goes after it, and none of it changes
    // between rungs or between samples. A provider's prefix cache is only worth
    // having if the prefix is stable, and the surest way to throw it away is to
    // put something written this second in front of something that was going to
    // be read again.
    const system = [plan.instructions, recall].filter(Boolean).join("\n\n");

    const history = options.history ?? [];
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
      notes.push(`started at ${plan.rungs[reading.entry]!.model}: the request looked hard enough`);
    }

    // Checking an answer means asking the same question again, and a tool that
    // changes something must not be called three times to settle an argument
    // about wording. Nothing here can prove a tool on the far end of someone
    // else's server is safe to repeat, so an agent with tools is routed on the
    // estimate alone.
    const canVerify = reading.verify && tools.length === 0;
    if (reading.verify && !canVerify) {
      notes.push("did not check this answer against itself: repeating a tool call is not free");
    }

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

    while (index < plan.rungs.length) {
      const rung = plan.rungs[index]!;
      const last = index === plan.rungs.length - 1;
      const spend = blank();
      const broke = { toolErrors: 0 };

      // A rung reached by climbing is asked for everything it has: it was
      // reached because a cheaper answer did not hold, so there is nothing left
      // to be economical with.
      const effort = Math.min(rung.effort, index === reading.entry ? reading.effort : 1);

      const converse = (into: Usage, record: { name: string; args: unknown }[]) =>
        this.converse({
          rung,
          effort,
          system,
          input,
          history,
          tools: rung.tools ? tools : [],
          clients,
          locals: plan.locals,
          json: wantsData,
          signal: options.signal,
          usage: into,
          toolCalls: record,
          broke,
        });

      let reply: ChatResponse;
      try {
        reply = await converse(spend, toolCalls);
      } catch (err) {
        lastError = err as Error;
        add(usage, spend);
        usage.decidingTokens += spent(spend);
        notes.push(
          `${rung.provider}/${rung.model} failed, trying the next model: ${lastError.message}`,
        );
        index++;
        continue;
      }

      path.push(`${rung.provider}/${rung.model}`);
      add(usage, spend);

      // A refusal and a failure are both reasons to ask someone else, and
      // neither is the router being wrong, so neither is recorded as a climb.
      if (reply.finishReason === "refusal" && !last) {
        usage.decidingTokens += spent(spend);
        notes.push(`${rung.model} declined to answer; asking a stronger model`);
        index++;
        continue;
      }

      const parsed = parseReply(reply.text, wantsData);
      if (parsed.note) notes.push(`${rung.model}: ${parsed.note}`);

      // Everything about this answer that could be checked for free. A declared
      // shape either parsed or it did not; a tool either answered or it did not.
      const faults: Faults = { malformed: Boolean(parsed.note), toolErrors: broke.toolErrors };

      if (replaced !== undefined) {
        changed = divergence(replaced, parsed.text);
        notes.push(
          changed < SAME_ANSWER
            ? "the stronger model said much the same thing; that climb bought little"
            : "the stronger model answered differently",
        );
      }

      if (last || !canVerify) {
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
        const sample = await converse(again, []);
        add(usage, again);
        usage.decidingTokens += spent(again);
        return unfence(sample.text);
      };

      const first = unfence(reply.text);
      const samples = [first];
      for (const outcome of await Promise.allSettled(
        Array.from({ length: reading.samples - 1 }, another),
      )) {
        if (outcome.status === "fulfilled") samples.push(outcome.value);
      }

      if (samples.length < 2) {
        notes.push("could not check this answer against itself; it stands unchecked");
        accepted = parsed;
        after = faults;
        break;
      }

      verified = true;
      const agreed = consensusOf(samples);
      agreement = agreed.agreement;

      if (agreed.agreement >= reading.bar) {
        // Keep the answer the others backed rather than the one that arrived
        // first, which is a fact about timing and not about the answer.
        accepted = agreed.text === first ? parsed : parseReply(agreed.text, wantsData);
        after = { malformed: Boolean(accepted.note), toolErrors: broke.toolErrors };
        break;
      }

      notes.push(
        `it gave a different answer each time it was asked ` +
          `(${Math.round(agreed.agreement * 100)}% alike); asking a stronger model`,
      );
      usage.decidingTokens += spent(spend);
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
      .catch(() => notes.push("could not record what the router chose"));

    if (plan.memory && accepted.text) {
      await remembering
        .record(plan.name, { thread: options.thread, input, answer: accepted.text })
        .catch(() => notes.push("could not write to memory"));
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
    signal?: AbortSignal;
    usage: Usage;
    toolCalls: { name: string; args: unknown }[];
    /** Tool calls that came back an error, counted for the record. */
    broke: { toolErrors: number };
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
      });

      args.usage.inputTokens += reply.usage.inputTokens;
      args.usage.outputTokens += reply.usage.outputTokens;
      args.usage.cachedTokens += reply.usage.cachedTokens;

      if (!reply.toolCalls.length) return reply;

      messages.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls });

      for (const call of reply.toolCalls) {
        args.toolCalls.push({ name: call.name, args: call.args });
        const outcome = await runTool(call.name, call.args, clients, args.locals);
        if (outcome.failed) args.broke.toolErrors++;
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: fit(outcome.text),
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
    });
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
