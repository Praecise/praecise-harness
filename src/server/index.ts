/**
 * The dev server.
 *
 * One process gives an app three faces: a browser UI to try it in, a REST API
 * to call it from, and an MCP endpoint to plug it into anything that speaks the
 * protocol. Editing a file rebuilds the app and refreshes the open tab.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { App, type AppOptions } from "../app.js";
import { safeMessage } from "../redact.js";
import { followRun, openChannel } from "./events.js";
import { handleMcp, type Caller } from "./mcp.js";
import { AGENT_CARD_PATH, agentCard, handleA2A } from "./a2a.js";
import { ask } from "./ask.js";
import { AguiStream, modesFrom } from "./agui.js";
import { LLMS_TXT_PATH, llmsTxt, jsonLd, robotsTxt } from "./discovery.js";
import { chat, dashboard, notFound, tracesPage, workflowPage } from "./ui.js";
import { TraceLog } from "./traces.js";

/**
 * The URL a machine on the other side would use to reach this app.
 *
 * Taken from the `Host` header rather than assembled from the bind address, because what
 * a discovery document must contain is where the CALLER can reach us — behind a proxy
 * those are different, and a document naming an unreachable address is worse than none.
 */
function publicUrl(req: IncomingMessage, port: number): string {
  const forwarded = req.headers["x-forwarded-proto"];
  const scheme = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() ?? "http";
  return `${scheme}://${req.headers.host ?? `127.0.0.1:${port}`}`;
}

export interface ServeOptions extends AppOptions {
  port?: number;
  /**
   * Interface to bind. Defaults to loopback — a dev server is for the machine
   * it runs on, and binding every interface publishes an app to the network by
   * accident.
   */
  host?: string;
  /** Extra origins the browser may call from. Loopback is always allowed. */
  origins?: string[];
  /**
   * The bearer token `/api/*` and `/mcp` require.
   *
   * Left out, one is minted per start and printed by `banner()` for the operator
   * to copy. Set it to share a token with something that has to survive a
   * restart. Set it to `false` only when the app genuinely has no control
   * surface worth protecting — and that is refused on a non-loopback bind,
   * because the combination of "reachable from the network" and "no credential"
   * is the single misconfiguration that turns every other weakness into a remote
   * compromise.
   */
  token?: string | false;
  /**
   * Host header values to answer to, on top of loopback and the configured
   * origins. Anything else is refused; see `hostAllowed`.
   */
  hosts?: string[];
  /** Rebuild the app when a project file changes. Defaults to true. */
  watch?: boolean;
  onReload?: (app: App, error?: Error) => void;
}

/** Loopback by every spelling a URL or a Host header can use. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0:0:0:0:0:0:0:1"]);

function isLoopback(hostname: string): boolean {
  const bare = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK.has(bare) || bare.startsWith("127.");
}

/** The hostname of a URL-ish string, or undefined if it is not one. */
function safeHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

/**
 * What a stranger is told when something inside the app threw.
 *
 * Deliberately says nothing. The message that reached here was written for a
 * developer reading a log and routinely quotes the thing that failed — a
 * provider's response body, a connection string, an absolute path. None of that
 * is owed to whoever made the request.
 */
const OPAQUE = "the app failed to handle this request; the detail is in the server log";

/** Compare without leaking how much of the token was right. */
function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const IGNORED = /(^|[/\\])(\.git|node_modules|\.praecise|dist)([/\\]|$)/;
const WATCHED = /\.(ts|tsx|js|mjs|md|txt|json)$/;

export interface DevServer {
  readonly port: number;
  readonly url: string;
  /** The bearer token `/api/*` and `/mcp` require, or undefined if serving open. */
  readonly token?: string;
  /** What to print on start: the address, and the credential to reach it with. */
  banner(): string;
  app(): App;
  close(): Promise<void>;
}

export async function serve(options: ServeOptions = {}): Promise<DevServer> {
  const host = options.host ?? "127.0.0.1";

  /**
   * The one refusal that is worth failing a start over.
   *
   * Every other finding in this file is a weakness reachable only by something
   * already on the machine. Bound to an interface the network can see, with no
   * credential, they all become reachable by anyone who can route a packet here
   * — approve any run, call any destructive function, read every prompt and
   * every output. A framework cannot know whose network it was started on, so it
   * refuses loudly rather than succeeding quietly.
   */
  if (options.token === false && !isLoopback(host)) {
    throw new Error(
      `serve({ host: ${JSON.stringify(host)}, token: false }) would publish this app's control plane to the network with no credential on it: ` +
        `anyone who can reach ${host} could approve any waiting run, call any function including destructive ones, and read every prompt, input and output the app has produced. ` +
        `Either leave \`token\` out — one is minted per start and printed for you — or set an explicit \`token\`. ` +
        `\`token: false\` is only ever allowed on a loopback bind.`,
    );
  }

  /**
   * Minted per start unless the caller brought one. 256 bits from `node:crypto`:
   * the token is the only thing between a stranger and the control plane, so it
   * is generated the way a credential is generated and never derived from
   * anything the app already publishes.
   */
  const token = options.token === false ? undefined : (options.token ?? randomBytes(32).toString("base64url"));

  // The dev server installs its own collector, so spans are visible without anyone
  // configuring a backend first. A deployment passes its own `tracer` and this is never
  // constructed. Bounded, because a dev server that runs for a week must not grow for one.
  const traces = new TraceLog();
  let app = await App.load({ tracer: traces.tracer, ...options });
  const requested = options.port ?? app.config.port ?? 3000;
  /** Set once listening — `port: 0` means the OS picks, and callers need to know which. */
  let port = requested;

  /** Open live-reload streams; each is nudged after a successful rebuild. */
  const listeners = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      // The caller is told that it failed and nothing about how. An exception
      // from inside the app carries whatever the thing that threw felt like
      // saying — a provider's 401 body, a DSN, a path — and none of that is the
      // stranger's to read. It goes to stderr, where the operator is.
      console.error(`praecise: ${req.method} ${req.url ?? "/"} failed:`, err);
      if (!res.headersSent) send(res, 500, "application/json", JSON.stringify({ error: OPAQUE }));
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
      return isLoopback(new URL(origin).hostname);
    } catch {
      return false;
    }
  }

  /**
   * Which `Host` this server answers to.
   *
   * Without this, a name the attacker controls resolves to a public address long
   * enough for a browser to load their page, then re-resolves to 127.0.0.1 — and
   * every request the page makes afterwards is same-origin by the browser's own
   * reckoning. No Origin check fires, because the origin genuinely IS the
   * attacker's page, and the whole control plane is readable. The only place to
   * catch that is the Host header, which still says what the browser dialled.
   *
   * Everything is refused but loopback, whatever the caller configured as an
   * origin, and whatever it named in `hosts`.
   */
  function hostAllowed(req: IncomingMessage): boolean {
    const header = req.headers.host;
    if (typeof header !== "string" || !header) return false;
    if (options.hosts?.includes(header)) return true;

    let hostname: string;
    try {
      hostname = new URL(`http://${header}`).hostname;
    } catch {
      return false;
    }
    if (isLoopback(hostname)) return true;
    if (options.hosts?.includes(hostname)) return true;
    // A host the caller already trusts as an origin is a host it meant to serve.
    if (options.origins?.some((allowed) => safeHostname(allowed) === hostname)) return true;
    // Bound to a specific interface on purpose ⇒ that address is a legitimate name.
    return host !== "0.0.0.0" && host !== "::" && safeHostname(`http://${host}`) === hostname;
  }

  /**
   * The credential, or the reason there is none.
   *
   * Two ways to present it. `Authorization: Bearer` is the one to use. `?token=`
   * exists because `EventSource` cannot set a header and the run stream is meant
   * to be readable from a browser — it is second-best on purpose, since a query
   * string lands in proxy logs and browser history in a way a header does not.
   */
  function authorised(req: IncomingMessage, url: URL): boolean {
    if (!token) return true;
    const header = req.headers.authorization;
    if (typeof header === "string") {
      const match = /^Bearer\s+(.+)$/i.exec(header.trim());
      if (match && sameToken(match[1]!, token)) return true;
    }
    const query = url.searchParams.get("token");
    return Boolean(query && sameToken(query, token));
  }

  /**
   * A body a browser could not have sent by accident.
   *
   * A cross-origin `fetch` with `text/plain` is a CORS *simple* request: no
   * preflight, so no chance to refuse it, and the body arrives anyway. Insisting
   * on `application/json` is what makes a preflight compulsory, and the preflight
   * is where the Origin check gets to speak. It is one header and it is the
   * difference between a visited web page being able to drive this and not.
   */
  function jsonBody(req: IncomingMessage): boolean {
    const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    return type === "application/json";
  }

  /**
   * Whether the caller can read the work as it happens.
   *
   * This is asked for in the ordinary way, by saying what you can read, so the
   * streaming and the plain form of a request are one endpoint rather than two
   * that have to be kept saying the same thing.
   */
  function wantsEvents(req: IncomingMessage): boolean {
    return String(req.headers.accept ?? "").includes("text/event-stream");
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Checked first, on everything, including the pages: the whole point of a
    // rebinding attack is to make the pages same-origin, and a page this server
    // hands out carries the token that reaches the rest of it.
    if (!hostAllowed(req)) {
      return send(
        res,
        403,
        "text/plain",
        `this server answers to loopback only; "${String(req.headers.host ?? "")}" is not a name it was told to serve. ` +
          `Add it to serve({ hosts: [...] }) if it should be.`,
      );
    }

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
      if (!authorised(req, url)) return unauthorised(res);
      if (!jsonBody(req)) return unsupportedType(res);
      const body = await readJson(req);
      // `identified` says a credential was checked, and now one has been: the
      // bearer token was presented above. It was previously hardcoded true on
      // the reasoning that only this machine could reach the port, which made
      // the `gated` access tier mean nothing at all. What a caller may see it
      // still narrows for itself — asking for less is always granted.
      const groups = url.searchParams.get("groups");
      // The headers go with the body, because this revision requires the two to AGREE and
      // only the handler has parsed the body to compare against. Validating in the
      // transport would mean parsing the body twice; not validating at all would leave a
      // proxy routing on one value while the app executes another.
      const reply = await handleMcp(app, body, {
        identified: Boolean(token),
        groups: groups ? groups.split(",").map((name) => name.trim()) : undefined,
        readOnly: url.searchParams.has("read"),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([name, value]) => [
            name,
            Array.isArray(value) ? (value[0] ?? "") : (value ?? ""),
          ]),
        ),
      });
      if (reply === undefined) return send(res, 202, "text/plain", "");
      // A refusal this revision defines is a 400, not a 200 carrying an error. An
      // intermediary that never parses the body still has to be able to tell a served
      // request from a refused one.
      const refused = (reply as { error?: { code?: number } }).error?.code;
      const status = refused !== undefined && [-32020, -32021, -32022, -32602].includes(refused) ? 400 : 200;
      return send(res, status, "application/json", JSON.stringify(reply));
    }

    // ── Being discovered, and being asked ────────────────────────────────
    //
    // All three are unauthenticated on purpose and all three are FILTERED by what an
    // anonymous caller could actually reach. Discovery gated behind the credential it
    // describes is a loop nobody can enter; discovery that lists what it will then refuse
    // is a disclosure. Filtering is the only answer that is both.
    if (path === LLMS_TXT_PATH) {
      if (method !== "GET") return send(res, 405, "text/plain", "GET only");
      const seen: Caller = { identified: authorised(req, url) && Boolean(token) };
      return send(res, 200, "text/markdown; charset=utf-8", llmsTxt(app, seen, publicUrl(req, port)));
    }

    if (path === "/robots.txt") {
      if (method !== "GET") return send(res, 405, "text/plain", "GET only");
      return send(res, 200, "text/plain; charset=utf-8", robotsTxt(publicUrl(req, port)));
    }

    if (path === "/.well-known/ai-plugin.json" || path === "/ai.json") {
      // The JSON-LD description, at the two paths machines actually probe for one.
      if (method !== "GET") return send(res, 405, "text/plain", "GET only");
      const seen: Caller = { identified: authorised(req, url) && Boolean(token) };
      return send(res, 200, "application/json", JSON.stringify(jsonLd(app, seen, publicUrl(req, port)), null, 2));
    }

    if (path === "/ask") {
      if (!originAllowed(req)) return send(res, 403, "text/plain", "origin not allowed");
      // GET so a link is enough to ask, POST so a long question is not a URL problem.
      if (method !== "GET" && method !== "POST") return send(res, 405, "text/plain", "GET or POST");
      const asked =
        method === "GET"
          ? Object.fromEntries(url.searchParams)
          : ((await readJson(req)) as Record<string, unknown>);

      const answered = await ask(
        app,
        asked,
        { identified: authorised(req, url) && Boolean(token), readOnly: url.searchParams.has("read") },
        app.project.config.ask ?? {},
      );
      return send(res, 200, "application/json", JSON.stringify(answered, null, 2));
    }

    // ── A2A ──────────────────────────────────────────────────────────────
    //
    // The card is served UNAUTHENTICATED and the endpoint is not. That asymmetry is the
    // protocol's, not a lapse: discovery is how a peer learns what credential to present,
    // so gating the card behind the credential it describes is a loop nobody can enter.
    // What the card lists is still filtered — an anonymous reader sees only the ungated
    // skills, which is exactly what an anonymous caller could run.
    if (path === AGENT_CARD_PATH) {
      if (method !== "GET") return send(res, 405, "text/plain", "GET only");
      const identified = authorised(req, url);
      const origin = `http://${req.headers.host ?? `127.0.0.1:${port}`}`;
      return send(
        res,
        200,
        "application/json",
        JSON.stringify(agentCard(app, { identified: identified && Boolean(token) }, origin), null, 2),
      );
    }

    if (path === "/a2a") {
      if (!originAllowed(req)) return send(res, 403, "text/plain", "origin not allowed");
      if (method !== "POST") return send(res, 405, "text/plain", "POST only");
      if (!authorised(req, url)) return unauthorised(res);
      if (!jsonBody(req)) return unsupportedType(res);
      const groups = url.searchParams.get("groups");
      const reply = await handleA2A(app, await readJson(req), {
        identified: Boolean(token),
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

    if (path === "/traces") {
      if (method !== "GET") return send(res, 405, "text/plain", "GET only");
      if (!authorised(req, url)) return unauthorised(res);
      return send(res, 200, "text/html", tracesPage(app, traces.all()));
    }

    if (path === "/api/traces") {
      if (!authorised(req, url)) return unauthorised(res);
      if (method === "DELETE") {
        traces.clear();
        return send(res, 200, "application/json", JSON.stringify({ cleared: true }));
      }
      return send(res, 200, "application/json", JSON.stringify(traces.all(), null, 2));
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
    // the same code can serve a model and an ordinary HTTP client. It runs the
    // author's own code with the caller's arguments, which makes it as much a
    // control surface as /api — same origin check, same credential, same
    // insistence on a content type a browser cannot forge.
    const route = routeFor(method, path);
    if (route) {
      if (!originAllowed(req)) return send(res, 403, "text/plain", "origin not allowed");
      if (!authorised(req, url)) return unauthorised(res);
      if (method !== "GET" && !jsonBody(req)) return unsupportedType(res);
      const body = method === "GET" ? Object.fromEntries(url.searchParams) : await readJson(req);
      try {
        const value = await route.run((body ?? {}) as Record<string, unknown>);
        return send(res, 200, "application/json", JSON.stringify(value ?? null));
      } catch (err) {
        console.error(`praecise: ${method} ${path} failed:`, err);
        return send(res, 500, "application/json", JSON.stringify({ error: OPAQUE }));
      }
    }

    if (path.startsWith("/api/")) {
      // Every /api path, read or write, and before the route is even matched.
      // Reading is not the harmless half here: the run listing carries inputs,
      // prompts, outputs and the approvals ledger of everything the app has done.
      if (!originAllowed(req)) return send(res, 403, "text/plain", "origin not allowed");
      if (!authorised(req, url)) return unauthorised(res);
      return api(req, res, url, method);
    }

    if (method !== "GET") return send(res, 405, "text/plain", "GET only");

    // The pages are served without the token, and carry it into their own
    // scripts so the dashboard still works. They are a UI for the person at the
    // machine, reachable only under an allowed Host — which is what stops a
    // rebound page from fetching one and reading the credential out of it.
    if (path === "/") return send(res, 200, "text/html", dashboard(app, port, token));

    if (path.startsWith("/w/")) {
      const name = decodeURIComponent(path.slice(3));
      if (!app.project.workflows[name]) {
        return send(res, 404, "text/html", notFound(app, `no workflow named "${name}"`));
      }
      return send(res, 200, "text/html", workflowPage(app, name, token));
    }

    const name = decodeURIComponent(path.slice(1));
    if (app.plans[name]) return send(res, 200, "text/html", chat(app, name, token));
    return send(res, 404, "text/html", notFound(app, `no agent named "${name}"`));
  }

  /**
   * Refused for the content type, which is a CSRF refusal wearing a 415.
   *
   * Said in full rather than as a bare status, because the author who hits this
   * from `curl` needs to know it is a rule and not a bug.
   */
  function unsupportedType(res: ServerResponse): void {
    send(
      res,
      415,
      "application/json",
      JSON.stringify({
        error:
          "every POST here needs `Content-Type: application/json`. It is required because a cross-origin request a browser can make WITHOUT that header never triggers a preflight, and the preflight is the only place an unwanted origin can be turned away.",
      }),
    );
  }

  /** Refused for want of a credential, saying how to present one and nothing else. */
  function unauthorised(res: ServerResponse): void {
    res.writeHead(401, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "www-authenticate": 'Bearer realm="praecise"',
    });
    res.end(
      JSON.stringify({
        error:
          "this endpoint needs the server's bearer token. It was printed when the server started: send it as `Authorization: Bearer <token>`, or as `?token=<token>` where a header cannot be set.",
      }),
    );
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
    url: URL,
    method: string,
  ): Promise<void> {
    const path = url.pathname;
    const json = (status: number, value: unknown) =>
      send(res, status, "application/json", JSON.stringify(value));

    if (path === "/api/runs" && method === "GET") return json(200, await app.runs.list());

    if (path === "/api/threads" && method === "GET") {
      return json(200, await app.threads.list(url.searchParams.get("agent") ?? undefined));
    }

    if (path.startsWith("/api/threads/")) {
      const id = decodeURIComponent(path.slice("/api/threads/".length));
      if (method === "GET") {
        const thread = await app.threads.load(id);
        return thread ? json(200, thread) : json(404, { error: `no conversation named "${id}"` });
      }
      if (method === "DELETE") {
        return json(200, { forgotten: await app.threads.forget(id) });
      }
      return json(405, { error: "GET or DELETE only" });
    }

    // Follow a run that is already going. Its record is append-only, so this is
    // reading from a cursor rather than being told anything twice.
    if (path.startsWith("/api/runs/") && path.endsWith("/events") && method === "GET") {
      const id = decodeURIComponent(path.slice("/api/runs/".length, -"/events".length));
      if (!(await app.runs.load(id))) return json(404, { error: `no run named "${id}"` });

      const channel = openChannel(req, res);
      try {
        for await (const event of followRun(app.runs, id, channel.signal)) channel.send(event);
      } finally {
        channel.close();
      }
      return;
    }

    if (path.startsWith("/api/resources/") && method === "GET") {
      const name = decodeURIComponent(path.slice("/api/resources/".length));
      const spec = app.project.resources[name];
      if (!spec) return json(404, { error: `no resource named "${name}"` });
      try {
        return send(res, 200, spec.mime ?? "text/plain", await spec.read());
      } catch (err) {
        console.error(`praecise: reading resource "${name}" failed:`, err);
        return json(500, { error: OPAQUE });
      }
    }

    if (method !== "POST") return json(405, { error: "POST only" });
    if (!jsonBody(req)) return unsupportedType(res);
    const body = (await readJson(req)) as Record<string, unknown>;

    try {
      if (path.startsWith("/api/agents/")) {
        const name = decodeURIComponent(path.slice("/api/agents/".length));
        const input = typeof body.input === "string" ? body.input : "";
        if (!input) return json(400, { error: "input is required" });
        if (!app.plans[name]) return json(404, { error: `no agent named "${name}"` });
        const asked = {
          history: Array.isArray(body.history) ? (body.history as never) : undefined,
          thread: typeof body.thread === "string" ? body.thread : undefined,
        };

        // The same request either way. A caller that says it can read events as
        // they happen is given them; one that does not is given the answer, and
        // the two are the same answer.
        if (!wantsEvents(req)) return json(200, await app.ask(name, input, asked));

        // A caller that asks for AG-UI gets AG-UI. Anything that already renders agents
        // speaks that vocabulary, and praecise's own `Progress` union would otherwise
        // need a translator per consumer.
        const asAgui = url.searchParams.get("protocol") === "ag-ui";
        const modes = modesFrom(url.searchParams.get("stream"));

        const channel = openChannel(req, res, { named: asAgui });
        const stream = asAgui ? new AguiStream(`${name}-${Date.now().toString(36)}`, modes) : undefined;
        let failed: string | undefined;
        try {
          for (const opening of stream?.started() ?? []) channel.send(opening);
          for await (const event of app.watch(name, input, {
            ...asked,
            signal: channel.signal,
          })) {
            if (!stream) {
              channel.send(event);
              continue;
            }
            for (const translated of stream.take(event)) channel.send(translated);
          }
        } catch (err) {
          failed = (err as Error).message;
          throw err;
        } finally {
          // Whatever happened, an open message is closed: a renderer left with an open
          // bubble and no closing event shows a spinner that never stops, which is the
          // most common way a correct stream looks broken.
          for (const closing of stream?.finish(failed ? "error" : "ok", failed) ?? []) {
            channel.send(closing);
          }
          channel.close();
        }
        return;
      }

      if (path.startsWith("/api/functions/")) {
        const name = decodeURIComponent(path.slice("/api/functions/".length));
        if (!app.project.functions[name]) return json(404, { error: `no function named "${name}"` });
        // Named as HTTP so a guard can refuse whoever can reach the port a tool
        // it would happily give a workflow step.
        return json(200, { result: (await app.callTool(name, body, { via: "http" })) ?? null });
      }

      if (path.startsWith("/api/workflows/")) {
        const name = decodeURIComponent(path.slice("/api/workflows/".length));
        const input = (body.input ?? body) as Record<string, unknown>;
        return json(200, await app.startWorkflow(name, input));
      }

      if (path.startsWith("/api/runs/")) {
        const id = decodeURIComponent(path.slice("/api/runs/".length));
        // Approval is an explicit act: `approved` must be literally true or
        // false. Defaulting an empty body to "approved" would let any caller
        // that can reach the endpoint wave the gate through by accident.
        if (body.approved !== true && body.approved !== false) {
          return json(400, { error: "approved must be true or false" });
        }
        return json(
          200,
          await app.resumeWorkflow(id, {
            approved: body.approved,
            note: typeof body.note === "string" ? body.note : undefined,
            approver: typeof body.approver === "string" ? body.approver : undefined,
            signature: typeof body.signature === "string" ? body.signature : undefined,
            at: typeof body.at === "number" ? body.at : undefined,
            // Everything an agent's own tools can reach arrives here. Recorded on
            // the ledger so a run that approved itself is legible afterwards, and
            // refused outright by an app that has told the runner its gates answer
            // to some other channel.
            channel: "http",
          }),
        );
      }
    } catch (err) {
      // These are the framework's own refusals — an unknown agent, a gate that
      // needs a distinct approver, a signature that did not verify — and the
      // caller has to be able to read them or the boundary is unusable. They go
      // out redacted, and an error that quoted an upstream body goes out as the
      // fact that the upstream refused and nothing it said.
      return json(400, { error: safeMessage(err, `${method} ${path}`) });
    }

    return json(404, { error: `no such endpoint: ${path}` });
  }

  await new Promise<void>((ready) => server.listen(requested, host, ready));
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
      const next = await App.load({ tracer: traces.tracer, ...options, revision: String(Date.now()) });
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
    token,
    banner() {
      const at = `http://${isLoopback(host) ? "localhost" : host}:${port}`;
      if (!token) {
        return `praecise dev server on ${at}\n  serving OPEN — no token. Anything that can reach this port can drive the app.`;
      }
      return [
        `praecise dev server on ${at}`,
        `  token: ${token}`,
        `  /api/* and /mcp need it: Authorization: Bearer ${token}`,
      ].join("\n");
    },
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

/**
 * Read a JSON body, and refuse anything that did not say it was one.
 *
 * The content type is not pedantry here, it is the CSRF boundary. A cross-origin
 * `fetch` may send `text/plain` with no preflight at all, so the request lands
 * before any Origin check can be consulted; `application/json` is on the list of
 * types that force a preflight, and the preflight is where a refusal can happen.
 * Every POST this server takes is a mutation, so every one of them has to pass.
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") {
    throw new Error(
      `this endpoint takes \`Content-Type: application/json\`${type ? ` and this request said "${type}"` : " and this request said nothing"}. ` +
        `It is required on every POST because a request a browser can make WITHOUT it is one that arrives before any origin check can refuse it.`,
    );
  }

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
export { A2A_VERSION, AGENT_CARD_PATH, agentCard, handleA2A, TaskStore } from "./a2a.js";
export type { Task, TaskState, TaskStatus, A2AMessage, Part } from "./a2a.js";
