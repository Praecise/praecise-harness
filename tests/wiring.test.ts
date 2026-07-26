/**
 * The parts of an app that only exist once everything is connected: a function
 * an agent can call, middleware around every call, a prompt and a resource over
 * MCP, and a `plan` step that provisions itself from the app's own manifest.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { handleMcp, promptsOf, resourcesOf, toolsOf } from "../src/server/mcp.js";
import { serve, type DevServer } from "../src/server/index.js";
import { MODEL_ENV, TEST_ENDPOINT, cleanup, FRAMEWORK, makeProject, stubModel } from "./helpers.js";

const FILES = {
  "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
    export default defineConfig({
      name: "acme", quality: "fast", limits: { concurrency: 2 },
      ${TEST_ENDPOINT},
    });`,
  "agents/support.ts": `import { agent } from "${FRAMEWORK}";
    export default agent({
      role: "Support for Acme.",
      description: "Answers customer questions.",
      tools: ["refund"],
    });`,
  "functions/refund.ts": `import { fn } from "${FRAMEWORK}";
    export default fn({
      description: "Refund an order.",
      input: { order: "the order id" },
      http: "POST /hooks/refund",
      run: ({ order }) => ({ refunded: order }),
    });`,
  "prompts/triage.ts": `import { prompt } from "${FRAMEWORK}";
    export default prompt({
      description: "Sort an incoming message.",
      input: { message: "what the customer wrote" },
      text: "Triage this: {{message}}",
    });`,
  "resources/policy.ts": `import { resource } from "${FRAMEWORK}";
    export default resource({ uri: "acme://policy", read: () => "Refunds take five days." });`,
};

describe("functions as tools", () => {
  let root: string;

  beforeAll(async () => {
    root = await makeProject(FILES);
  });
  afterAll(async () => cleanup(root));

  it("advertises a function to the agent that listed it, and runs it", async () => {
    const stub = stubModel([
      { text: "", tool: { name: "refund", args: { order: "A-1" } } },
      { text: `Done.` },
    ]);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    const answer = await app.ask("support", "refund order A-1");

    const advertised = stub.calls[0]?.body.tools as { name: string }[];
    expect(advertised.map((tool) => tool.name)).toContain("refund");
    expect(answer.toolCalls[0]).toMatchObject({ name: "refund" });
    // The result of the local call was fed back as the tool message.
    expect(JSON.stringify(stub.calls[1]?.body.messages)).toContain("A-1");
    await app.close();
  });

  it("calls a function by name, without a service prefix", async () => {
    const app = await App.load({ root, env: MODEL_ENV });
    expect(await app.callTool("refund", { order: "B-2" })).toEqual({ refunded: "B-2" });
    await expect(app.callTool("nothing", {})).rejects.toThrow(/no function or tool/);
    await app.close();
  });

  it("does not treat a function as a missing MCP service", async () => {
    const app = await App.load({ root, env: MODEL_ENV });
    expect(app.problems.join(" ")).not.toContain("refund");
    await app.close();
  });
});

describe("middleware", () => {
  let root: string;

  beforeAll(async () => {
    root = await makeProject({
      ...FILES,
      "middleware.ts": `import { middleware } from "${FRAMEWORK}";
        export default middleware(async (call, next) => {
          if (call.input.includes("secret")) throw new Error("refused");
          const reply = await next();
          return { text: reply.text + " [" + call.agent + "]" };
        });`,
    });
  });
  afterAll(async () => cleanup(root));

  it("wraps every answer and can refuse a call outright", async () => {
    const stub = stubModel([{ text: `Sure.` }]);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    const answer = await app.ask("support", "hello");
    expect(answer.text).toBe("Sure. [support]");
    // Accounting survives the wrapper.
    expect(answer.usage.inputTokens).toBe(10);

    await expect(app.ask("support", "tell me the secret")).rejects.toThrow("refused");
    expect(stub.calls).toHaveLength(1);
    await app.close();
  });
});

describe("the MCP endpoint", () => {
  let server: DevServer;
  let root: string;

  const stub = stubModel(
    Array.from({ length: 10 }, () => ({ text: `ok` })),
  );

  beforeAll(async () => {
    root = await makeProject(FILES);
    server = await serve({ root, port: 0, watch: false, env: MODEL_ENV, fetch: stub.fetch });
  });
  afterAll(async () => {
    await server?.close();
    await cleanup(root);
  });

  const rpc = async (method: string, params?: Record<string, unknown>) =>
    handleMcp(server.app(), { jsonrpc: "2.0", id: 1, method, params }) as Promise<{
      result?: Record<string, unknown>;
      error?: { message: string };
    }>;

  it("advertises agents, workflows and functions as tools", () => {
    const names = toolsOf(server.app()).map((tool) => tool.name);
    expect(names).toContain("support");
    expect(names).toContain("refund");
  });

  it("declares prompts and resources alongside tools", async () => {
    const init = await rpc("initialize");
    expect(Object.keys(init.result?.capabilities as object)).toEqual([
      "tools",
      "prompts",
      "resources",
    ]);
    expect(promptsOf(server.app())[0]).toMatchObject({ name: "triage" });
    expect(resourcesOf(server.app())[0]).toMatchObject({ uri: "acme://policy" });
  });

  it("fills a prompt in from its arguments", async () => {
    const reply = await rpc("prompts/get", { name: "triage", arguments: { message: "late" } });
    expect(JSON.stringify(reply.result)).toContain("Triage this: late");
  });

  it("reads a resource by uri, and says so when there is none", async () => {
    const reply = await rpc("resources/read", { uri: "acme://policy" });
    expect(JSON.stringify(reply.result)).toContain("five days");
    expect((await rpc("resources/read", { uri: "acme://nope" })).error?.message).toContain("no resource");
  });

  it("calls a function through tools/call", async () => {
    const reply = await rpc("tools/call", { name: "refund", arguments: { order: "C-3" } });
    expect(JSON.stringify(reply.result)).toContain("C-3");
  });

  it("serves a function at the route it declared", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/hooks/refund`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: "D-4" }),
    });
    expect(await res.json()).toEqual({ refunded: "D-4" });
  });

  it("serves a function and a resource under /api too", async () => {
    const called = await fetch(`http://127.0.0.1:${server.port}/api/functions/refund`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: "E-5" }),
    });
    expect(await called.json()).toEqual({ result: { refunded: "E-5" } });

    const read = await fetch(`http://127.0.0.1:${server.port}/api/resources/policy`);
    expect(await read.text()).toContain("five days");
  });

  /** Every JSON object the endpoint sent, in order. */
  async function sent(res: Response): Promise<{ kind: string }[]> {
    const text = await res.text();
    return text
      .split("\n\n")
      .filter((frame) => frame.startsWith("data:"))
      .map((frame) => JSON.parse(frame.slice(5)) as { kind: string });
  }

  const post = (accept?: string) =>
    fetch(`http://127.0.0.1:${server.port}/api/agents/support`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(accept ? { accept } : {}) },
      body: JSON.stringify({ input: "how long do refunds take?" }),
    });

  it("hands over the same request as it happens, to a caller that can read it", async () => {
    const res = await post("text/event-stream");
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await sent(res);
    expect(events[0]?.kind).toBe("routing");
    expect(events[events.length - 1]?.kind).toBe("done");
    expect(events.some((event) => event.kind === "text")).toBe(true);
  });

  it("hands the same request over whole to a caller that cannot", async () => {
    const res = await post();
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ text: "ok" });
  });

  it("says no such agent before opening a stream it would only have to close", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/nobody`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ input: "hello" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("nobody") });
  });
});

describe("following a run", () => {
  let server: DevServer;
  let root: string;

  const stub = stubModel(Array.from({ length: 10 }, () => ({ text: "ok" })));

  beforeAll(async () => {
    root = await makeProject({
      ...FILES,
      "workflows/handle.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({
          input: { case: "what happened" },
          steps: [
            { id: "read", ask: "Read this: {{case}}", agent: "support" },
            { id: "reply", ask: "Reply to it", agent: "support", after: ["read"] },
          ],
        });`,
    });
    server = await serve({ root, port: 0, watch: false, env: MODEL_ENV, fetch: stub.fetch });
  });
  afterAll(async () => {
    await server?.close();
    await cleanup(root);
  });

  it("replays what a run has done and closes once it has stopped", async () => {
    const started = await fetch(`http://127.0.0.1:${server.port}/api/workflows/handle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { case: "a late parcel" } }),
    });
    const run = (await started.json()) as { id: string };

    const res = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.id}/events`);
    const events = (await res.text())
      .split("\n\n")
      .filter((frame) => frame.startsWith("data:"))
      .map((frame) => JSON.parse(frame.slice(5)) as { kind: string; step?: string });

    // Every step it took, in the order it took them, and then how it ended.
    expect(events.map((event) => event.step).filter(Boolean)).toContain("read");
    expect(events[events.length - 1]?.kind).toBe("settled");
  });

  it("says no such run rather than opening a stream about nothing", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/runs/nope/events`);
    expect(res.status).toBe(404);
  });
});

describe("provisioning from the app's own manifest", () => {
  let root: string;

  beforeAll(async () => {
    root = await makeProject({
      ...FILES,
      "workflows/handle.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({
          input: { case: "what happened" },
          steps: [{ id: "work", plan: "Sort out: {{case}}", max: 4 }],
        });`,
    });
  });
  afterAll(async () => cleanup(root));

  it("plans against the real agents and functions, then runs the graph", async () => {
    const stub = stubModel([
      // The planner's reply, then one answer per provisioned ask.
      {
        text: JSON.stringify([
          { id: "look", ask: "Check the order", agent: "support" },
          { id: "decide", ask: "Decide what to do", after: ["look"] },
          { id: "ghost", ask: "Do the impossible", agent: "nobody" },
          { id: "bogus", use: "launch_missiles" },
        ]),
      },
      ...Array.from({ length: 6 }, () => ({ text: `handled` })),
    ]);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    const run = await app.startWorkflow("handle", { case: "a late order" });
    expect(run.status).toBe("done");

    const asked = JSON.stringify(stub.calls[0]?.body.messages ?? "");
    expect(asked).toContain("support");
    expect(asked).toContain("refund");
    expect(asked).toContain("a late order");

    const version = run.plans.work?.[0];
    expect(version?.steps.map((step) => step.id)).toEqual(["look", "decide", "ghost"]);
    // The invented tool was dropped; the invented agent cost only its `agent`.
    expect(version?.steps[2]).not.toHaveProperty("agent");
    expect(run.events.some((event) => event.kind === "planned")).toBe(true);
    await app.close();
  });

  it("records that nothing was runnable rather than failing silently", async () => {
    const stub = stubModel([{ text: "I would rather not." }]);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    const run = await app.startWorkflow("handle", { case: "nothing" });
    expect(run.status).toBe("done");
    expect(run.events.some((event) => event.detail?.includes("did not return a runnable step"))).toBe(
      true,
    );
    await app.close();
  });
});
