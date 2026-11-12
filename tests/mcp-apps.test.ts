/**
 * MCP Apps: a tool that brings an interactive view with its result.
 *
 * A view is a page some server wrote, shown to a person, able to ask its host to call
 * tools. Nothing in this framework renders one, so what matters here is everything
 * around the rendering: that a server tells only the clients that render views, that a
 * tool meant for views never reaches a model, that the page a front end is handed is the
 * one the tool declared with what the page must be told, and that a call a view makes is
 * held to the same guard as a model's.
 */
import { afterEach, describe, expect, test } from "vitest";

import { App } from "../src/app.js";
import type { ResolvedService } from "../src/compile/services.js";
import { McpClient, UI_MIME, clientCapabilities, collectTools, mcpRequest, uiOf } from "../src/harness/mcp.js";
import type { Progress, UiView } from "../src/harness/types.js";
import { AguiStream, MCP_APPS_ACTIVITY } from "../src/server/agui.js";
import { serve, type DevServer } from "../src/server/index.js";
import { handleMcp, noticesOf } from "../src/server/mcp.js";
import { handleView } from "../src/server/mcp-apps.js";
import { FRAMEWORK, MODEL_ENV, TEST_ENDPOINT, TEST_TOKEN, authed, cleanup, makeProject, stubModel } from "./helpers.js";

const PAGE = "<!doctype html><html><body><div id=chart></div><script>/* renders sales */</script></body></html>";

/** An app that publishes a tool with a view, a tool only the view may call, and the page. */
const CHARTS = {
  "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
    export default defineConfig({ name: "charts", version: "1.0.0", ${TEST_ENDPOINT} });`,
  "resources/dashboard.ts": `import { resource } from "${FRAMEWORK}";
    export default resource({
      uri: "ui://charts/dashboard",
      description: "Sales, as a chart.",
      ui: { csp: { connectDomains: ["https://api.charts.test"] }, prefersBorder: true },
      read: () => ${JSON.stringify(PAGE)},
    });`,
  "resources/notes.ts": `import { resource } from "${FRAMEWORK}";
    export default resource({ uri: "notes://today", read: () => "nothing to report" });`,
  "functions/show_sales.ts": `import { fn } from "${FRAMEWORK}";
    export default fn({
      description: "Show sales for a region.",
      input: { region: "which region" },
      effect: "read",
      ui: "ui://charts/dashboard",
      run: ({ region }) => ({ region, total: 42 }),
    });`,
  "functions/refresh_sales.ts": `import { fn } from "${FRAMEWORK}";
    export default fn({
      description: "Fetch fresh figures for the chart.",
      input: { region: "which region" },
      effect: "read",
      ui: { resource: "ui://charts/dashboard", visibility: ["app"] },
      run: ({ region }) => ({ region, total: 43 }),
    });`,
  "functions/delete_sales.ts": `import { fn } from "${FRAMEWORK}";
    export default fn({
      description: "Delete a region's figures.",
      input: { region: "which region" },
      effect: "destructive",
      access: "open",
      run: ({ region }) => ({ deleted: region }),
    });`,
};

const roots: string[] = [];
const servers: DevServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => cleanup(root).catch(() => undefined)));
});

async function load(files: Record<string, string>, options: Partial<Parameters<typeof App.load>[0]> = {}): Promise<App> {
  const root = await makeProject(files);
  roots.push(root);
  return App.load({ root, env: MODEL_ENV, fetch: stubModel([]).fetch, ...options });
}

const RENDERS = { extensions: { "io.modelcontextprotocol/tasks": {}, "io.modelcontextprotocol/ui": { mimeTypes: [UI_MIME] } } };
type Reply = { result?: Record<string, any>; error?: { code: number; message: string } };
async function rpc(app: App, method: string, params: Record<string, unknown> = {}, capabilities?: Record<string, unknown>): Promise<Reply> {
  const request = mcpRequest(method, params) as { params: { _meta: Record<string, unknown> } };
  if (capabilities) request.params._meta["io.modelcontextprotocol/clientCapabilities"] = capabilities;
  return (await handleMcp(app, request, { identified: true })) as Reply;
}

describe("a server tells a client that renders views which tools bring one", () => {
  test("a client that renders them sees the declaration, and the tool only a view may call", async () => {
    const app = await load(CHARTS);
    const { result } = await rpc(app, "tools/list", {}, RENDERS);
    const tools = Object.fromEntries((result!.tools as { name: string; _meta?: unknown }[]).map((tool) => [tool.name, tool._meta]));

    expect(tools.show_sales).toEqual({ ui: { resourceUri: "ui://charts/dashboard" } });
    expect(tools.refresh_sales).toEqual({ ui: { resourceUri: "ui://charts/dashboard", visibility: ["app"] } });
    expect(tools.delete_sales).toBeUndefined();
  });

  test("any other client gets the list it always got, without a tool it would hand to a model", async () => {
    const app = await load(CHARTS);
    const { result } = await rpc(app, "tools/list");
    const tools = result!.tools as { name: string; _meta?: unknown }[];
    expect(tools.map((tool) => tool.name)).toEqual(["delete_sales", "show_sales"]);
    expect(tools.every((tool) => tool._meta === undefined)).toBe(true);
  });

  test("nothing is declared in server/discover: it is the client that says it renders views", async () => {
    const app = await load(CHARTS);
    const reply = (await handleMcp(app, { jsonrpc: "2.0", id: 1, method: "server/discover" })) as Reply;
    expect(reply.result!.capabilities.extensions).toEqual({ "io.modelcontextprotocol/tasks": {} });
  });

  test("the page is a resource, served as an MCP App with what it needs of its renderer", async () => {
    const app = await load(CHARTS);
    const listed = (await rpc(app, "resources/list")).result!.resources as Record<string, unknown>[];
    expect(listed.find((entry) => entry.uri === "ui://charts/dashboard")).toMatchObject({
      mimeType: "text/html;profile=mcp-app",
      _meta: { ui: { csp: { connectDomains: ["https://api.charts.test"] }, prefersBorder: true } },
    });
    // An ordinary resource is what it was.
    expect(listed.find((entry) => entry.uri === "notes://today")).toMatchObject({ mimeType: "text/plain" });

    const read = (await rpc(app, "resources/read", { uri: "ui://charts/dashboard" })).result!;
    expect(read.contents).toEqual([
      {
        uri: "ui://charts/dashboard",
        mimeType: "text/html;profile=mcp-app",
        text: PAGE,
        _meta: { ui: { csp: { connectDomains: ["https://api.charts.test"] }, prefersBorder: true } },
      },
    ]);
    // The two fields a read must carry in this revision.
    expect(read.ttlMs).toBe(0);
    expect(read.cacheScope).toBe("private");
  });

  test("a declaration that names no page the app has is left off the tool, and said", async () => {
    const app = await load({
      ...CHARTS,
      "functions/broken_view.ts": `import { fn } from "${FRAMEWORK}";
        export default fn({ description: "x", input: {}, effect: "read", ui: "ui://charts/missing", run: () => 1 });`,
      "functions/not_a_view.ts": `import { fn } from "${FRAMEWORK}";
        export default fn({ description: "x", input: {}, effect: "read", ui: "notes://today", run: () => 1 });`,
    });
    const tools = (await rpc(app, "tools/list", {}, RENDERS)).result!.tools as { name: string; _meta?: unknown }[];
    expect(tools.find((tool) => tool.name === "broken_view")!._meta).toBeUndefined();
    expect(tools.find((tool) => tool.name === "not_a_view")!._meta).toBeUndefined();
    const notices = noticesOf(app).join("\n");
    expect(notices).toContain('"broken_view" is published without its view');
    expect(notices).toContain("no resource in resources/ has that uri");
    expect(notices).toContain("a view's address starts ui://");
  });
});

// ── The client ────────────────────────────────────────────────────────────────

const service = (over: Partial<ResolvedService> = {}): ResolvedService =>
  ({ name: "charts", url: "https://charts.test/mcp", credential: "CHARTS_API_KEY", apiKey: "k", auth: "bearer", ...over }) as ResolvedService;

/** A fetch that speaks MCP for `app`, and counts what it was asked. */
function speaking(app: App) {
  const methods: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string };
    methods.push(body.method);
    const reply = await handleMcp(app, body, { identified: true, headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, methods };
}

describe("what a tool says about its view", () => {
  test("is read from _meta.ui, with both callers allowed unless it says otherwise", () => {
    expect(uiOf({ ui: { resourceUri: "ui://a/b" } })).toEqual({ resourceUri: "ui://a/b", visibility: ["model", "app"] });
    expect(uiOf({ ui: { resourceUri: "ui://a/b", visibility: ["app"] } })).toEqual({ resourceUri: "ui://a/b", visibility: ["app"] });
  });

  test("the flat key older servers send is still read", () => {
    expect(uiOf({ "ui/resourceUri": "ui://a/b" })).toEqual({ resourceUri: "ui://a/b", visibility: ["model", "app"] });
  });

  test("a page that is not a ui:// resource is not a view", () => {
    expect(uiOf({ ui: { resourceUri: "https://evil.test/page.html" } })).toBeUndefined();
    expect(uiOf({})).toBeUndefined();
    expect(uiOf(undefined)).toBeUndefined();
  });

  test("a tool for views only stays for views only, page or no page", () => {
    expect(uiOf({ ui: { visibility: ["app"] } })).toEqual({ resourceUri: "", visibility: ["app"] });
  });
});

describe("a client that renders views is handed them, and one that does not is not", () => {
  test("the extension is declared only when the app says a front end renders views", () => {
    expect(clientCapabilities({ apps: true }).extensions).toEqual({
      "io.modelcontextprotocol/tasks": {},
      "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
    });
    expect(clientCapabilities({}).extensions).toEqual({ "io.modelcontextprotocol/tasks": {} });
  });

  test("a tool only a view may call is never offered to an agent", async () => {
    const app = await load(CHARTS);
    const { fetchImpl } = speaking(app);
    const found = await collectTools([service()], fetchImpl, { host: { apps: true } });
    expect(found.schemas.map((tool) => tool.name).sort()).toEqual(["charts__delete_sales", "charts__show_sales"]);
  });

  test("a call brings the page, read once, with the input and result the page is to be shown", async () => {
    const app = await load(CHARTS);
    const { fetchImpl, methods } = speaking(app);
    const client = new McpClient(service(), fetchImpl, undefined, { apps: true });
    client.remember(await client.listTools());
    const views: UiView[] = [];

    const text = await client.call("show_sales", { region: "emea" }, { ui: (view) => views.push(view) });
    await client.call("show_sales", { region: "apac" }, { ui: (view) => views.push(view) });

    // The answer a model reads is the answer it always was.
    expect(JSON.parse(text)).toEqual({ region: "emea", total: 42 });
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({
      service: "charts",
      tool: "show_sales",
      resourceUri: "ui://charts/dashboard",
      mimeType: "text/html;profile=mcp-app",
      html: PAGE,
      meta: { csp: { connectDomains: ["https://api.charts.test"] }, prefersBorder: true },
      toolInput: { region: "emea" },
    });
    expect(views[0]!.toolResult.content).toEqual([{ type: "text", text: expect.stringContaining('"total": 42') }]);
    expect(views[1]!.toolInput).toEqual({ region: "apac" });
    // Read with resources/read, and once for both calls.
    expect(methods.filter((method) => method === "resources/read")).toHaveLength(1);
  });

  test("a client whose host renders nothing declares nothing, is told nothing, and reads no page", async () => {
    const app = await load(CHARTS);
    const { fetchImpl, methods } = speaking(app);
    const client = new McpClient(service(), fetchImpl);
    client.remember(await client.listTools());
    const views: UiView[] = [];
    await client.call("show_sales", { region: "emea" }, { ui: (view) => views.push(view) });
    expect(views).toEqual([]);
    expect(methods).not.toContain("resources/read");
  });

  test("a page that will not read costs a warning and no view, never the tool's answer", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number; method: string };
      const result =
        body.method === "tools/list"
          ? { resultType: "complete", tools: [{ name: "show", description: "", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://x/gone" } } }] }
          : body.method === "resources/read"
            ? { resultType: "complete", contents: [{ uri: "ui://x/gone", mimeType: "text/html", text: "<p>not an app</p>" }] }
            : { resultType: "complete", content: [{ type: "text", text: "the answer" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new McpClient(service(), fetchImpl, undefined, { apps: true });
    client.remember(await client.listTools());
    const views: UiView[] = [];
    expect(await client.call("show", {}, { ui: (view) => views.push(view) })).toBe("the answer");
    expect(views).toEqual([]);
    expect(client.warnings.join("\n")).toContain("was not served as text/html;profile=mcp-app");
  });
});

// ── An agent, and the front end behind it ─────────────────────────────────────

/** An app whose agent calls the charts service, wired to `charts` through a shared fetch. */
async function hosting(charts: App, replies: Parameters<typeof stubModel>[0], extra: Record<string, string> = {}, apps = true) {
  const { fetchImpl: mcp, methods } = speaking(charts);
  const model = stubModel(replies);
  const routed = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith("https://charts.test/") ? mcp(input, init) : model.fetch(input, init)) as typeof fetch;
  const app = await load(
    {
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({ name: "desk", ${TEST_ENDPOINT} });`,
      "tools/charts.ts": `import { tool } from "${FRAMEWORK}";
        export default tool({ url: "https://charts.test/mcp" });`,
      "agents/analyst.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Analyse sales.", tools: ["charts"] });`,
      ...extra,
    },
    { env: { ...MODEL_ENV, CHARTS_API_KEY: "k" }, fetch: routed, ...(apps ? { mcp: { apps: true } } : {}) },
  );
  return { app, model, methods };
}

describe("a view reaches the caller on the answer and on the stream", () => {
  const SCRIPT = [
    { text: "", tool: { name: "charts__show_sales", args: { region: "emea" } } },
    { text: "Sales in EMEA were 42." },
  ];

  test("the answer carries the view, and the model never sees the page", async () => {
    const charts = await load(CHARTS);
    const { app, model } = await hosting(charts, SCRIPT);
    const seen: Progress[] = [];

    const answer = await app.ask("analyst", "how were sales in emea?", { onProgress: (event) => seen.push(event) });

    expect(answer.text).toBe("Sales in EMEA were 42.");
    expect(answer.ui).toHaveLength(1);
    expect(answer.ui![0]).toMatchObject({ service: "charts", tool: "show_sales", resourceUri: "ui://charts/dashboard", html: PAGE, toolInput: { region: "emea" } });
    // Reported as it happened, after the tool's result.
    const kinds = seen.map((event) => event.kind);
    expect(kinds.indexOf("ui")).toBeGreaterThan(kinds.indexOf("tool result"));
    // The tool the view alone may call was never offered to the model.
    const offered = (model.calls[0]!.body.tools as { name: string }[]).map((tool) => tool.name);
    expect(offered).not.toContain("charts__refresh_sales");
    // The page is for a person. Nothing of it went back to the model.
    expect(JSON.stringify(model.calls[1]!.body)).not.toContain("renders sales");
    await app.close();
  });

  test("an app that did not say a front end renders views gets the answer and no view", async () => {
    const charts = await load(CHARTS);
    const { app, methods } = await hosting(charts, SCRIPT, {}, false);
    const answer = await app.ask("analyst", "how were sales in emea?");
    expect(answer.text).toBe("Sales in EMEA were 42.");
    expect(answer.ui).toBeUndefined();
    expect(methods).not.toContain("resources/read");
    await app.close();
  });

  test("on an AG-UI stream it is an activity a front end registers a renderer for", () => {
    const view: UiView = {
      service: "charts",
      tool: "show_sales",
      resourceUri: "ui://charts/dashboard",
      mimeType: UI_MIME,
      html: PAGE,
      meta: { prefersBorder: true },
      toolInput: { region: "emea" },
      toolResult: { content: [{ type: "text", text: "42" }] },
    };
    const stream = new AguiStream("run-1");
    const [event] = stream.take({ kind: "ui", view });
    expect(event).toMatchObject({
      type: "ACTIVITY_SNAPSHOT",
      activityType: MCP_APPS_ACTIVITY,
      replace: true,
      content: {
        resourceUri: "ui://charts/dashboard",
        serverId: "charts",
        toolName: "show_sales",
        toolInput: { region: "emea" },
        result: { content: [{ type: "text", text: "42" }] },
        mimeType: UI_MIME,
        html: PAGE,
        meta: { prefersBorder: true },
      },
    });
    // A caller that asked only for the agent's words is not sent pages.
    expect(new AguiStream("run-2", ["messages"]).take({ kind: "ui", view })).toEqual([]);
  });
});

describe("a call a view makes is held to what a model's call is, and to its own service", () => {
  const call = (name: string, args: Record<string, unknown> = { region: "emea" }, id: number | null = 1) => ({
    jsonrpc: "2.0",
    ...(id === null ? {} : { id }),
    method: "tools/call",
    params: { name, arguments: args },
  });
  type ViewReply = { id: number; result?: Record<string, any>; error?: { code: number; message: string } };

  test("a tool marked for views is called, and the result comes back in the protocol's own shape", async () => {
    const charts = await load(CHARTS);
    const { app } = await hosting(charts, []);
    const reply = (await handleView(app, "charts", call("refresh_sales"))) as ViewReply;
    expect(reply.id).toBe(1);
    expect(reply.result!.isError).toBe(false);
    expect(JSON.parse(reply.result!.content[0].text)).toEqual({ region: "emea", total: 43 });
    await app.close();
  });

  test("the guard is asked, under the name a model would use, and told it came from a view", async () => {
    const charts = await load(CHARTS);
    const { app } = await hosting(charts, [], {
      "guard.ts": `import { guard } from "${FRAMEWORK}";
        export default guard((attempt) =>
          attempt.via === "ui" && attempt.tool === "charts__delete_sales"
            ? "Not allowed: a view may not delete (" + attempt.origin + ", " + attempt.effect + ")."
            : undefined);`,
    });
    const refused = (await handleView(app, "charts", call("delete_sales"))) as ViewReply;
    // A refusal is a result the page can show, as it is for a model.
    expect(refused.result).toEqual({
      content: [{ type: "text", text: "Not allowed: a view may not delete (remote, destructive)." }],
      isError: true,
    });
    // The same guard lets through what it has no rule against.
    const allowed = (await handleView(app, "charts", call("refresh_sales"))) as ViewReply;
    expect(allowed.result!.isError).toBe(false);
    await app.close();
  });

  test("a tool its server marked for models only cannot be called from a view", async () => {
    const charts = await load({
      ...CHARTS,
      "functions/model_only.ts": `import { fn } from "${FRAMEWORK}";
        export default fn({
          description: "For the model.", input: {}, effect: "read",
          ui: { resource: "ui://charts/dashboard", visibility: ["model"] },
          run: () => "should not run",
        });`,
    });
    const { app } = await hosting(charts, []);
    const reply = (await handleView(app, "charts", call("model_only", {}))) as ViewReply;
    expect(reply.result!.isError).toBe(true);
    expect(reply.result!.content[0].text).toBe('service "charts" has no tool named "model_only" that a view may call');
    // And a tool that does not exist is told the same thing.
    const missing = (await handleView(app, "charts", call("nope", {}))) as ViewReply;
    expect(missing.result!.content[0].text).toBe('service "charts" has no tool named "nope" that a view may call');
    await app.close();
  });

  test("a view reaches its own service and no other", async () => {
    const charts = await load(CHARTS);
    const { app } = await hosting(charts, []);
    const reply = (await handleView(app, "billing", call("refresh_sales"))) as ViewReply;
    expect(reply.result!.isError).toBe(true);
    expect(reply.result!.content[0].text).toContain('no service named "billing"');
    await app.close();
  });

  test("an app that hands out no views takes no calls from one", async () => {
    const charts = await load(CHARTS);
    const { app } = await hosting(charts, [], {}, false);
    const reply = (await handleView(app, "charts", call("refresh_sales"))) as ViewReply;
    expect(reply.result!.isError).toBe(true);
    expect(reply.result!.content[0].text).toContain("hands out no views");
    await app.close();
  });

  test("it may read a resource from its service, and be pinged", async () => {
    const charts = await load(CHARTS);
    const { app } = await hosting(charts, []);
    const read = (await handleView(app, "charts", { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "notes://today" } })) as ViewReply;
    expect(read.result!.contents[0]).toMatchObject({ uri: "notes://today", text: "nothing to report" });
    expect(await handleView(app, "charts", { jsonrpc: "2.0", id: 3, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    await app.close();
  });

  test("what needs a browser is refused by name, as the front end's to answer", async () => {
    const charts = await load(CHARTS);
    const { app } = await hosting(charts, []);
    for (const method of ["ui/initialize", "ui/open-link", "ui/message", "ui/update-model-context", "ui/request-display-mode"]) {
      const reply = (await handleView(app, "charts", { jsonrpc: "2.0", id: 4, method, params: {} })) as ViewReply;
      expect(reply.error!.code).toBe(-32601);
      expect(reply.error!.message).toContain("answered by the front end that renders the view");
    }
    const unknown = (await handleView(app, "charts", { jsonrpc: "2.0", id: 5, method: "tools/list" })) as ViewReply;
    expect(unknown.error!.message).toContain("not something a view may ask");
    // A notification from the page changes nothing here and gets no reply.
    expect(await handleView(app, "charts", { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: 1, height: 1 } })).toBeUndefined();
    await app.close();
  });

  test("over HTTP the bridge is behind the app's token, at the service's own path", async () => {
    const charts = await load(CHARTS);
    const { fetchImpl: mcp } = speaking(charts);
    const routed = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("https://charts.test/") ? mcp(input, init) : stubModel([]).fetch(input, init)) as typeof fetch;
    const root = await makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({ name: "desk", ${TEST_ENDPOINT} });`,
      "tools/charts.ts": `import { tool } from "${FRAMEWORK}";
        export default tool({ url: "https://charts.test/mcp" });`,
    });
    roots.push(root);
    const server = await serve({ root, port: 0, watch: false, env: { ...MODEL_ENV, CHARTS_API_KEY: "k" }, fetch: routed, token: TEST_TOKEN, mcp: { apps: true } });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}/api/ui/charts`;
    const body = JSON.stringify(call("refresh_sales"));

    const stranger = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(stranger.status).toBe(401);

    const reply = await fetch(url, { method: "POST", headers: authed({ "content-type": "application/json" }), body });
    expect(reply.status).toBe(200);
    const said = (await reply.json()) as ViewReply;
    expect(JSON.parse(said.result!.content[0].text)).toEqual({ region: "emea", total: 43 });
  });
});
