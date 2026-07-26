/**
 * The dev server.
 *
 * One process gives an app three faces: a browser UI to try it in, a REST API
 * to call it from, and an MCP endpoint to plug it into anything that speaks the
 * protocol. Editing a file rebuilds the app and refreshes the open tab.
 */

import { watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { App, type AppOptions } from "../app.js";
import { handleMcp } from "./mcp.js";
import { chat, dashboard, notFound, workflowPage } from "./ui.js";

export interface ServeOptions extends AppOptions {
  port?: number;
  /**
   * Interface to bind. Defaults to loopback — a dev server is for the machine
   * it runs on, and binding every interface publishes an unauthenticated app to
   * the network by accident.
   */
  host?: string;
  /** Extra origins the browser may call from. Loopback is always allowed. */
  origins?: string[];
  /** Rebuild the app when a project file changes. Defaults to true. */
  watch?: boolean;
  onReload?: (app: App, error?: Error) => void;
}

const IGNORED = /(^|[/\\])(\.git|node_modules|\.praecise|dist)([/\\]|$)/;
const WATCHED = /\.(ts|tsx|js|mjs|md|txt|json)$/;

export interface DevServer {
  readonly port: number;
  readonly url: string;
  app(): App;
  close(): Promise<void>;
}

export async function serve(options: ServeOptions = {}): Promise<DevServer> {
  let app = await App.load(options);
  const requested = options.port ?? app.config.port ?? 3000;
  /** Set once listening — `port: 0` means the OS picks, and callers need to know which. */
  let port = requested;

  /** Open live-reload streams; each is nudged after a successful rebuild. */
  const listeners = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      if (!res.headersSent) send(res, 500, "application/json", JSON.stringify({ error: err.message }));
      else res.end();
    });
  });

  /**
   * A request with no `Origin` is not from a browser and is left alone. One
   * that has an Origin is only trusted if it came from this machine, or from
   * somewhere the author named.
   */
  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !origin) return true;
    if (options.origins?.includes(origin)) return true;
    try {
      const { hostname } = new URL(origin);
      return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    } catch {
      return false;
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/_dev/reload") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      listeners.add(res);
      req.on("close", () => listeners.delete(res));
      return;
    }

    if (path === "/mcp") {
      // A page in a browser can post here across origins. Without this check a
      // visited website could drive a dev server bound on the machine, so an
      // Origin we did not expect is refused before the body is even read.
      if (!originAllowed(req)) return send(res, 403, "text/plain", "origin not allowed");
      if (method !== "POST") return send(res, 405, "text/plain", "POST only");
      const body = await readJson(req);
      // The dev server is reachable only from this machine, so whoever is
      // talking to it is the person who started it. A hosted endpoint decides
      // this from a token instead. What it may see it narrows for itself: a
      // caller asking for less is always granted it.
      const groups = url.searchParams.get("groups");
      const reply = await handleMcp(app, body, {
        identified: true,
        groups: groups ? groups.split(",").map((name) => name.trim()) : undefined,
        readOnly: url.searchParams.has("read"),
      });
      if (reply === undefined) return send(res, 202, "text/plain", "");
      return send(res, 200, "application/json", JSON.stringify(reply));
    }

    if (path === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }

    if (path === "/health") {
      return send(
        res,
        200,
        "application/json",
        JSON.stringify({
          name: app.name,
          agents: app.agentNames,
          workflows: app.workflowNames,
          functions: Object.keys(app.project.functions),
          prompts: Object.keys(app.project.prompts),
          resources: Object.keys(app.project.resources),
          problems: app.problems,
        }),
      );
    }

    // A function that declared `http: "POST /webhook"` is reachable there, so
    // the same code can serve a model and an ordinary HTTP client.
    const route = routeFor(method, path);
    if (route) {
      const body = method === "GET" ? Object.fromEntries(url.searchParams) : await readJson(req);
      try {
        const value = await route.run((body ?? {}) as Record<string, unknown>);
        return send(res, 200, "application/json", JSON.stringify(value ?? null));
      } catch (err) {
        return send(res, 500, "application/json", JSON.stringify({ error: (err as Error).message }));
      }
    }

    if (path.startsWith("/api/")) return api(req, res, path, method);

    if (method !== "GET") return send(res, 405, "text/plain", "GET only");

    if (path === "/") return send(res, 200, "text/html", dashboard(app, port));

    if (path.startsWith("/w/")) {
      const name = decodeURIComponent(path.slice(3));
      if (!app.project.workflows[name]) {
        return send(res, 404, "text/html", notFound(app, `no workflow named "${name}"`));
      }
      return send(res, 200, "text/html", workflowPage(app, name));
    }

    const name = decodeURIComponent(path.slice(1));
    if (app.plans[name]) return send(res, 200, "text/html", chat(app, name));
    return send(res, 404, "text/html", notFound(app, `no agent named "${name}"`));
  }

  /** The function claiming this method and path, if any. */
  function routeFor(method: string, path: string) {
    for (const spec of Object.values(app.project.functions)) {
      if (!spec.http) continue;
      const parts = spec.http.trim().split(/\s+/);
      const declared = parts.length > 1 ? parts[0]!.toUpperCase() : "POST";
      const at = parts[parts.length - 1]!;
      if (declared === method && at === path) return spec;
    }
    return undefined;
  }

  async function api(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    method: string,
  ): Promise<void> {
    const json = (status: number, value: unknown) =>
      send(res, status, "application/json", JSON.stringify(value));

    if (path === "/api/runs" && method === "GET") return json(200, await app.runs.list());

    if (path.startsWith("/api/resources/") && method === "GET") {
      const name = decodeURIComponent(path.slice("/api/resources/".length));
      const spec = app.project.resources[name];
      if (!spec) return json(404, { error: `no resource named "${name}"` });
      try {
        return send(res, 200, spec.mime ?? "text/plain", await spec.read());
      } catch (err) {
        return json(500, { error: (err as Error).message });
      }
    }

    if (method !== "POST") return json(405, { error: "POST only" });
    const body = (await readJson(req)) as Record<string, unknown>;

    try {
      if (path.startsWith("/api/agents/")) {
        const name = decodeURIComponent(path.slice("/api/agents/".length));
        const input = typeof body.input === "string" ? body.input : "";
        if (!input) return json(400, { error: "input is required" });
        const answer = await app.ask(name, input, {
          history: Array.isArray(body.history) ? (body.history as never) : undefined,
          thread: typeof body.thread === "string" ? body.thread : undefined,
        });
        return json(200, answer);
      }

      if (path.startsWith("/api/functions/")) {
        const name = decodeURIComponent(path.slice("/api/functions/".length));
        if (!app.project.functions[name]) return json(404, { error: `no function named "${name}"` });
        return json(200, { result: (await app.callTool(name, body)) ?? null });
      }

      if (path.startsWith("/api/workflows/")) {
        const name = decodeURIComponent(path.slice("/api/workflows/".length));
        const input = (body.input ?? body) as Record<string, unknown>;
        return json(200, await app.startWorkflow(name, input));
      }

      if (path.startsWith("/api/runs/")) {
        const id = decodeURIComponent(path.slice("/api/runs/".length));
        return json(
          200,
          await app.resumeWorkflow(id, {
            approved: body.approved !== false,
            note: typeof body.note === "string" ? body.note : undefined,
          }),
        );
      }
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }

    return json(404, { error: `no such endpoint: ${path}` });
  }

  await new Promise<void>((ready) => server.listen(requested, options.host ?? "127.0.0.1", ready));
  const bound = server.address();
  if (bound && typeof bound === "object") port = bound.port;

  const watcher = options.watch === false ? undefined : startWatch();

  function startWatch(): FSWatcher | undefined {
    let timer: NodeJS.Timeout | undefined;
    try {
      return watch(app.root, { recursive: true }, (_event, file) => {
        if (!file || IGNORED.test(file) || !WATCHED.test(file)) return;
        clearTimeout(timer);
        timer = setTimeout(reload, 120);
      });
    } catch {
      // Recursive watch is unavailable on some platforms; the server still runs.
      return undefined;
    }
  }

  async function reload(): Promise<void> {
    try {
      const next = await App.load({ ...options, revision: String(Date.now()) });
      await app.close().catch(() => undefined);
      app = next;
      options.onReload?.(app);
      for (const listener of listeners) listener.write("data: reload\n\n");
    } catch (err) {
      options.onReload?.(app, err as Error);
    }
  }

  return {
    get port() {
      return port;
    },
    url: `http://localhost:${port}`,
    app: () => app,
    async close() {
      watcher?.close();
      for (const listener of listeners) listener.end();
      listeners.clear();
      await new Promise<void>((done) => server.close(() => done()));
      await app.close().catch(() => undefined);
    },
  };
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    "content-type": type === "text/html" ? "text/html; charset=utf-8" : type,
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4_000_000) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("body must be JSON");
  }
}

export type { Server };
export { handleMcp, toolsOf } from "./mcp.js";
