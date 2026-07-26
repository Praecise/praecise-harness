/**
 * The built-in runtime.
 *
 * It walks the rungs the compiler chose, cheapest first, and stops as soon as a
 * model is confident enough. A hard question climbs to a better model; an easy
 * one is answered by the cheap one and never costs more. That escalation, plus
 * tool calling and memory, is the whole of it. It has no dependencies and needs
 * nothing installed alongside it.
 */

import type { AgentPlan, LocalTool } from "../compile/plan.js";
import type { Store } from "../stores/types.js";
import { collectTools, splitToolName, type McpClient } from "./mcp.js";
import { Memory, StoredMemory, renderRecall, type Recollection } from "./memory.js";
import type {
  Answer,
  AskOptions,
  ChatResponse,
  Harness,
  Message,
  ToolSchema,
} from "./types.js";
import { ProviderError } from "./types.js";
import { adapterFor } from "./wire/index.js";

/** Cap on tool round-trips within a single rung, so a loop cannot run away. */
const MAX_TOOL_TURNS = 6;

/** Cap on how much of one tool's output is allowed into the context. */
const MAX_TOOL_OUTPUT = 100_000;

const ENVELOPE_INSTRUCTION = `Respond with a single JSON object and nothing else:
{"answer": <your response>, "confidence": <number 0-1>}
"confidence" is how sure you are that your answer is complete and correct. Be honest: a low number hands the question to a stronger model, which is the right outcome when you are guessing.`;

const RETURNS_ENVELOPE_NOTE = `Put the JSON object described above inside "answer".`;

interface Parsed {
  text: string;
  data?: unknown;
  confidence: number;
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

/** The `{answer, confidence}` shape, if that is what the reply is. */
function asEnvelope(text: string): { answer: unknown; confidence?: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && "answer" in value) {
      return value as { answer: unknown; confidence?: unknown };
    }
  } catch {
    // Not JSON; the model answered in prose.
  }
  return undefined;
}

/** Read a rung's reply, whether or not it honoured the envelope. */
function parseReply(raw: string, wantsEnvelope: boolean, wantsData: boolean): Parsed {
  const text = unfence(raw).trim();

  // An envelope is unwrapped wherever it turns up. The last rung is never asked
  // for one, but a model that volunteers it must not leak JSON to the reader.
  const envelope = asEnvelope(text);
  if (envelope) {
    const { answer, confidence } = envelope;
    const value = wantsEnvelope && typeof confidence === "number" ? confidence : 1;
    return {
      text: asText(answer),
      data: wantsData && answer !== null && typeof answer === "object" ? answer : undefined,
      confidence: Math.max(0, Math.min(1, value)),
    };
  }

  if (!wantsEnvelope) {
    if (!wantsData) return { text, confidence: 1 };
    try {
      const data: unknown = JSON.parse(text);
      return { text, data, confidence: 1 };
    } catch {
      return { text, confidence: 1, note: "expected JSON but the reply was not valid JSON" };
    }
  }

  // A model that cannot follow a one-line format is not one to trust with a
  // borderline answer, so this scores low enough to hand off.
  return { text, confidence: 0.5, note: "reply did not use the requested format" };
}

export interface BuiltinOptions {
  /** Where memory files live. */
  stateDir: string;
  fetch?: typeof fetch;
  /** Declared stores, for an agent that remembers into one instead. */
  stores?: { open(name: string): Promise<Store> };
}

export class BuiltinHarness implements Harness {
  readonly name = "builtin";

  private readonly memory: Memory;
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

    if (!plan.rungs.length) {
      return {
        text:
          "No model endpoint is configured, so this is a placeholder response. " +
          "Set PRAECISE_API_KEY, or add `models` to praecise.config.ts, then ask again.",
        confidence: 0,
        path: [],
        usage: { inputTokens: 0, outputTokens: 0 },
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

    const path: string[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    const toolCalls: { name: string; args: unknown }[] = [];
    let best: Parsed | undefined;
    let lastError: Error | undefined;

    for (const rung of plan.rungs) {
      const wantsEnvelope = rung.handOffBelow !== undefined;
      const system = [
        plan.instructions,
        recall,
        wantsEnvelope ? ENVELOPE_INSTRUCTION : "",
        wantsEnvelope && plan.returns ? RETURNS_ENVELOPE_NOTE : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      let reply: ChatResponse;
      try {
        reply = await this.converse({
          rung,
          system,
          input,
          history: options.history ?? [],
          tools: rung.tools ? schemas : [],
          clients,
          locals: plan.locals,
          json: wantsEnvelope || Boolean(plan.returns),
          signal: options.signal,
          usage,
          toolCalls,
        });
      } catch (err) {
        lastError = err as Error;
        notes.push(
          `${rung.provider}/${rung.model} failed, trying the next model: ${lastError.message}`,
        );
        continue;
      }

      path.push(`${rung.provider}/${rung.model}`);

      if (reply.finishReason === "refusal") {
        notes.push(`${rung.model} declined to answer; handing off`);
        best = { text: reply.text, confidence: 0 };
        continue;
      }

      const parsed = parseReply(reply.text, wantsEnvelope, Boolean(plan.returns));
      if (parsed.note) notes.push(`${rung.model}: ${parsed.note}`);
      best = parsed;

      if (rung.handOffBelow === undefined || parsed.confidence >= rung.handOffBelow) break;
      notes.push(
        `${rung.model} was ${Math.round(parsed.confidence * 100)}% sure; handing off to a stronger model`,
      );
    }

    if (!best) {
      throw lastError ?? new Error("every model failed to answer");
    }

    if (plan.memory && best.text) {
      await remembering
        .record(plan.name, { thread: options.thread, input, answer: best.text })
        .catch(() => notes.push("could not write to memory"));
    }

    return {
      text: best.text,
      data: best.data,
      confidence: best.confidence,
      path,
      usage,
      toolCalls,
      harness: this.name,
      notes: notes.length ? notes : undefined,
    };
  }

  /** One rung's conversation, including any tool round-trips it asks for. */
  private async converse(args: {
    rung: AgentPlan["rungs"][number];
    system: string;
    input: string;
    history: Message[];
    tools: ToolSchema[];
    clients: Map<string, McpClient>;
    locals: LocalTool[];
    json: boolean;
    signal?: AbortSignal;
    usage: { inputTokens: number; outputTokens: number };
    toolCalls: { name: string; args: unknown }[];
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
        thinking: rung.thinking,
        depth: rung.depth,
        tools: args.tools.length ? args.tools : undefined,
        // Tool-calling turns must stay free-form; only the final answer is JSON.
        json: args.json && !args.tools.length,
        signal: args.signal,
        fetch: this.fetchImpl,
      });

      args.usage.inputTokens += reply.usage.inputTokens;
      args.usage.outputTokens += reply.usage.outputTokens;

      if (!reply.toolCalls.length) return reply;

      messages.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls });

      for (const call of reply.toolCalls) {
        args.toolCalls.push({ name: call.name, args: call.args });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: fit(await runTool(call.name, call.args, clients, args.locals)),
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
      thinking: rung.thinking,
      json: args.json,
      signal: args.signal,
      fetch: this.fetchImpl,
    });
  }

}

/** Invoke a tool, local or remote, returning its output as text for the model. */
async function runTool(
  name: string,
  input: Record<string, unknown>,
  clients: Map<string, McpClient>,
  locals: LocalTool[],
): Promise<string> {
  try {
    const local = locals.find((candidate) => candidate.name === name);
    if (local) return asText(await local.run(input));

    const split = splitToolName(name);
    const client = split && clients.get(split.service);
    if (!split || !client) return `Error: no such tool "${name}".`;
    return await client.call(split.tool, input);
  } catch (err) {
    // Returned as content, not thrown: the model can recover or explain.
    return `Error calling ${name}: ${(err as Error).message}`;
  }
}

export { ProviderError };
