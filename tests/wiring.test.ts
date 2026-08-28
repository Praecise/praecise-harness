/**
 * The parts of an app that only exist once everything is connected: a function
 * an agent can call, middleware around every call, a prompt and a resource over
 * MCP, and a `plan` step that provisions itself from the app's own manifest.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { App } from "../src/app.js";
import { handleMcp, promptsOf, resourcesOf, toolsOf } from "../src/server/mcp.js";
import { mcpRequest } from "../src/harness/mcp.js";
import { serve, type DevServer } from "../src/server/index.js";
import { MODEL_ENV, TEST_ENDPOINT, TEST_TOKEN, authed, cleanup, FRAMEWORK, makeProject, stubModel } from "./helpers.js";

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
    server = await serve({ root, port: 0, watch: false, env: MODEL_ENV, fetch: stub.fetch, token: TEST_TOKEN });
  });
  afterAll(async () => {
    await server?.close();
    await cleanup(root);
  });

  const rpc = async (method: string, params?: Record<string, unknown>) =>
    handleMcp(server.app(), mcpRequest(method, params)) as Promise<{
      result?: Record<string, unknown>;
      error?: { message: string };
    }>;

  it("advertises agents, workflows and functions as tools", () => {
    const names = toolsOf(server.app()).map((tool) => tool.name);
    expect(names).toContain("support");
    expect(names).toContain("refund");
  });

  it("declares prompts and resources alongside tools", async () => {
    const init = await rpc("server/discover");
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
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ order: "D-4" }),
    });
    expect(await res.json()).toEqual({ refunded: "D-4" });
  });

  it("serves a function and a resource under /api too", async () => {
    const called = await fetch(`http://127.0.0.1:${server.port}/api/functions/refund`, {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ order: "E-5" }),
    });
    expect(await called.json()).toEqual({ result: { refunded: "E-5" } });

    const read = await fetch(`http://127.0.0.1:${server.port}/api/resources/policy`, { headers: authed() });
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
      headers: authed({ "content-type": "application/json", ...(accept ? { accept } : {}) }),
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
      headers: authed({ "content-type": "application/json", accept: "text/event-stream" }),
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
    server = await serve({ root, port: 0, watch: false, env: MODEL_ENV, fetch: stub.fetch, token: TEST_TOKEN });
  });
  afterAll(async () => {
    await server?.close();
    await cleanup(root);
  });

  it("replays what a run has done and closes once it has stopped", async () => {
    const started = await fetch(`http://127.0.0.1:${server.port}/api/workflows/handle`, {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ input: { case: "a late parcel" } }),
    });
    const run = (await started.json()) as { id: string };

    const res = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.id}/events`, { headers: authed() });
    const events = (await res.text())
      .split("\n\n")
      .filter((frame) => frame.startsWith("data:"))
      .map((frame) => JSON.parse(frame.slice(5)) as { kind: string; step?: string });

    // Every step it took, in the order it took them, and then how it ended.
    expect(events.map((event) => event.step).filter(Boolean)).toContain("read");
    expect(events[events.length - 1]?.kind).toBe("settled");
  });

  it("says no such run rather than opening a stream about nothing", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/runs/nope/events`, { headers: authed() });
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
          // A plan step gets exactly the tools it names — least privilege — so this
          // one says which of the app's tools its graph may reach for.
          steps: [{ id: "work", plan: "Sort out: {{case}}", max: 4, tools: ["refund"] }],
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

describe("the app's own use-step wiring", () => {
  let root: string;

  beforeAll(async () => {
    root = await makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({ name: "acme", quality: "fast", ${TEST_ENDPOINT} });`,
      "functions/charge.ts": `import { fn } from "${FRAMEWORK}";
        export default fn({
          description: "Charge an amount.",
          effect: "destructive",
          run: (args, opts) => ({ amount: args.amount, key: opts?.idempotencyKey ?? null }),
        });`,
      "workflows/pay.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({
          description: "Charge once.",
          steps: [{ id: "charge", use: "charge", with: { amount: 100 } }],
        });`,
    });
  });
  afterAll(async () => cleanup(root));

  it("threads the derived idempotency key from a use step into the local function", async () => {
    const app = await App.load({ root, env: MODEL_ENV });
    const run = await app.startWorkflow("pay", {});
    expect(run.status).toBe("done");
    // The key the run derived reached the tool — the contract is honoured by the
    // framework's own App, not just by hand-built WorkflowDeps.
    expect((run.outputs.charge as { key: string }).key).toMatch(/^idem-/);
    await app.close();
  });

  it("passes an explicit key through a direct App.callTool", async () => {
    const app = await App.load({ root, env: MODEL_ENV });
    const got = await app.callTool("charge", { amount: 1 }, { idempotencyKey: "idem-fixed" });
    expect(got).toEqual({ amount: 1, key: "idem-fixed" });
    await app.close();
  });

  it("emits OTel GenAI spans to the app-level sink", async () => {
    const spans: { operation: string; name: string }[] = [];
    const app = await App.load({ root, env: MODEL_ENV, emit: (span) => spans.push(span) });
    await app.startWorkflow("pay", {});
    expect(spans.map((span) => span.operation)).toContain("execute_tool");
    expect(spans.find((span) => span.operation === "execute_tool")?.name).toBe("charge");
    await app.close();
  });
});

describe("concurrent calls into the same stdio tool", () => {
  /**
   * A server that records its own launch (one line per process start, appended
   * before it ever reads a request) and then answers `initialize`/`tools/list`/
   * `tools/call` for one tool, `echo`.
   *
   * The launch record is what the test asserts on: `clientFor` used to check its
   * cache, then await building a client before writing it back — a window two
   * concurrent callers for the same service could both pass, each launching (and
   * leaking) its own copy of a server the project declared as one.
   */
  const SPAWNING_SERVER = (marker: string) => `
    require("fs").appendFileSync(${JSON.stringify(marker)}, "spawned\\n");
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let cut;
      while ((cut = buffer.indexOf("\\n")) >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === undefined) continue;
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } }) + "\\n");
        } else if (msg.method === "tools/list") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }] } }) + "\\n");
        } else if (msg.method === "tools/call") {
          setTimeout(() => {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } }) + "\\n");
          }, 30);
        }
      }
    });
  `;

  let dir: string;
  let root: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "praecise-clientfor-"));
    const marker = join(dir, "spawns.log");
    root = await makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({ name: "acme", quality: "fast", ${TEST_ENDPOINT} });`,
      "tools/counter.ts": `import { tool } from "${FRAMEWORK}";
        export default tool({
          description: "A stdio service that records every launch.",
          command: [${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(SPAWNING_SERVER(marker))}],
        });`,
    });
  });
  afterAll(async () => {
    await cleanup(root);
    await rm(dir, { recursive: true, force: true });
  });

  it("launches the server once, not once per concurrent caller", async () => {
    const app = await App.load({ root, env: MODEL_ENV });
    await Promise.all([
      app.callTool("counter.echo", {}),
      app.callTool("counter.echo", {}),
      app.callTool("counter.echo", {}),
    ]);
    await app.close();

    const marker = join(dir, "spawns.log");
    const launches = (await readFile(marker, "utf8")).trim().split("\n").filter(Boolean);
    expect(launches).toHaveLength(1);
  });
});

describe("a guard on the app's direct tool calls", () => {
  let root: string;

  beforeAll(async () => {
    root = await makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({ name: "acme", quality: "fast", ${TEST_ENDPOINT} });`,
      "guard.ts": `import { guard } from "${FRAMEWORK}";
        export default guard(({ tool, args }) =>
          tool === "charge" && Number(args.amount) > 500
            ? "Charges over 500 need a person."
            : undefined,
        );`,
      "functions/charge.ts": `import { fn } from "${FRAMEWORK}";
        export default fn({
          description: "Charge an amount.",
          effect: "destructive",
          run: ({ amount }) => ({ charged: amount }),
        });`,
      "workflows/pay.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({
          description: "Charge whatever was asked.",
          input: { amount: "how much" },
          steps: [{ id: "charge", use: "charge", with: { amount: "{{amount}}" } }],
        });`,
    });
  });
  afterAll(async () => cleanup(root));

  it("a workflow use step the guard declines does not run the tool", async () => {
    const app = await App.load({ root, env: MODEL_ENV });
    const run = await app.startWorkflow("pay", { amount: 900 });
    expect(run.status).toBe("failed");
    expect(run.error).toContain("need a person");
    expect("charge" in run.outputs).toBe(false);
    await app.close();
  });

  it("a direct call is refused the same way, and an allowed one goes through", async () => {
    const app = await App.load({ root, env: MODEL_ENV });
    await expect(app.callTool("charge", { amount: 900 })).rejects.toThrow(/need a person/);
    expect(await app.callTool("charge", { amount: 5 })).toEqual({ charged: 5 });
    await app.close();
  });
});
