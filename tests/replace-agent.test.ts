import { afterEach, describe, expect, it } from "vitest";

import { agent, createApp, fn, tool, workflow, type App, type AppDefinition } from "../src/index.js";
import { agentCard } from "../src/server/a2a.js";
import { toolsOf } from "../src/server/mcp.js";
import { scriptedModel, type Scripted } from "../src/testing/index.js";
import { cleanup, makeProject } from "./helpers.js";

/** Two MCP servers on one fetch: each offers one tool, named after its host. */
const services = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const host = new URL(String(input)).hostname.split(".")[0]!;
  const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method: string };
  if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
  const result =
    body.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: {} }
      : body.method === "tools/list"
        ? { tools: [{ name: `${host}_search`, description: `Search ${host}.`, inputSchema: { type: "object", properties: {} } }] }
        : { content: [{ type: "text", text: "ok" }] };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

describe("one agent replaced in a running app", () => {
  let root: string | undefined;
  let app: App | undefined;

  afterEach(async () => {
    await app?.close();
    if (root) await cleanup(root);
    app = undefined;
    root = undefined;
  });

  async function build(replies: Scripted[], definition: AppDefinition, fallback: Scripted = "ok") {
    root = await makeProject({});
    const model = scriptedModel(replies, { fallback });
    app = await createApp(
      { root, ...definition, config: { ...definition.config, models: model.models, preference: "quality" } },
      { fetch: services, env: { OLD_API_KEY: "k", NEW_API_KEY: "k" } },
    );
    return model;
  }

  it("answers the next request with the new agent, and returns its plan", async () => {
    const model = await build([], { agents: { desk: agent({ role: "You work the desk." }) } });
    await app!.ask("desk", "hello");

    const plan = await app!.replace(agent({ name: "desk", role: "You work the night desk.", rules: ["Whisper."] }));

    expect(plan.instructions).toContain("You work the night desk.");
    expect(app!.plans.desk).toBe(plan);
    expect(app!.project.agents.desk!.role).toBe("You work the night desk.");
    await app!.ask("desk", "hello again");
    expect(model.requests[0]!.system).toContain("You work the desk.");
    expect(model.requests[1]!.system).toContain("You work the night desk.");
    expect(model.requests[1]!.system).toContain("Whisper.");
  });

  it("lets a request under way finish on the agent it started with", async () => {
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const underWay = new Promise<void>((resolve) => (started = resolve));
    // Replies are decided by who is asking, since the two requests overlap.
    const byAgent: Scripted = (request) =>
      !request.system.includes("You are the old desk.")
        ? "ok"
        : request.last === "done"
          ? "old agent finished"
          : { tool: { name: "slow", args: {} } };
    const model = await build([], {
      agents: { desk: agent({ role: "You are the old desk.", tools: ["slow"] }) },
      functions: {
        slow: fn({
          description: "Take a while over something.",
          run: async () => {
            started();
            await waiting;
            return "done";
          },
        }),
      },
    }, byAgent);

    const first = app!.ask("desk", "go");
    await underWay;
    await app!.replace(agent({ name: "desk", role: "You are the new desk." }));
    const second = await app!.ask("desk", "go");
    release();
    const finished = await first;

    expect(finished.text).toBe("old agent finished");
    // The old request's second turn: old instructions, old tools.
    const resumed = model.requests.find((request) => request.last === "done")!;
    expect(resumed.system).toContain("You are the old desk.");
    expect(resumed.tools.map((entry) => entry.name)).toContain("slow");
    // The request made after the swap never saw either.
    const fresh = model.requests.find((request) => request.system.includes("You are the new desk."))!;
    expect(fresh.tools.map((entry) => entry.name)).not.toContain("slow");
    expect(second.text).toBe("ok");
  });

  it("connects to the new agent's services, and no longer offers the old one's", async () => {
    const model = await build([], {
      agents: { desk: agent({ role: "You work the desk.", tools: ["old"] }) },
      tools: { old: tool({ url: "https://old.example/mcp" }), new: tool({ url: "https://new.example/mcp" }) },
    });
    await app!.ask("desk", "hello");
    expect(model.requests[0]!.tools.map((entry) => entry.name)).toContain("old__old_search");

    await app!.replace(agent({ name: "desk", role: "You work the desk.", tools: ["new"] }));
    await app!.ask("desk", "hello");
    const offered = model.requests[1]!.tools.map((entry) => entry.name);
    expect(offered).toContain("new__new_search");
    expect(offered).not.toContain("old__old_search");
    expect((await app!.toolsFor("desk")).map((entry) => entry.name)).toEqual(["new__new_search"]);
  });

  it("refuses an agent that would not load, and leaves the running one as it was", async () => {
    const model = await build([], { agents: { desk: agent({ role: "You work the desk." }) } });
    const before = app!.plans.desk;

    await expect(app!.replace(agent({ name: "desk", role: "You remember.", memory: { store: "nowhere" } }))).rejects.toThrow(
      /agent "desk" cannot run as written:\s+agent "desk": memory names unknown store "nowhere"/,
    );
    await expect(app!.replace(agent({ name: "desk", role: "  " }))).rejects.toThrow(/`role` is required/);

    expect(app!.plans.desk).toBe(before);
    expect(app!.faults).toEqual([]);
    await app!.ask("desk", "still there?");
    expect(model.requests[0]!.system).toContain("You work the desk.");
  });

  it("needs the name of an agent the app has", async () => {
    await build([], { agents: { desk: agent({ role: "You work the desk." }) } });
    await expect(app!.replace(agent({ role: "Nameless." }))).rejects.toThrow(/has to carry its `name`/);
    await expect(app!.replace(agent({ name: "dsek", role: "Mistyped." }))).rejects.toThrow(/no agent named "dsek" to replace/);
    await expect(app!.add(agent({ name: "desk", role: "Again." }))).rejects.toThrow(/already an agent named "desk"/);
    expect(app!.agentNames).toEqual(["desk"]);
  });

  it("adds an agent that is askable and published at once, and re-plans the agents that hand work to it", async () => {
    const model = await build([], { agents: { lead: agent({ role: "You hand work on.", tools: ["audit"] }) }, functions: { audit: fn({ description: "Write an audit line down.", run: () => "ok" }) } });
    expect(app!.plans.lead!.delegates).toBeUndefined();

    await app!.add(agent({ name: "desk", role: "You work the desk.", description: "Answers questions about orders.", meta: { tags: ["orders"] } }));
    expect(app!.agentNames).toEqual(["desk", "lead"]);
    expect((await app!.ask("desk", "hello")).text).toBe("ok");
    expect(toolsOf(app!).map((entry) => entry.name)).toContain("desk");
    const skill = (agentCard(app!).skills as { id: string; tags: string[]; description: string }[]).find((entry) => entry.id === "desk")!;
    expect(skill).toMatchObject({ description: "Answers questions about orders.", tags: ["orders"] });

    // The lead is replaced with one that names the desk, and then the desk changes what it is for.
    await app!.replace(agent({ name: "lead", role: "You hand work on.", tools: ["audit", "desk"] }));
    expect(app!.plans.lead!.delegates).toEqual([expect.objectContaining({ name: "desk", description: "Answers questions about orders." })]);
    await app!.replace(agent({ name: "desk", role: "You work the desk.", description: "Answers questions about refunds." }));
    expect(app!.plans.lead!.delegates![0]!.description).toBe("Answers questions about refunds.");
    await app!.ask("lead", "hello");
    expect(model.requests.at(-1)!.tools.find((entry) => entry.name === "desk")!.description).toContain("refunds");
    // And the card says what the agent now is.
    expect((agentCard(app!).skills as { id: string; description: string }[]).find((entry) => entry.id === "desk")!.description).toBe(
      "Answers questions about refunds.",
    );
  });

  it("removes an agent nothing needs, and refuses to remove one something does", async () => {
    await build([], {
      agents: {
        lead: agent({ role: "You hand work on.", tools: ["desk"] }),
        desk: agent({ role: "You work the desk." }),
        writer: agent({ role: "You write." }),
        spare: agent({ role: "You wait." }),
      },
      workflows: { flow: workflow({ steps: [{ id: "draft", ask: "write it", agent: "writer" }] }) },
    });

    await expect(app!.remove("desk")).rejects.toThrow(/"lead" hands work to it/);
    await expect(app!.remove("writer")).rejects.toThrow(/agent "writer" cannot be removed/);
    await expect(app!.remove("nobody")).rejects.toThrow(/no agent named "nobody"/);
    expect(app!.agentNames).toEqual(["desk", "lead", "spare", "writer"]);

    await app!.remove("spare");
    expect(app!.agentNames).toEqual(["desk", "lead", "writer"]);
    await expect(app!.ask("spare", "hello")).rejects.toThrow(/no agent named "spare"/);
    expect(toolsOf(app!).map((entry) => entry.name)).not.toContain("spare");
  });

  it("makes changes asked for together one after another", async () => {
    await build([], { agents: { desk: agent({ role: "You work the desk." }) } });
    await Promise.all([
      app!.replace(agent({ name: "desk", role: "First." })),
      app!.replace(agent({ name: "desk", role: "Second." })),
      app!.replace(agent({ name: "desk", role: "Third." })),
    ]);
    expect(app!.plans.desk!.instructions).toContain("Third.");
  });
});
