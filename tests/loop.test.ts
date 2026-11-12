/**
 * What an agent can do in one request beyond calling a tool six times.
 *
 * Long work, kept inside its room; results too long to hand over, kept whole and read
 * from; more tools than fit in a list, found by description; another agent asked for a
 * piece of the work; a stronger model asked for advice. Each is a tool the runtime
 * contributes and each passes the same guard as a tool the author named.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agent, fn, guard } from "../src/define.js";
import { COMPACTING, clearResults, fit, weigh } from "../src/harness/context.js";
import { Shelf, findTools, tooManyToList } from "../src/harness/faculties.js";
import type { Message, ToolSchema } from "../src/harness/types.js";
import { createApp } from "../src/sdk.js";
import { MODEL_ENV } from "./helpers.js";

type Block = Record<string, unknown>;
type Sent = { model: string; system: string; body: Record<string, unknown> };

/** One scripted reply: text, and any number of tool calls. */
interface Turn {
  text?: string;
  calls?: { id?: string; name: string; args?: unknown }[];
  /** Reasoning blocks the endpoint signed and wants back. */
  thinking?: Block[];
  stop?: string;
  status?: number;
  headers?: Record<string, string>;
}

/**
 * An endpoint on the messages wire, scripted per turn. A function instead of a list
 * answers from what was sent, for a test with more than one conversation in it.
 */
function endpoint(script: Turn[] | ((sent: Sent, all: Sent[]) => Turn)) {
  const sent: Sent[] = [];
  const queue = Array.isArray(script) ? [...script] : undefined;
  const impl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const system = Array.isArray(body.system)
      ? (body.system as { text?: string }[]).map((block) => block.text ?? "").join("\n\n")
      : String(body.system ?? "");
    const record = { model: String(body.model), system, body };
    sent.push(record);
    const turn = queue ? (queue.shift() ?? { text: "nothing more was scripted" }) : (script as (s: Sent, a: Sent[]) => Turn)(record, sent);
    if (turn.status) {
      return new Response(JSON.stringify({ error: turn.text ?? "no" }), {
        status: turn.status,
        headers: { "content-type": "application/json", ...turn.headers },
      });
    }
    const content: Block[] = [
      ...(turn.thinking ?? []),
      ...(turn.text ? [{ type: "text", text: turn.text }] : []),
      ...(turn.calls ?? []).map((call, at) => ({
        type: "tool_use",
        id: call.id ?? `t${sent.length}-${at}`,
        name: call.name,
        input: call.args ?? {},
      })),
    ];
    return new Response(
      JSON.stringify({
        content,
        stop_reason: turn.stop ?? (turn.calls?.length ? "tool_use" : "end_turn"),
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetch: impl, sent };
}

/** The messages of a recorded request, and the tool results among them. */
const messagesOf = (sent: Sent) => sent.body.messages as { role: string; content: Block[] }[];
const resultsOf = (sent: Sent) =>
  messagesOf(sent)
    .flatMap((message) => message.content)
    .filter((block) => block.type === "tool_result")
    .map((block) => String(block.content));
const toolsOf = (sent: Sent) => ((sent.body.tools as { name: string }[] | undefined) ?? []).map((tool) => tool.name);

const MODELS = (room = 128_000, extra: Record<string, unknown> = {}) => ({
  models: {
    house: {
      url: "https://models.test",
      credential: "HOUSE_KEY",
      speaks: "messages",
      fast: "small",
      balanced: "mid",
      best: "large",
      room,
      ...extra,
    },
  },
  limits: { retryDelay: 1 },
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "praecise-loop-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const build = (definition: Parameters<typeof createApp>[0], model: { fetch: typeof fetch }) =>
  createApp({ root, ...definition }, { env: MODEL_ENV, fetch: model.fetch });

const lookup = fn({
  description: "Look an order up.",
  input: { id: "the order id" },
  effect: "read",
  run: ({ id }) => ({ id, status: "delivered" }),
});

describe("how long an agent may keep working", () => {
  it("goes to its tools more than six times when the work needs it", async () => {
    const model = endpoint([
      ...Array.from({ length: 9 }, (_, at) => ({ calls: [{ name: "lookup", args: { id: String(at) } }] })),
      { text: "All nine are delivered." },
    ]);
    const app = await build(
      { config: MODELS(), agents: { a: agent({ role: "Help.", quality: "fast", tools: ["lookup"] }) }, functions: { lookup } },
      model,
    );
    const answer = await app.ask("a", "check orders 0 to 8");
    expect(answer.text).toBe("All nine are delivered.");
    expect(answer.toolCalls).toHaveLength(9);
  });

  it("stops at the agent's own limit and asks for a conclusion with the tools withheld", async () => {
    const model = endpoint((sent) =>
      toolsOf(sent).length ? { calls: [{ name: "lookup", args: { id: "1" } }] } : { text: "Here is what I have." },
    );
    const app = await build(
      {
        config: MODELS(),
        agents: { a: agent({ role: "Help.", quality: "fast", tools: ["lookup"], turns: 2 }) },
        functions: { lookup },
      },
      model,
    );
    const answer = await app.ask("a", "keep looking");
    expect(answer.toolCalls).toHaveLength(2);
    expect(answer.text).toBe("Here is what I have.");
    expect(answer.notes?.join(" ")).toContain("which is the limit");
  });
});

describe("calls that only read run together", () => {
  const slow = (effect: "read" | "write", order: string[]) =>
    fn({
      description: "Wait, then answer.",
      input: { id: "which" },
      effect,
      run: async ({ id }) => {
        order.push(`start ${id}`);
        await new Promise((resume) => setTimeout(resume, 20));
        order.push(`end ${id}`);
        return id;
      },
    });
  const twoCalls = [
    { calls: [{ name: "wait", args: { id: "a" } }, { name: "wait", args: { id: "b" } }] },
    { text: "done" },
  ];

  it("two reads overlap, and their results go back in the order they were asked for", async () => {
    const order: string[] = [];
    const model = endpoint(twoCalls);
    const app = await build(
      { config: MODELS(), agents: { a: agent({ role: "Help.", quality: "fast", tools: ["wait"] }) }, functions: { wait: slow("read", order) } },
      model,
    );
    await app.ask("a", "go");
    expect(order).toEqual(["start a", "start b", "end a", "end b"]);
    expect(resultsOf(model.sent[1]!)).toEqual(["a", "b"]);
  });

  it("two writes do not: the order the model asked for may be the point", async () => {
    const order: string[] = [];
    const app = await build(
      { config: MODELS(), agents: { a: agent({ role: "Help.", quality: "fast", tools: ["wait"] }) }, functions: { wait: slow("write", order) } },
      endpoint(twoCalls),
    );
    await app.ask("a", "go");
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
  });
});

describe("an endpoint's reasoning stays with the turn it came from", () => {
  it("goes back with the tool result, first and untouched", async () => {
    const thinking = { type: "thinking", thinking: "Look it up first.", signature: "sig" };
    const model = endpoint([
      { thinking: [thinking], calls: [{ id: "t1", name: "lookup", args: { id: "7" } }] },
      { text: "Delivered." },
    ]);
    const app = await build(
      { config: MODELS(), agents: { a: agent({ role: "Help.", quality: "fast", tools: ["lookup"] }) }, functions: { lookup } },
      model,
    );
    await app.ask("a", "where is order 7?");
    const assistant = messagesOf(model.sent[1]!).find((message) => message.role === "assistant")!;
    expect(assistant.content[0]).toEqual(thinking);
  });
});

describe("a result too long to hand over", () => {
  const big = Array.from({ length: 4000 }, (_, at) => `line ${at + 1}: ${at === 2499 ? "the needle is here" : "hay"}`).join("\n");
  const dump = fn({ description: "Return a long listing.", effect: "read", run: () => big });

  it("is kept whole, shown in part, and read from by search", async () => {
    const model = endpoint([
      { calls: [{ name: "dump" }] },
      { calls: [{ name: "read_result", args: { result: "r1", search: "needle" } }] },
      { text: "Found it on line 2500." },
    ]);
    const app = await build(
      { config: MODELS(20_000), agents: { a: agent({ role: "Help.", quality: "fast", tools: ["dump"] }) }, functions: { dump } },
      model,
    );
    const answer = await app.ask("a", "find the needle");

    expect(toolsOf(model.sent[0]!)).toContain("read_result");
    const [shown] = resultsOf(model.sent[1]!);
    expect(shown).toContain('kept as "r1"');
    expect(shown!.length).toBeLessThan(big.length / 2);
    const [, found] = resultsOf(model.sent[2]!);
    expect(found).toContain("2500: line 2500: the needle is here");
    expect(answer.text).toBe("Found it on line 2500.");
  });

  it("a shelf reads by line, says what is left, and names what it holds", () => {
    const shelf = new Shelf();
    const placed = shelf.place(big, 200);
    expect(placed).toContain('kept as "r1"');
    expect(shelf.place("short", 200)).toBe("short");

    const page = shelf.read("r1", 60, 10);
    expect(page.startsWith("10: line 10: hay")).toBe(true);
    expect(page).toMatch(/more line\(s\); continue with from: \d+/);
    expect(shelf.read("r9", 60)).toContain("Kept: r1");
    expect(shelf.read("r1", 60, undefined, "no such thing")).toContain("Nothing in");
  });
});

describe("work that outgrows its room", () => {
  const turnsOf = (results: number, size: number): Message[] => [
    { role: "user", content: "do the thing" },
    ...Array.from({ length: results }, (_, at): Message[] => [
      { role: "assistant", content: "", toolCalls: [{ id: `c${at}`, name: "look", args: { at } }], replay: [{ signed: at }] },
      { role: "tool", toolCallId: `c${at}`, name: "look", content: `result ${at} ${"x".repeat(size)}` },
    ]).flat(),
  ];

  it("leaves a transcript that fits exactly as it was", async () => {
    const messages = turnsOf(2, 100);
    const fitted = await fit(messages, 10_000, 0, async () => "unused");
    expect(fitted.messages).toBe(messages);
    expect(fitted.notes).toEqual([]);
  });

  it("clears old results first, keeps the recent ones whole, and keeps every call", async () => {
    const messages = turnsOf(8, 2000);
    const limit = Math.floor(weigh(messages) * 0.9);
    const fitted = await fit(messages, limit, 0, async () => {
      throw new Error("should not be asked");
    });
    const results = fitted.messages.filter((message) => message.role === "tool");
    expect(results.slice(0, 5).every((message) => message.content.includes("was cleared"))).toBe(true);
    expect(results.slice(-3).every((message) => message.content.startsWith("result"))).toBe(true);
    expect(fitted.messages.filter((message) => message.toolCalls?.length)).toHaveLength(8);
    expect(weigh(fitted.messages)).toBeLessThan(limit);
    // Reasoning was signed against turns that no longer read the same.
    expect(fitted.messages.some((message) => message.replay)).toBe(false);
    expect(fitted.notes[0]).toContain("cleared earlier tool results");
  });

  it("summarises the earlier work when clearing is not enough, and never rewrites the question", async () => {
    // Small results: nothing worth clearing, so the only way down is a summary.
    const messages = turnsOf(40, 40);
    let asked = "";
    const fitted = await fit(messages, Math.floor(weigh(messages) * 0.5), 0, async (text) => {
      asked = text;
      return "Task — do the thing.\nDone — looked 36 times.";
    });
    expect(asked).toContain("[called look with");
    expect(fitted.messages[0]).toEqual({ role: "user", content: "do the thing" });
    expect(fitted.messages[1]!.content).toContain("Done — looked 36 times.");
    // The kept tail starts at a call, so no result is left answering a call that is gone.
    expect(fitted.messages[2]!.toolCalls?.length).toBe(1);
    expect(fitted.messages.length).toBeLessThan(messages.length);
    expect(fitted.notes[0]).toContain("summarised");
  });

  it("goes on with results cleared harder when the summary cannot be had", async () => {
    const messages = turnsOf(6, 3000);
    const fitted = await fit(messages, Math.floor(weigh(messages) * 0.2), 0, async () => {
      throw new Error("endpoint down");
    });
    expect(fitted.notes.join(" ")).toContain("could not summarise");
    expect(fitted.messages.filter((m) => m.role === "tool" && !m.content.includes("was cleared"))).toHaveLength(1);
  });

  it("clearing does not touch the transcript it was given", () => {
    const messages = turnsOf(5, 2000);
    const before = JSON.stringify(messages);
    expect(clearResults(messages).freed).toBeGreaterThan(0);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("the runtime asks the model for notes and carries on from them", async () => {
    const filler = fn({ description: "Return a page.", input: { n: "which" }, effect: "read", run: ({ n }) => `page ${n} ${"word ".repeat(700)}` });
    let turn = 0;
    const model = endpoint((sent) => {
      if (sent.system === COMPACTING) return { text: "Task — read pages.\nDone — pages read so far." };
      turn++;
      return turn <= 14 ? { calls: [{ name: "page", args: { n: String(turn) } }] } : { text: "Read them all." };
    });
    const app = await build(
      { config: MODELS(8_000), agents: { a: agent({ role: "Help.", quality: "fast", tools: ["page"], turns: 20 }) }, functions: { page: filler } },
      model,
    );
    const answer = await app.ask("a", "read every page");
    expect(answer.text).toBe("Read them all.");
    expect(answer.notes?.some((said) => /cleared earlier tool results|summarised the earlier part/.test(said))).toBe(true);
    // No request sent after the first rewrite is over the room the endpoint has.
    for (const sent of model.sent) expect(JSON.stringify(sent.body.messages).length / 4).toBeLessThan(8_000);
  });
});

describe("more tools than fit in a list", () => {
  const schema = (name: string, description: string): ToolSchema => ({
    name,
    description,
    parameters: { type: "object", properties: { id: { type: "string", description: "x".repeat(400) } } },
  });
  const many = [
    schema("billing__create_invoice", "Create an invoice for a customer account."),
    schema("billing__refund_payment", "Refund a payment that was already captured."),
    schema("calendar__list_events", "List the events on a calendar between two dates."),
    ...Array.from({ length: 40 }, (_, at) => schema(`misc__thing_${at}`, `Do unrelated thing number ${at}.`)),
  ];

  it("a short list is listed whatever it weighs, and a long heavy one is not", () => {
    expect(tooManyToList(many.slice(0, 5), 1_000)).toBe(false);
    expect(tooManyToList(many, 20_000)).toBe(true);
    expect(tooManyToList(many, 2_000_000)).toBe(false);
  });

  it("finds by what a tool does, and weighs a name above a description", () => {
    expect(findTools(many, "refund a customer's payment")[0]!.name).toBe("billing__refund_payment");
    expect(findTools(many, "what is on the calendar")[0]!.name).toBe("calendar__list_events");
    expect(findTools(many, "zzz")).toEqual([]);
  });
});

describe("one agent asking another", () => {
  const agents = {
    lead: agent({ role: "Coordinate.", quality: "fast", tools: ["researcher"] }),
    researcher: agent({ role: "Find things out.", description: "Researches a question and reports back.", quality: "fast", tools: ["lookup"] }),
  };
  const script = (sent: Sent, all: Sent[]): Turn => {
    if (sent.system.startsWith("Find things out.")) {
      return resultsOf(sent).length ? { text: "Order 7 was delivered." } : { calls: [{ name: "lookup", args: { id: "7" } }] };
    }
    return all.filter((s) => s.system.startsWith("Coordinate.")).length === 1
      ? { calls: [{ name: "researcher", args: { task: "Find the status of order 7." } }] }
      : { text: "It was delivered." };
  };

  it("hands over a task, gets back only the conclusion, and pays for both", async () => {
    const model = endpoint(script);
    const app = await build({ config: MODELS(), agents, functions: { lookup } }, model);
    const answer = await app.ask("lead", "where is order 7?");

    expect(answer.text).toBe("It was delivered.");
    const lead = model.sent.filter((sent) => sent.system.startsWith("Coordinate."));
    // The other agent is a tool, described as an agent that shares no context.
    const offered = (lead[0]!.body.tools as { name: string; description: string }[]).find((tool) => tool.name === "researcher")!;
    expect(offered.description).toContain("Researches a question and reports back.");
    expect(offered.description).toContain("sees nothing of this conversation");
    // What comes back is the answer, not the work behind it.
    expect(resultsOf(lead[1]!)).toEqual(["Order 7 was delivered."]);
    expect(JSON.stringify(lead[1]!.body.messages)).not.toContain("delivered\\\"}");
    // The researcher started from the task alone.
    const researcher = model.sent.find((sent) => sent.system.startsWith("Find things out."))!;
    expect(messagesOf(researcher)[0]!.content[0]).toMatchObject({ text: "Find the status of order 7." });
    // Four model calls were made, and all four are on the bill.
    expect(answer.usage.inputTokens).toBe(40);
  });

  it("is bounded: an agent that asks itself round in a circle is told why not", async () => {
    const model = endpoint((sent) => {
      const told = resultsOf(sent).at(-1);
      if (told) return { text: told };
      return { calls: [{ name: sent.system.startsWith("A.") ? "b" : "a", args: { task: "go round" } }] };
    });
    const app = await build(
      {
        config: MODELS(),
        agents: {
          a: agent({ role: "A.", quality: "fast", tools: ["b"] }),
          b: agent({ role: "B.", quality: "fast", tools: ["a"] }),
        },
      },
      model,
    );
    const answer = await app.ask("a", "start");
    expect(answer.text).toContain("3 is the limit");
    // a → b → a → b, and the fourth is refused the fifth.
    expect(model.sent.filter((sent) => toolsOf(sent).length && !resultsOf(sent).length)).toHaveLength(4);
  });

  it("passes the same guard as any other tool", async () => {
    const model = endpoint(script);
    const app = await build(
      {
        config: MODELS(),
        agents,
        functions: { lookup },
        guard: guard(({ tool }) => (tool === "researcher" ? "Research is closed today." : undefined)),
      },
      model,
    );
    await app.ask("lead", "where is order 7?");
    expect(model.sent.some((sent) => sent.system.startsWith("Find things out."))).toBe(false);
    expect(resultsOf(model.sent[1]!)).toEqual(["Research is closed today."]);
  });
});

describe("asking a stronger model for advice", () => {
  it("the cheap model does the work and the strongest is asked once, with the work so far", async () => {
    const model = endpoint((sent) => {
      if (sent.model === "large") return { text: "Look the order up before answering." };
      const results = resultsOf(sent);
      if (!results.length) return { calls: [{ name: "consult", args: { question: "How should I start?" } }] };
      return { text: `Advice taken: ${results[0]}` };
    });
    const app = await build(
      {
        config: MODELS(),
        agents: { a: agent({ role: "Help.", quality: "best", tools: ["lookup"], advisor: true }) },
        functions: { lookup },
      },
      model,
    );
    const answer = await app.ask("a", "where is order 7?");
    expect(answer.text).toBe("Advice taken: Look the order up before answering.");

    const advisor = model.sent.find((sent) => sent.model === "large")!;
    expect(advisor.system).toContain("You are advising another model");
    expect(advisor.system).toContain("Help.");
    expect(JSON.stringify(advisor.body.messages)).toContain("How should I start?");
    expect(advisor.body.tools).toBeUndefined();
    // Capped: advice that needs more room than this is the job itself.
    expect(Number(advisor.body.max_tokens)).toBeLessThanOrEqual(2048 * 3);
    // The answer came from the cheap model, and the advice is on the bill.
    expect(answer.path).toEqual(["house/small"]);
    expect(answer.usage.inputTokens).toBe(30);
  });

  it("is not offered unless asked for", async () => {
    const model = endpoint([{ text: "ok" }]);
    const app = await build(
      { config: MODELS(), agents: { a: agent({ role: "Help.", quality: "best", tools: ["lookup"] }) }, functions: { lookup } },
      model,
    );
    await app.ask("a", "hi");
    expect(toolsOf(model.sent[0]!)).not.toContain("consult");
  });
});

describe("an endpoint that is busy, or that declines", () => {
  it("waits as long as the endpoint asked, and asks the same model again", async () => {
    const model = endpoint([{ status: 429, headers: { "retry-after-ms": "40" } }, { text: "ok" }]);
    const app = await build({ config: MODELS(), agents: { a: agent({ role: "Help.", quality: "fast" }) } }, model);
    const started = Date.now();
    const answer = await app.ask("a", "hi");
    expect(answer.text).toBe("ok");
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(model.sent.map((sent) => sent.model)).toEqual(["small", "small"]);
  });

  it("does not wait on a limit that is about money", async () => {
    const model = endpoint((sent) =>
      sent.model === "small" ? { status: 429, text: "enforced_spend_limit_reached" } : { text: "from the next model" },
    );
    const app = await build({ config: MODELS(), agents: { a: agent({ role: "Help.", quality: "balanced" }) } }, model);
    const answer = await app.ask("a", "hi");
    expect(answer.text).toBe("from the next model");
    expect(model.sent.filter((sent) => sent.model === "small")).toHaveLength(1);
  });

  it("says so when a reply ran out of room", async () => {
    const model = endpoint([{ text: "This answer stops mid", stop: "max_tokens" }]);
    const app = await build({ config: MODELS(), agents: { a: agent({ role: "Help.", quality: "fast" }) } }, model);
    const answer = await app.ask("a", "hi");
    expect(answer.notes?.join(" ")).toContain("ran out of room");
  });

  it("sends what the provider declared about depth words, output room and keeping", async () => {
    const model = endpoint([{ text: "ok" }]);
    const app = await build(
      {
        // Under "quality" the strongest rung answers at full depth, which is the last word.
        config: {
          ...MODELS(128_000, { levels: ["low", "medium", "high", "xhigh"], output: 32_000, cache: false, thinking: "effort" }),
          preference: "quality",
        },
        agents: { a: agent({ role: "Help.", quality: "best" }) },
      },
      model,
    );
    await app.ask("a", "hi");
    const body = model.sent[0]!.body;
    expect(body.max_tokens).toBe(32_000);
    expect(body.output_config).toMatchObject({ effort: "xhigh" });
    expect(body.system).toBe("Help.");
  });

  it("sends what came with the question", async () => {
    const model = endpoint([{ text: "A cat." }]);
    const app = await build({ config: MODELS(), agents: { a: agent({ role: "Help.", quality: "fast" }) } }, model);
    await app.ask("a", "what is this?", { attachments: [{ mime: "image/png", data: "aGVsbG8=" }] });
    expect(messagesOf(model.sent[0]!)[0]!.content[0]).toMatchObject({ type: "image" });
  });
});
