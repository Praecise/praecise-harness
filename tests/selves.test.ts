/**
 * Selves: an agent that remembers who it is, through a self provider.
 *
 * What these hold the harness to:
 *   - the self's context reaches the model after everything stable, and the work
 *     is recorded against its ticket after the answer
 *   - a ticket that reaches a browser is bound to the person it was issued to
 *   - a self per person needs a person, and never reveals who they are in its handle
 *   - a self is memory, not a dependency, unless the app says otherwise
 *   - an agent that is a self keeps no second memory beside it
 *   - the same self, ticket and rating on every surface: ask, watch, HTTP, MCP
 *   - the HTTP provider speaks the protocol exactly
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { agent, defineConfig } from "../src/define.js";
import type { Project } from "../src/project/load.js";
import { handleFor, openTicket, planSelf, selfFaults, selvesOverHttp, signTicket, type SelfProvider } from "../src/harness/selves.js";
import { mcpHeaders, mcpRequest } from "../src/harness/mcp.js";
import { serve, type DevServer } from "../src/server/index.js";
import { MODEL_ENV, TEST_TOKEN, authed, cleanup, FRAMEWORK, makeProject, stubModel, TEST_ENDPOINT } from "./helpers.js";

const MODELS = {
  house: { url: "https://models.test", credential: "HOUSE_KEY", speaks: "messages" as const, fast: "small", balanced: "mid", best: "large" },
};

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(cleanup)));

function project(root: string, spec: Parameters<typeof agent>[0], config: Partial<Project["config"]> = {}): Project {
  return {
    root, name: "house", config: defineConfig({ name: "house", quality: "fast", models: MODELS, ...config }),
    agents: { design: agent({ name: "design", ...spec }) },
    workflows: {}, tools: {}, functions: {}, prompts: {}, resources: {}, stores: {}, blueprints: {}, templates: {}, knowledge: [], warnings: [],
  };
}

/** A provider that remembers what it was asked. */
function fakeProvider(overrides: Partial<SelfProvider> = {}) {
  const seen = { context: [] as Array<{ handle: string; request: Record<string, unknown> }>, record: [] as Array<{ ticket: string; work: Record<string, unknown> }>, outcome: [] as Array<{ ticket: string; verdict: Record<string, unknown> }> };
  const provider: SelfProvider = {
    async context(handle, request) {
      seen.context.push({ handle, request: request as never });
      return { preamble: "You are Design.\nWhat you have learned here:\n- Archive pieces strengthen a story", ticket: "tk-1", drewOn: ["Archive pieces strengthen a story"] };
    },
    async record(ticket, work) { seen.record.push({ ticket, work: work as never }); },
    async outcome(ticket, verdict) { seen.outcome.push({ ticket, verdict: verdict as never }); },
    ...overrides,
  };
  return { provider, seen };
}

describe("declaring a self", () => {
  it("plans a handle, and a handle with {person} as a self per person", () => {
    expect(planSelf("design")).toEqual({ handle: "design", perPerson: false, surface: undefined, template: undefined });
    expect(planSelf({ handle: "coach-{person}" })?.perPerson).toBe(true);
    expect(selfFaults("Design Team")).not.toEqual([]);
    expect(selfFaults({ handle: "coach-{person}", template: { name: "Coach", charter: { purpose: "" } } }).join()).toMatch(/purpose/);
    expect(selfFaults("coach-{person}")).toEqual([]);
  });

  it("never puts a person in a handle, and a per-person self without one has no handle", () => {
    const plan = planSelf("coach-{person}")!;
    const anna = handleFor(plan, "anna@example.com")!;
    expect(anna).toMatch(/^coach-[0-9a-f]{12}$/);
    expect(anna).not.toContain("anna");
    expect(handleFor(plan, "anna@example.com")).toBe(anna);
    expect(handleFor(plan, "ben@example.com")).not.toBe(anna);
    expect(handleFor(plan, undefined)).toBeUndefined();
  });

  it("binds tickets to people", () => {
    const signed = signTicket("s", "tk-1", "anna");
    expect(openTicket("s", signed, "anna")).toBe("tk-1");
    expect(openTicket("s", signed, "ben")).toBeUndefined();
    expect(openTicket("other", signed, "anna")).toBeUndefined();
    expect(openTicket("s", `${signed}x`, "anna")).toBeUndefined();
  });

  it("refuses a self with a second memory beside it", async () => {
    const root = await makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}"; export default defineConfig({ name: "house", ${TEST_ENDPOINT} });`,
      "agents/design.ts": `import { agent } from "${FRAMEWORK}"; export default agent({ role: "Design.", self: "design", memory: true });`,
    });
    roots.push(root);
    const app = await App.load({ root, env: MODEL_ENV });
    expect(app.faults.join()).toMatch(/remembers through its self provider/);
    await app.close();
  });
});

describe("an agent that is a self", () => {
  it("reads its context into the system prompt, records the work, and carries a bound ticket", async () => {
    const root = await makeProject({});
    roots.push(root);
    const stub = stubModel([{ text: "Three archive pieces." }]);
    const { provider, seen } = fakeProvider();
    const app = await App.from(project(root, { role: "Find pieces.", self: "design" }), {
      env: { ...MODEL_ENV, SELVES_TICKET_SECRET: "secret" }, fetch: stub.fetch, selves: provider,
    });

    const events: string[] = [];
    const answer = await app.ask("design", "a warm evening story", { caller: { person: "anna" }, surface: "playground", onProgress: (e) => events.push(e.kind) });

    const system = JSON.stringify(stub.calls[0]!.body.system);
    expect(system).toContain("Archive pieces strengthen a story");
    expect(system.indexOf("Find pieces.")).toBeLessThan(system.indexOf("Archive pieces strengthen a story"));
    expect(seen.context[0]).toMatchObject({ handle: "design", request: { surface: "playground", task: "a warm evening story", interactive: true } });
    expect(seen.record).toEqual([{ ticket: "tk-1", work: { task: "a warm evening story", answer: "Three archive pieces.", tools: [] } }]);
    expect(answer.self).toMatchObject({ handle: "design", bound: true, drewOn: ["Archive pieces strengthen a story"] });
    expect(openTicket("secret", answer.self!.ticket!, "anna")).toBe("tk-1");
    expect(events).toContain("self");
    expect(events.indexOf("self")).toBeLessThan(events.indexOf("answering"));

    await expect(app.rate(answer.self!.ticket!, { signal: 1, label: "useful" }, "ben")).rejects.toThrow(/can no longer be rated/);
    await app.rate(answer.self!.ticket!, { signal: 1, label: "useful", by: "anna" }, "anna");
    expect(seen.outcome).toEqual([{ ticket: "tk-1", verdict: { signal: 1, label: "useful", by: "anna" } }]);
    await app.close();
  });

  it("gives each person their own self, created from the template with them as its subject", async () => {
    const root = await makeProject({});
    roots.push(root);
    const stub = stubModel([{ text: "ok" }, { text: "ok" }]);
    const { provider, seen } = fakeProvider();
    const app = await App.from(project(root, { role: "Coach.", self: { handle: "coach-{person}", template: { name: "Coach", charter: { purpose: "Coach one person." } } } }), { env: MODEL_ENV, fetch: stub.fetch, selves: provider });

    const plain = await app.ask("design", "hi");
    expect(plain.self).toBeUndefined();
    expect(plain.notes?.join()).toMatch(/names nobody/);
    expect(seen.context).toHaveLength(0);

    const mine = await app.ask("design", "hi", { caller: { person: "anna" } });
    expect(mine.self?.handle).toMatch(/^coach-[0-9a-f]{12}$/);
    expect((seen.context[0]!.request.template as { subject: string }).subject).toBe("anna");
    expect(mine.self?.bound).toBe(false);
    await app.close();
  });

  it("answers without its memory when the provider is down, unless the app requires it", async () => {
    const root = await makeProject({});
    roots.push(root);
    const down = fakeProvider({ async context() { throw new Error("connection refused"); } });

    const lenient = await App.from(project(root, { role: "Find pieces.", self: "design" }), { env: MODEL_ENV, fetch: stubModel([{ text: "Still here." }]).fetch, selves: down.provider });
    const answer = await lenient.ask("design", "hi");
    expect(answer.text).toBe("Still here.");
    expect(answer.self).toBeUndefined();
    expect(answer.notes?.join()).toMatch(/could not read what design remembers/);
    await lenient.close();

    const strict = await App.from(project(root, { role: "Find pieces.", self: "design" }, { selves: { required: true } }), { env: MODEL_ENV, fetch: stubModel([{ text: "x" }]).fetch, selves: down.provider });
    await expect(strict.ask("design", "hi")).rejects.toThrow(/could not read what design remembers/);
    await strict.close();
  });

  it("notes a self declared with no provider, and answers", async () => {
    const root = await makeProject({});
    roots.push(root);
    const app = await App.from(project(root, { role: "Find pieces.", self: "design" }), { env: MODEL_ENV, fetch: stubModel([{ text: "ok" }]).fetch });
    const answer = await app.ask("design", "hi");
    expect(answer.notes?.join()).toMatch(/no self provider/);
    await app.close();
  });
});

describe("the HTTP self provider", () => {
  it("speaks the protocol: context, creating from a template once, work and outcomes", async () => {
    const calls: Array<{ method: string; url: string; auth: string; body: Record<string, unknown> }> = [];
    let exists = false;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ method: String(init?.method), url, auth: String((init?.headers as Record<string, string> | undefined)?.authorization), body });
      if (url.endsWith("/selves/coach-1/context")) {
        if (!exists) return new Response(JSON.stringify({ error: "no self called coach-1" }), { status: 404 });
        return new Response(JSON.stringify({ preamble: "notes", ticket: "tk-9", lessons: [{ claim: "held one", status: "held" }, { claim: "a hunch", status: "candidate" }] }), { status: 200 });
      }
      if (init?.method === "PUT") { exists = true; return new Response(JSON.stringify({ created: true }), { status: 201 }); }
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }) as typeof fetch;

    const provider = selvesOverHttp({ url: "https://selves.test/", key: "member", adminKey: "admin", fetch: fetchImpl });
    const context = await provider.context("coach-1", { surface: "chat", task: "hello", interactive: true, template: { name: "Coach", charter: { purpose: "Coach." } } });
    expect(context).toEqual({ preamble: "notes", ticket: "tk-9", drewOn: ["held one"] });
    expect(calls.map((c) => `${c.method} ${c.url} ${c.auth}`)).toEqual([
      "POST https://selves.test/selves/coach-1/context Bearer member",
      "PUT https://selves.test/selves/coach-1 Bearer admin",
      "POST https://selves.test/selves/coach-1/context Bearer member",
    ]);
    expect(calls[1]!.body).toMatchObject({ orient: false, name: "Coach" });

    await provider.record("tk-9", { task: "hello", answer: "Hi   there", tools: [] });
    expect(calls.at(-1)).toMatchObject({ url: "https://selves.test/tickets/tk-9/work", body: { brief: "Asked: “hello”. Answered: Hi there" } });
    await provider.outcome("tk-9", { signal: 7, label: "useful" });
    expect(calls.at(-1)).toMatchObject({ url: "https://selves.test/tickets/tk-9/outcome", body: { signal: 1, label: "useful" } });
    expect(calls.at(-1)!.body.check).toBeUndefined();

    // A mechanical check travels with the verdict; something that is not a check does not.
    await provider.outcome("tk-9", { signal: -1, label: "reverted", check: { name: "measured", passed: false, failures: [{ step: "loudness", ground: "master bus" }] } });
    expect(calls.at(-1)!.body.check).toEqual({ name: "measured", ran: true, passed: false, failures: [{ step: "loudness", ground: "master bus" }] });
    await provider.outcome("tk-9", { signal: -1, label: "reverted", check: { passed: "no" } as never });
    expect(calls.at(-1)!.body.check).toBeUndefined();
  });
});

describe("a self over HTTP and MCP", () => {
  let server: DevServer;
  let root: string;
  const seen: string[] = [];
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  const stub = stubModel(Array.from({ length: 6 }, () => ({ text: "an answer" })));
  const both = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://selves.test")) return stub.fetch(input, init);
    seen.push(`${init?.method} ${url.slice("https://selves.test".length)}`);
    sent.push({ path: url.slice("https://selves.test".length), body: JSON.parse(String(init?.body ?? "{}")) });
    if (url.endsWith("/context")) return new Response(JSON.stringify({ preamble: "notes", ticket: "tk-http", lessons: [] }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  }) as typeof fetch;

  beforeAll(async () => {
    root = await makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}"; export default defineConfig({ name: "house", quality: "fast", ${TEST_ENDPOINT}, selves: { surface: "estate" } });`,
      "agents/design.ts": `import { agent } from "${FRAMEWORK}"; export default agent({ role: "Find pieces.", description: "Finds pieces that carry an idea.", self: "design" });`,
    });
    server = await serve({ root, port: 0, watch: false, fetch: both, token: TEST_TOKEN, env: { ...MODEL_ENV, SELVES_URL: "https://selves.test", SELVES_KEY: "member", SELVES_TICKET_SECRET: "secret" } });
  });
  afterAll(async () => { await server?.close(); await cleanup(root); });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: authed({ "content-type": "application/json", ...headers }), body: JSON.stringify(body) });

  it("answers over HTTP with the self and a ticket bound to the person, and takes the rating", async () => {
    const answer = (await (await post("/api/agents/design", { input: "a story", person: "anna" })).json()) as { self: { handle: string; ticket: string; bound: boolean } };
    expect(answer.self).toMatchObject({ handle: "design", bound: true });
    expect(seen).toContain("POST /selves/design/context");
    expect(seen).toContain("POST /tickets/tk-http/work");

    expect((await post("/api/selves/outcome", { ticket: answer.self.ticket, useful: true, person: "ben" })).status).toBe(400);
    expect(sent.find((s) => s.path === "/selves/design/context")!.body.surface).toBe("estate");

    expect((await post("/api/selves/outcome", { ticket: answer.self.ticket, useful: false, why: "no archive", person: "anna", check: { name: "tests", passed: false, failures: [{ step: "archive" }] } })).status).toBe(200);
    expect(seen).toContain("POST /tickets/tk-http/outcome");
    expect(sent.at(-1)!.body).toMatchObject({ signal: -1, detail: "no archive", check: { name: "tests", ran: true, passed: false, failures: [{ step: "archive" }] } });
  });

  it("carries the self in _meta on an MCP tools/call, for the person named in _meta", async () => {
    const params = { name: "design", arguments: { input: "a story" }, _meta: { "com.praecise/person": "anna", "com.praecise/surface": "playground" } };
    const reply = (await (await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "POST", headers: authed(mcpHeaders("tools/call", params)), body: JSON.stringify(mcpRequest("tools/call", params)) })).json()) as {
      result: { content: Array<{ text: string }>; _meta: Record<string, { handle: string; ticket: string; bound: boolean }> };
    };
    expect(reply.result.content[0]!.text).toBe("an answer");
    expect(reply.result._meta["com.praecise/self"]).toMatchObject({ handle: "design", bound: true });
    expect(openTicket("secret", reply.result._meta["com.praecise/self"]!.ticket, "anna")).toBe("tk-http");
    // The caller named where it was asked, so the self answers in that surface's persona.
    expect(sent.findLast((s) => s.path === "/selves/design/context")!.body.surface).toBe("playground");
  });
});
