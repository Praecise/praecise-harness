import { afterEach, describe, expect, it } from "vitest";

import { agent, createApp, fn, tool, type App, type AppDefinition } from "../src/index.js";
import { scriptedModel, type Scripted, type ScriptedModelOptions } from "../src/testing/index.js";
import { cleanup, makeProject } from "./helpers.js";

/** An MCP server with `count` tools, as a fetch, and the calls it received. */
function service(count: number) {
  const called: string[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method: string; params?: { name: string } };
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    let result: unknown;
    if (body.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: {} };
    else if (body.method === "tools/list") {
      result = {
        tools: Array.from({ length: count }, (_, at) => ({
          name: `op_${at}`,
          description: `Operation number ${at} of the back office. ${"It does one particular thing to one particular record. ".repeat(6)}`,
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
        })),
      };
    } else {
      called.push(body.params!.name);
      result = { content: [{ type: "text", text: `${body.params!.name} done` }] };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: impl, called };
}

describe("a request narrows an agent's tools and knowledge", () => {
  let root: string | undefined;
  let app: App | undefined;
  const ran: string[] = [];

  afterEach(async () => {
    await app?.close();
    if (root) await cleanup(root);
    app = undefined;
    root = undefined;
    ran.length = 0;
  });

  const named = (name: string) =>
    fn({
      description: `Do the ${name} thing.`,
      input: { id: "the record id" },
      run: () => {
        ran.push(name);
        return `${name} done`;
      },
    });

  async function build(
    replies: Scripted[],
    definition: AppDefinition,
    endpoint: ScriptedModelOptions = {},
    fetchImpl?: typeof fetch,
  ) {
    root = await makeProject({});
    const model = scriptedModel(replies, endpoint);
    app = await createApp(
      { root, ...definition, config: { ...definition.config, models: model.models } },
      { env: { ACME_API_KEY: "k" }, ...(fetchImpl ? { fetch: fetchImpl } : {}) },
    );
    return model;
  }

  const offered = (model: ReturnType<typeof scriptedModel>, at = 0) => model.requests[at]!.tools.map((entry) => entry.name);

  it("offers only the tools listed, and refuses one that is called anyway", async () => {
    const model = await build([{ tool: { name: "refund", args: { id: "1" } } }, "done"], {
      agents: { desk: agent({ role: "You work the desk.", tools: ["lookup", "refund"] }) },
      functions: { lookup: named("lookup"), refund: named("refund") },
    });

    const answer = await app!.ask("desk", "refund order 1", { allow: { tools: ["lookup"] } });

    expect(offered(model)).toContain("lookup");
    expect(offered(model)).not.toContain("refund");
    expect(ran).toEqual([]);
    expect(model.requests[1]!.last).toContain("not among the tools this request may use");
    expect(answer.text).toBe("done");
  });

  it("offers everything where nothing was narrowed", async () => {
    const model = await build([{ tool: { name: "refund", args: { id: "1" } } }, "done"], {
      agents: { desk: agent({ role: "You work the desk.", tools: ["lookup", "refund"] }) },
      functions: { lookup: named("lookup"), refund: named("refund") },
    });
    await app!.ask("desk", "refund order 1");
    expect(offered(model)).toEqual(expect.arrayContaining(["lookup", "refund"]));
    expect(ran).toEqual(["refund"]);
  });

  it("treats an empty list as no tools, and a name the agent does not have as an error", async () => {
    const model = await build(["nothing to do"], {
      agents: { desk: agent({ role: "You work the desk.", tools: ["lookup"] }) },
      functions: { lookup: named("lookup"), refund: named("refund") },
    });

    await app!.ask("desk", "hello", { allow: { tools: [] } });
    expect(offered(model)).not.toContain("lookup");

    // `refund` exists in the app, and this agent was never given it.
    await expect(app!.ask("desk", "hello", { allow: { tools: ["lookup", "refund"] } })).rejects.toThrow(
      /agent "desk" has no tool called "refund"/,
    );
    expect(model.requests).toHaveLength(1);
  });

  it("holds an agent that is asked on the way to the same list", async () => {
    const model = await build(
      [
        { tool: { name: "desk", args: { task: "refund order 1" } } },
        { tool: { name: "refund", args: { id: "1" } } },
        "could not refund",
        "the desk could not",
      ],
      {
        agents: {
          lead: agent({ role: "You hand work to the desk.", tools: ["desk", "audit"] }),
          desk: agent({ role: "You work the desk.", tools: ["lookup", "refund"] }),
        },
        functions: { lookup: named("lookup"), refund: named("refund"), audit: named("audit") },
      },
    );

    await app!.ask("lead", "refund order 1", { allow: { tools: ["desk", "lookup"] } });

    expect(offered(model, 0)).toContain("desk");
    expect(offered(model, 0)).not.toContain("audit");
    // The desk has `refund`, and this request does not.
    expect(offered(model, 1)).toContain("lookup");
    expect(offered(model, 1)).not.toContain("refund");
    expect(ran).toEqual([]);
    expect(model.requests[2]!.last).toContain("not among the tools this request may use");
  });

  it("removes an agent that was not listed from the tools of the one asking", async () => {
    const model = await build([{ tool: { name: "desk", args: { task: "anything" } } }, "done"], {
      agents: {
        lead: agent({ role: "You hand work to the desk.", tools: ["desk", "audit"] }),
        desk: agent({ role: "You work the desk." }),
      },
      functions: { audit: named("audit") },
    });
    await app!.ask("lead", "go", { allow: { tools: ["audit"] } });
    expect(offered(model)).not.toContain("desk");
    // One request to the lead, one more after the refusal, and none to the desk.
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]!.last).toContain("not among the tools this request may use");
  });

  it("narrows a service to one of its tools, and to none of the others by any route", async () => {
    const acme = service(3);
    const model = await build(
      [{ tool: { name: "acme__op_1", args: { id: "1" } } }, { tool: { name: "acme__op_2", args: { id: "1" } } }, "done"],
      {
        agents: { desk: agent({ role: "You work the desk.", tools: ["acme"] }) },
        tools: { acme: tool({ url: "https://mcp.example/acme" }) },
      },
      {},
      acme.fetch,
    );

    await app!.ask("desk", "go", { allow: { tools: ["acme__op_2"] } });
    expect(offered(model).filter((name) => name.startsWith("acme__"))).toEqual(["acme__op_2"]);
    expect(acme.called).toEqual(["op_2"]);
    expect(model.requests[1]!.last).toContain("not among the tools this request may use");
  });

  it("lets a whole service through by the name the agent gave it", async () => {
    const acme = service(3);
    const model = await build(
      ["done"],
      {
        agents: { desk: agent({ role: "You work the desk.", tools: ["acme", "lookup"] }) },
        tools: { acme: tool({ url: "https://mcp.example/acme" }) },
        functions: { lookup: named("lookup") },
      },
      {},
      acme.fetch,
    );
    await app!.ask("desk", "go", { allow: { tools: ["acme"] } });
    expect(offered(model).filter((name) => name.startsWith("acme__"))).toHaveLength(3);
    expect(offered(model)).not.toContain("lookup");
  });

  it("finds and calls only what is listed when there are too many tools to list", async () => {
    const acme = service(40);
    const model = await build(
      [
        { tool: { name: "find_tools", args: { query: "operation back office record" } } },
        { tool: { name: "use_tool", args: { name: "acme__op_7", args: { id: "1" } } } },
        { tool: { name: "use_tool", args: { name: "acme__op_3", args: { id: "1" } } } },
        "done",
      ],
      {
        agents: { desk: agent({ role: "You work the desk.", tools: ["acme"] }) },
        tools: { acme: tool({ url: "https://mcp.example/acme" }) },
      },
      { endpoint: { room: 20_000 } },
      acme.fetch,
    );

    const allowed = Array.from({ length: 20 }, (_, at) => `acme__op_${at}`).filter((name) => name !== "acme__op_7");
    await app!.ask("desk", "go", { allow: { tools: allowed } });

    expect(offered(model)).toEqual(expect.arrayContaining(["find_tools", "use_tool"]));
    // What the search returned names nothing outside the list.
    expect(model.requests[1]!.last).not.toContain("acme__op_7\n");
    expect(model.requests[1]!.last).not.toMatch(/acme__op_(2\d|3\d)\n/);
    // Asked for by name through the stand-in, a tool outside the list is not called.
    expect(acme.called).toEqual(["op_3"]);
  });

  const knowledge = [
    { name: "pricing", content: "The standard plan costs forty-two florins a month." },
    { name: "returns", content: "Goods may be sent back within ninety-one days." },
  ];

  it("leaves out of the instructions what a request does not list under knows", async () => {
    const model = await build(["a", "b"], {
      agents: { desk: agent({ role: "You work the desk.", rules: ["Be brief."] }) },
      knowledge,
      config: { preference: "quality" },
    });
    const before = app!.plans.desk!.instructions;

    await app!.ask("desk", "what does it cost?", { allow: { knows: ["pricing"] } });
    expect(model.requests[0]!.system).toContain("forty-two florins");
    expect(model.requests[0]!.system).not.toContain("ninety-one days");
    expect(model.requests[0]!.system).toContain("You work the desk.");
    expect(model.requests[0]!.system).toContain("Be brief.");

    // The agent itself is as it was: the next request knows everything again.
    expect(app!.plans.desk!.instructions).toBe(before);
    await app!.ask("desk", "and returns?");
    expect(model.requests[1]!.system).toContain("forty-two florins");
    expect(model.requests[1]!.system).toContain("ninety-one days");
  });

  it("narrows by the entries the agent declared, and to nothing with an empty list", async () => {
    const model = await build(["a", "b"], {
      agents: { desk: agent({ role: "You work the desk.", knows: ["pricing", "Refunds over 500 need a manager."] }) },
      knowledge,
      config: { preference: "quality" },
    });

    await app!.ask("desk", "q", { allow: { knows: ["Refunds over 500 need a manager."] } });
    expect(model.requests[0]!.system).toContain("Refunds over 500 need a manager.");
    expect(model.requests[0]!.system).not.toContain("forty-two florins");

    await app!.ask("desk", "q", { allow: { knows: [] } });
    expect(model.requests[1]!.system).not.toContain("forty-two florins");
    expect(model.requests[1]!.system).not.toContain("Refunds over 500");
  });

  it("refuses a name the agent does not know, and never learns from one", async () => {
    const model = await build(["a"], {
      agents: { desk: agent({ role: "You work the desk.", knows: ["pricing"] }) },
      knowledge,
    });
    // `returns` is a document of this app, and not one this agent was given.
    await expect(app!.ask("desk", "q", { allow: { knows: ["pricing", "returns"] } })).rejects.toThrow(
      /agent "desk" does not know "returns"/,
    );
    expect(model.requests).toHaveLength(0);
  });

  it("holds an agent asked on the way to the same documents", async () => {
    const model = await build([{ tool: { name: "desk", args: { task: "what does it cost" } } }, "forty-two", "done"], {
      agents: {
        lead: agent({ role: "You hand work to the desk.", tools: ["desk"], knows: ["pricing"] }),
        desk: agent({ role: "You work the desk." }),
      },
      knowledge,
    });
    await app!.ask("lead", "q", { allow: { knows: ["pricing"] } });
    expect(model.requests[1]!.system).toContain("You work the desk.");
    expect(model.requests[1]!.system).toContain("forty-two florins");
    expect(model.requests[1]!.system).not.toContain("ninety-one days");
  });
});
