/**
 * An agent that works while the one that started it carries on.
 *
 * Starting is the delegated agent's own tool with `background: true`, so a guard that
 * refuses the agent refuses it either way. What comes back is a handle, and four tools
 * act on it: check, steer, cancel, collect. The agent belongs to the request that
 * started it and is stopped when that request answers.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agent, fn, guard } from "../src/define.js";
import { Crew, MAX_RUNNING, type Work } from "../src/harness/faculties.js";
import { createApp } from "../src/sdk.js";
import { MODEL_ENV } from "./helpers.js";

type Block = Record<string, unknown>;
type Sent = { system: string; body: Record<string, unknown> };
interface Turn {
  text?: string;
  calls?: { name: string; args?: unknown }[];
  /** Hold the reply until this resolves, or fail it when the request is aborted. */
  wait?: Promise<unknown>;
}

function endpoint(script: (sent: Sent, all: Sent[]) => Turn) {
  const sent: Sent[] = [];
  const aborted: string[] = [];
  const impl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const system = Array.isArray(body.system)
      ? (body.system as { text?: string }[]).map((block) => block.text ?? "").join("\n\n")
      : String(body.system ?? "");
    const record = { system, body };
    sent.push(record);
    const turn = script(record, sent);
    if (turn.wait) {
      const signal = init?.signal ?? undefined;
      await new Promise<void>((resolve, reject) => {
        const stop = (): void => {
          aborted.push(system);
          reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
        };
        if (signal?.aborted) return stop();
        signal?.addEventListener("abort", stop, { once: true });
        void turn.wait!.then(() => resolve());
      });
    }
    const content: Block[] = [
      ...(turn.text ? [{ type: "text", text: turn.text }] : []),
      ...(turn.calls ?? []).map((call, at) => ({ type: "tool_use", id: `t${sent.length}-${at}`, name: call.name, input: call.args ?? {} })),
    ];
    return new Response(
      JSON.stringify({ content, stop_reason: turn.calls?.length ? "tool_use" : "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetch: impl, sent, aborted };
}

const messagesOf = (sent: Sent) => sent.body.messages as { role: string; content: Block[] }[];
const resultsOf = (sent: Sent) =>
  messagesOf(sent)
    .flatMap((message) => message.content)
    .filter((block) => block.type === "tool_result")
    .map((block) => String(block.content));
const textsOf = (sent: Sent) =>
  messagesOf(sent)
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .filter((block) => block.type === "text")
    .map((block) => String(block.text));
const toolsOf = (sent: Sent) => ((sent.body.tools as { name: string }[] | undefined) ?? []).map((tool) => tool.name);

const CONFIG = {
  models: { house: { url: "https://models.test", credential: "HOUSE_KEY", speaks: "messages", fast: "small" } },
};

const lookup = fn({ description: "Look an order up.", input: { id: "the order id" }, effect: "read", run: ({ id }) => ({ id, status: "delivered" }) });
const agents = {
  lead: agent({ name: "lead", role: "Coordinate.", quality: "fast", tools: ["researcher"], background: true }),
  researcher: agent({ name: "researcher", role: "Find things out.", description: "Researches a question and reports back.", quality: "fast", tools: ["lookup"] }),
};
const isLead = (sent: Sent): boolean => sent.system.startsWith("Coordinate.");
/** How many requests the lead has made, this one included. */
const leadTurn = (all: Sent[]): number => all.filter(isLead).length;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "praecise-background-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const build = (model: { fetch: typeof fetch }, extra: Partial<Parameters<typeof createApp>[0]> = {}) =>
  createApp({ root, config: CONFIG, agents, functions: { lookup }, ...extra }, { env: MODEL_ENV, fetch: model.fetch });

/** A promise and the function that resolves it. */
function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe("starting an agent in the background", () => {
  it("returns a handle at once, and its answer is collected later and paid for", async () => {
    const model = endpoint((sent, all) => {
      if (!isLead(sent)) return resultsOf(sent).length ? { text: "Order 7 was delivered." } : { calls: [{ name: "lookup", args: { id: "7" } }] };
      const turn = leadTurn(all);
      if (turn === 1) return { calls: [{ name: "researcher", args: { task: "Find the status of order 7.", background: true } }] };
      if (turn === 2) return { calls: [{ name: "collect_agent", args: { handle: "a1" } }] };
      return { text: "It was delivered." };
    });
    const app = await build(model);
    const answer = await app.ask("lead", "where is order 7?");

    const lead = model.sent.filter(isLead);
    // The same tool, with one more argument, and the four that act on a handle.
    expect(toolsOf(lead[0]!)).toEqual(expect.arrayContaining(["researcher", "check_agent", "steer_agent", "cancel_agent", "collect_agent"]));
    expect(resultsOf(lead[1]!)[0]).toContain('Started researcher as "a1"');
    expect(resultsOf(lead[2]!)[1]).toBe("Order 7 was delivered.");
    expect(answer.text).toBe("It was delivered.");
    // Three calls by the lead and two by the researcher, all on the bill.
    expect(answer.usage.inputTokens).toBe(50);
    await app.close();
  });

  it("is not offered to an agent that did not ask for it", async () => {
    const model = endpoint(() => ({ text: "Fine." }));
    const app = await build(model, { agents: { ...agents, lead: agent({ name: "lead", role: "Coordinate.", quality: "fast", tools: ["researcher"] }) } });
    await app.ask("lead", "hello");

    expect(toolsOf(model.sent[0]!)).not.toContain("collect_agent");
    const offered = (model.sent[0]!.body.tools as { name: string; input_schema: { properties: object } }[]).find((tool) => tool.name === "researcher")!;
    expect(Object.keys(offered.input_schema.properties)).toEqual(["task"]);
    await app.close();
  });

  it("passes the guard as the agent it is, so what is refused in front is refused in the background", async () => {
    const model = endpoint((sent, all) => {
      if (!isLead(sent)) return { text: "should never be asked" };
      return leadTurn(all) === 1 ? { calls: [{ name: "researcher", args: { task: "x", background: true } }] } : { text: "Could not." };
    });
    const app = await build(model, { guard: guard(({ tool }) => (tool === "researcher" ? "Research is closed today." : undefined)) });
    await app.ask("lead", "look into it");

    expect(resultsOf(model.sent.filter(isLead)[1]!)).toEqual(["Research is closed today."]);
    expect(model.sent.some((sent) => !isLead(sent))).toBe(false);
    await app.close();
  });
});

describe("an agent that is working in the background", () => {
  it("can be checked without waiting, and steered: it reads the message before its next step", async () => {
    const held = gate();
    const model = endpoint((sent, all) => {
      if (!isLead(sent)) {
        // Its first reply is held until the lead has had time to steer it.
        if (!resultsOf(sent).length) return { calls: [{ name: "lookup", args: { id: "7" } }], wait: held.opened };
        return { text: `Answered having read: ${textsOf(sent).at(-1)}` };
      }
      const turn = leadTurn(all);
      if (turn === 1) return { calls: [{ name: "researcher", args: { task: "Find order 7.", background: true } }] };
      if (turn === 2) return { calls: [{ name: "check_agent", args: { handle: "a1" } }] };
      if (turn === 3) return { calls: [{ name: "steer_agent", args: { handle: "a1", message: "Only the delivery date matters." } }] };
      if (turn === 4) {
        held.open();
        return { calls: [{ name: "collect_agent", args: { handle: "a1" } }] };
      }
      return { text: "Done." };
    });
    const app = await build(model);
    await app.ask("lead", "where is order 7?");

    const lead = model.sent.filter(isLead);
    expect(resultsOf(lead[2]!)[1]).toMatch(/^a1 \(researcher\): working for \d+s, no tool calls yet\.$/);
    expect(resultsOf(lead[3]!)[2]).toBe("Sent. a1 will read it before its next step.");
    // The researcher saw the message as a turn after its tool result, marked as from its asker.
    expect(resultsOf(lead[4]!)[3]).toBe(
      "Answered having read: [A message from the agent that gave you this task, sent while you were working: Only the delivery date matters.]",
    );
    await app.close();
  });

  it("can be cancelled, which stops the model call it was waiting on", async () => {
    const never = new Promise(() => undefined);
    const model = endpoint((sent, all) => {
      if (!isLead(sent)) return { text: "never said", wait: never };
      const turn = leadTurn(all);
      if (turn === 1) return { calls: [{ name: "researcher", args: { task: "Take your time.", background: true } }] };
      if (turn === 2) return { calls: [{ name: "cancel_agent", args: { handle: "a1" } }] };
      if (turn === 3) return { calls: [{ name: "collect_agent", args: { handle: "a1" } }] };
      return { text: "Gave up on it." };
    });
    const app = await build(model);
    const answer = await app.ask("lead", "look into it");

    const lead = model.sent.filter(isLead);
    expect(resultsOf(lead[2]!)[1]).toContain("Cancelled a1 (researcher)");
    expect(resultsOf(lead[3]!)[2]).toMatch(/^a1 \(researcher\): cancelled after \d+s\.$/);
    expect(model.aborted).toEqual([expect.stringContaining("Find things out.")]);
    expect(answer.text).toBe("Gave up on it.");
    await app.close();
  });

  it("is stopped when the request that started it answers without collecting it", async () => {
    const never = new Promise(() => undefined);
    const model = endpoint((sent, all) => {
      if (!isLead(sent)) return { text: "never said", wait: never };
      return leadTurn(all) === 1 ? { calls: [{ name: "researcher", args: { task: "Take your time.", background: true } }] } : { text: "Not waiting." };
    });
    const app = await build(model);
    const answer = await app.ask("lead", "look into it");

    expect(answer.text).toBe("Not waiting.");
    expect(answer.notes?.join(" ")).toContain("a1 (researcher) was still working in the background");
    expect(model.aborted).toHaveLength(1);
    await app.close();
  });

  it("a failure is reported on its handle rather than ending the request that started it", async () => {
    const model = endpoint((sent, all) => {
      if (!isLead(sent)) throw new Error("the endpoint fell over");
      const turn = leadTurn(all);
      if (turn === 1) return { calls: [{ name: "researcher", args: { task: "x", background: true } }] };
      if (turn === 2) return { calls: [{ name: "collect_agent", args: { handle: "a1" } }] };
      return { text: "It failed." };
    });
    const app = await build(model);
    const answer = await app.ask("lead", "look into it");

    expect(resultsOf(model.sent.filter(isLead)[2]!)[1]).toMatch(/^a1 \(researcher\): failed after \d+s: .*the endpoint fell over/);
    expect(answer.text).toBe("It failed.");
    await app.close();
  });
});

describe("the agents one request has working", () => {
  const forever = (during: Work): Promise<string> =>
    new Promise((_resolve, reject) => during.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));

  it("are bounded, and the bound is said as a reason", () => {
    const crew = new Crew();
    for (let at = 0; at < MAX_RUNNING; at++) expect(crew.start("worker", forever)).toContain("Started worker");

    expect(crew.start("worker", forever)).toContain(`${MAX_RUNNING} is the limit`);
    expect(crew.stopAll()).toHaveLength(MAX_RUNNING);
  });

  it("name what they know when a handle is wrong, and do not steer or cancel what has finished", async () => {
    const crew = new Crew();
    expect(crew.check("a9")).toContain("No agent has been started");
    crew.start("worker", async () => "all done");
    expect(await crew.collect("a1")).toBe("all done");

    expect(crew.check("a9")).toBe('No agent was started as "a9". Started: a1.');
    expect(crew.steer("a1", "hurry")).toContain("Not sent: a1 (worker): finished");
    expect(crew.cancel("a1")).toContain("Nothing to cancel");
    expect(crew.check()).toContain("Its answer is ready");
  });

  it("stop with the request that started them", async () => {
    const parent = new AbortController();
    const crew = new Crew();
    crew.start("worker", forever, parent.signal);
    parent.abort(new Error("the caller hung up"));

    expect(await crew.collect("a1")).toMatch(/cancelled|failed/);
  });

  it("an answer that arrives after a cancel is not the outcome", async () => {
    const held = gate();
    const crew = new Crew();
    crew.start("worker", async () => {
      await held.opened;
      return "too late";
    });
    crew.cancel("a1");
    held.open();

    expect(await crew.collect("a1")).toMatch(/^a1 \(worker\): cancelled/);
  });
});

describe("steering a request that is under way", () => {
  it("what the caller says is read before the next step, and a message that arrives as the work ends is still read", async () => {
    const pending = ["Use metric units."];
    const model = endpoint((sent, all) => {
      if (all.length === 1) return { calls: [{ name: "lookup", args: { id: "7" } }] };
      if (all.length === 2) {
        pending.push("And keep it short.");
        return { text: "A long answer in miles." };
      }
      return { text: `Short, metric. Heard: ${textsOf(sent).slice(1).join(" | ")}` };
    });
    const app = await build(model, { agents: { helper: agent({ name: "helper", role: "Help.", quality: "fast", tools: ["lookup"] }) } });
    const answer = await app.ask("helper", "how far is it?", { steer: () => pending.splice(0) });

    expect(answer.text).toBe("Short, metric. Heard: Use metric units. | And keep it short.");
    await app.close();
  });
});
