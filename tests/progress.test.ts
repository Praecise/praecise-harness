/**
 * Watching a request happen.
 *
 * There is one rule to hold to and every test here is about it: nothing
 * reported is ever taken back. An interface may show each event the moment it
 * arrives and will never have to rewrite what it showed.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planAgent } from "../src/compile/plan.js";
import { loadProject } from "../src/project/load.js";
import { BuiltinHarness } from "../src/harness/builtin.js";
import { stream } from "../src/harness/stream.js";
import type { AskOptions, Message, Progress } from "../src/harness/types.js";
import { MODEL_ENV, TEST_MODELS, cleanup, FRAMEWORK, makeProject, stubModel } from "./helpers.js";

let state: string;
const roots: string[] = [];

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "praecise-progress-"));
});

afterEach(async () => {
  await rm(state, { recursive: true, force: true });
  await Promise.all(roots.splice(0).map(cleanup));
});

async function planFor(source: string) {
  const root = await makeProject({
    ...TEST_MODELS,
    "agents/a.ts": `import { agent } from "${FRAMEWORK}";\nexport default agent(${source});`,
  });
  roots.push(root);
  const project = await loadProject(root);
  return planAgent(project, project.agents.a!, { env: MODEL_ENV });
}

/** Long enough to read as work rather than as a greeting. */
const long = (characters: number) => "consider the following clause ".repeat(characters / 30);

/** Enough turns behind a request to push it to the edge of the cheap model's band. */
const borderline: Message[] = [
  { role: "user", content: "earlier" },
  { role: "assistant", content: "noted" },
  { role: "user", content: "and also" },
];

const kinds = (events: Progress[]) => events.map((event) => event.kind);
const only = <K extends Progress["kind"]>(events: Progress[], kind: K) =>
  events.filter((event): event is Extract<Progress, { kind: K }> => event.kind === kind);
const said = (events: Progress[]) =>
  only(events, "text")
    .map((event) => event.text)
    .join("");

async function watch(
  plan: Awaited<ReturnType<typeof planFor>>,
  fetchImpl: typeof fetch,
  input: string,
  options: AskOptions = {},
): Promise<Progress[]> {
  const harness = new BuiltinHarness({ stateDir: state, fetch: fetchImpl });
  const seen: Progress[] = [];
  for await (const event of stream(harness, plan, input, options)) seen.push(event);
  return seen;
}

describe("what is reported, and in what order", () => {
  it("says where the request is going before anything has been spent on it", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: false }`);
    const seen = await watch(plan, stubModel([{ text: "Five days." }]).fetch, "how long?");

    expect(seen[0]?.kind).toBe("routing");
    const [routing] = only(seen, "routing");
    expect(routing?.rungs).toBe(3);
    expect(routing?.difficulty).toBeGreaterThanOrEqual(0);
  });

  it("ends on the answer, and only once", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: false }`);
    const seen = await watch(plan, stubModel([{ text: "Five days." }]).fetch, "how long?");

    expect(only(seen, "done")).toHaveLength(1);
    expect(seen[seen.length - 1]?.kind).toBe("done");
    expect(only(seen, "done")[0]?.answer.text).toBe("Five days.");
  });

  it("names the model before that model has said anything", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: false }`);
    const seen = await watch(plan, stubModel([{ text: "Five days." }]).fetch, "how long?");

    const order = kinds(seen);
    expect(order.indexOf("answering")).toBeLessThan(order.indexOf("text"));
    expect(only(seen, "answering")[0]?.model).toContain("small");
  });

  it("reports the failure rather than throwing it at the reader", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: false }`);
    const dead = (async () => new Response("no", { status: 500 })) as typeof fetch;
    const seen = await watch(plan, dead, "how long?");

    expect(seen[seen.length - 1]?.kind).toBe("failed");
    expect(only(seen, "done")).toHaveLength(0);
  });
});

describe("the answer as it is written", () => {
  it("hands over the answer in fragments, which add up to the answer", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: false }`);
    const seen = await watch(plan, stubModel([{ text: "Refunds take five days." }]).fetch, "how?");

    expect(only(seen, "text").length).toBeGreaterThan(1);
    expect(said(seen)).toBe("Refunds take five days.");
    expect(only(seen, "done")[0]?.answer.text).toBe("Refunds take five days.");
  });

  it("holds the answer back while it is still deciding whether to keep it", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "balanced", memory: false }`);
    const stub = stubModel([
      { text: "Refunds are settled within five business days." },
      { text: "Refunds settle within five business days." },
    ]);
    const seen = await watch(plan, stub.fetch, long(2500), { history: borderline });

    // It was checked, so no fragment of it could honestly have been shown.
    expect(only(seen, "checking")).toHaveLength(1);
    expect(only(seen, "text")).toHaveLength(0);
    expect(only(seen, "done")[0]?.answer.text).toContain("five business days");
  });

  it("says how alike the samples were, and whether that was enough", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "balanced", memory: false }`);
    const stub = stubModel([
      { text: "Refunds are settled within five business days." },
      { text: "Refunds settle within five business days." },
    ]);
    const seen = await watch(plan, stub.fetch, long(2500), { history: borderline });

    const [checked] = only(seen, "checked");
    expect(checked?.kept).toBe(true);
    expect(checked?.agreement).toBeGreaterThan(0.5);
  });

  it("says which model it is going to instead, and why, before going there", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "balanced", memory: false }`);
    const stub = stubModel([
      { text: "Maybe a week, hard to say." },
      { text: "Refunds are instant." },
      { text: "Five business days." },
    ]);
    const seen = await watch(plan, stub.fetch, long(2500), { history: borderline });

    const [climbing] = only(seen, "climbing");
    expect(climbing?.from).toContain("small");
    expect(climbing?.to).toContain("mid");
    expect(climbing?.why).toBeTruthy();

    const order = kinds(seen);
    expect(order.lastIndexOf("climbing")).toBeLessThan(order.lastIndexOf("answering"));
  });

  it("shows nothing of an answer it went on to throw away", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "balanced", memory: false }`);
    const stub = stubModel([
      { text: "Maybe a week, hard to say." },
      { text: "Refunds are instant." },
      { text: "Five business days." },
    ]);
    const seen = await watch(plan, stub.fetch, long(2500), { history: borderline });

    expect(said(seen)).toBe("Five business days.");
    expect(only(seen, "done")[0]?.answer.text).toBe("Five business days.");
  });
});

describe("a rung that has already spoken keeps the request", () => {
  it("does not climb away from a refusal it has already begun answering", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: false }`);
    const stub = stubModel([
      { text: "I can say this much.", stop: "refusal" },
      { text: "A better answer." },
    ]);
    const seen = await watch(plan, stub.fetch, "how long?");

    // One model was asked, and what it said stands.
    expect(stub.calls).toHaveLength(1);
    expect(said(seen)).toBe("I can say this much.");
    expect(only(seen, "climbing")).toHaveLength(0);
  });

  it("still climbs away from a refusal nobody was shown", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: false }`);
    const stub = stubModel([
      { text: "I can say this much.", stop: "refusal" },
      { text: "A better answer." },
    ]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    const answer = await harness.ask(plan, "how long?");

    expect(answer.text).toBe("A better answer.");
    expect(stub.calls).toHaveLength(2);
  });
});

describe("tools, as they are called", () => {
  const withTool = `{
    role: "Help.",
    quality: "best",
    memory: false,
    tools: ["lookup"],
  }`;

  async function toolPlan() {
    const root = await makeProject({
      ...TEST_MODELS,
      "functions/lookup.ts": `import { fn } from "${FRAMEWORK}";\nexport default fn({ description: "Look something up.", run: () => ({ days: 5 }) });`,
      "agents/a.ts": `import { agent } from "${FRAMEWORK}";\nexport default agent(${withTool});`,
    });
    roots.push(root);
    const project = await loadProject(root);
    return planAgent(project, project.agents.a!, { env: MODEL_ENV });
  }

  it("says a tool was called and how that went", async () => {
    const plan = await toolPlan();
    const stub = stubModel([
      { text: "", tool: { name: "lookup", args: { order: "a-1" } } },
      { text: "Five days." },
    ]);
    const seen = await watch(plan, stub.fetch, "how long?");

    expect(only(seen, "tool")[0]).toMatchObject({ name: "lookup", args: { order: "a-1" } });
    expect(only(seen, "tool result")[0]).toMatchObject({ name: "lookup", failed: false });

    const order = kinds(seen);
    expect(order.indexOf("tool")).toBeLessThan(order.indexOf("tool result"));
  });

  it("reads as a transcript: what it said, then what it did, then what it said", async () => {
    const plan = await toolPlan();
    const stub = stubModel([
      { text: "Let me look that up.", tool: { name: "lookup", args: {} } },
      { text: "Five days." },
    ]);
    const seen = await watch(plan, stub.fetch, "how long?");

    expect(said(seen)).toBe("Let me look that up.Five days.");
    expect(only(seen, "done")[0]?.answer.text).toBe("Five days.");

    const order = kinds(seen);
    expect(order.indexOf("text")).toBeLessThan(order.indexOf("tool"));
    expect(order.indexOf("tool result")).toBeLessThan(order.lastIndexOf("text"));
  });
});

describe("an agent that answers in a declared shape", () => {
  it("waits until the object is whole before handing any of it over", async () => {
    const plan = await planFor(
      `{ role: "Help.", quality: "best", memory: false, returns: { days: "how many" } }`,
    );
    const stub = stubModel([{ text: '{"days": 5}' }]);
    const seen = await watch(plan, stub.fetch, "how long?");

    expect(only(seen, "text")).toHaveLength(0);
    expect(only(seen, "done")[0]?.answer.data).toEqual({ days: 5 });
    expect(stub.calls[0]?.body.stream).toBeUndefined();
  });
});

describe("telling the developer and telling the interface", () => {
  it("reports a note as it happens and keeps it on the answer too", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "balanced", memory: false }`);
    const stub = stubModel([{ text: "A considered answer." }]);
    const seen = await watch(plan, stub.fetch, long(2500), {
      history: Array.from({ length: 8 }, () => ({ role: "user", content: "prior" }) as Message),
    });

    const notes = only(seen, "note").map((event) => event.text);
    expect(notes.join(" ")).toContain("started at mid");
    expect(only(seen, "done")[0]?.answer.notes).toEqual(notes);
  });

  it("asks for nothing to be streamed when nobody is watching", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: false }`);
    const stub = stubModel([{ text: "Five days." }]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    await harness.ask(plan, "how long?");

    expect(stub.calls[0]?.body.stream).toBeUndefined();
  });

  it("finishes the work even when the reader walks away half way through", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: true }`);
    const stub = stubModel([{ text: "Five days." }]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    for await (const event of stream(harness, plan, "how long?")) {
      if (event.kind === "text") break;
    }

    // The request ran to the end, which is what leaves the record written.
    expect(stub.calls).toHaveLength(1);
  });
});
