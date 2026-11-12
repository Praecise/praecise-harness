/**
 * The app, published as an MCP server.
 *
 * Every agent becomes a tool, and so does every workflow and every function.
 * That is the whole point of the endpoint: an app built here is immediately
 * callable from any MCP client — a chat app, an IDE, another Praecise Harness app —
 * without the author writing any protocol code.
 *
 * The three lists are not interchangeable, and the protocol is explicit about
 * why: tools are chosen by the model, resources are attached by the application,
 * and prompts are picked by a person. `prompts/` and `resources/` exist as
 * separate folders for the same reason — who decides is part of the design.
 */

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import type { AnswerSelf } from "../harness/selves.js";
import type { Progress } from "../harness/types.js";
import type { Run } from "../workflow/store.js";
import { schemaFor } from "../compile/plan.js";
import { interpolate } from "../workflow/interpolate.js";
import type { Access, Effect, Published } from "../define.js";
import { decodeHeaderValue } from "../harness/mcp.js";
import type { App } from "../app.js";
import { McpTaskStore, type TaskRecord } from "./mcp-tasks.js";
import { SKILLS_EXTENSION, getSkill, listSkills, readSkillDirectory, readSkillFile, servesSkills } from "./mcp-skills.js";

/**
 * The MCP revision this serves. One revision, the current one, no fallbacks.
 *
 * `2026-07-28` deleted the `initialize` handshake and made the protocol stateless: this
 * server infers nothing from what arrived earlier on the same connection, because there
 * is no longer any such thing as "the same connection" in protocol terms. Every request
 * says which version it speaks and what the client can do; every result says what kind of
 * result it is and who produced it.
 *
 * A dual-era server — one that also answers `initialize` for older clients — is explicitly
 * allowed by the spec and explicitly not built here. Two protocol implementations in one
 * endpoint is two things to keep correct, and the second one exists only to serve clients
 * that will themselves be upgraded. An older client gets a refusal that names this
 * version, which the spec asks for precisely because a legacy client has no way to
 * fall forward and that message is the only diagnostic its user will ever see.
 */
export const PROTOCOL_VERSION = "2026-07-28";

/**
 * How long a client may cache a list before asking again, and who may hold that copy.
 *
 * Required on every list and read in this revision. `private` is the only defensible
 * scope here: what this server publishes depends on the caller's access, so a shared
 * intermediary caching one caller's tool list and serving it to another would be handing
 * over a list of tools that caller was never granted.
 */
const CACHE_TTL_MS = 60_000;
const CACHE_SCOPE = "private" as const;

/** Codes this revision reserves. Nothing outside `-32020..-32099` may mean these things. */
const HEADER_MISMATCH = -32020;
const MISSING_CAPABILITY = -32021;
const UNSUPPORTED_VERSION = -32022;

/**
 * The Tasks extension: a `tools/call` answered with a task the caller polls, so that work
 * which takes longer than a connection lasts is not lost with it.
 *
 * Declared by a client on each request and by this server in `server/discover`. Only a
 * workflow is answered this way. An agent's answer is one model turn after another with
 * nothing kept between them that a later request could pick up, so it stays inside the
 * request that asked for it.
 */
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/**
 * How long a task is kept, counted from when it was created.
 *
 * A day, because the slow case here is a run waiting for a person to approve it, and a
 * person may not look until tomorrow. The run itself is kept by the workflow store for
 * as long as it always was; this is only how long the task id goes on finding it.
 */
const TASK_TTL_MS = 24 * 60 * 60_000;

/** How often a client is asked to look. A step of a run is a model call: seconds. */
const TASK_POLL_MS = 1_000;

/** One store per app, under its state directory beside the runs the tasks stand for. */
const taskStores = new WeakMap<App, McpTaskStore>();
function tasksOf(app: App): McpTaskStore {
  let store = taskStores.get(app);
  if (!store) {
    store = new McpTaskStore(resolve(app.stateDir, "mcp-tasks"));
    taskStores.set(app, store);
  }
  return store;
}

/**
 * The tasks whose runs this process is driving right now.
 *
 * Only used to tell "the run has not been written yet" from "the run was never written":
 * a task is recorded before its run is, and for that moment there is no run to read.
 */
const driving = new WeakMap<App, Set<string>>();
function drivenBy(app: App): Set<string> {
  let set = driving.get(app);
  if (!set) {
    set = new Set();
    driving.set(app, set);
  }
  return set;
}

/** Whether a request's client declared the Tasks extension. */
function speaksTasks(meta: Record<string, unknown>): boolean {
  const declared = meta["io.modelcontextprotocol/clientCapabilities"] as
    | { extensions?: Record<string, unknown> }
    | undefined;
  const extension = declared?.extensions?.[TASKS_EXTENSION];
  return typeof extension === "object" && extension !== null;
}

/** A tool result, in the one shape `tools/call` and a completed task both carry. */
function toolResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text }], isError };
}

/**
 * Start a workflow and hand back a task for it, without waiting for the run.
 *
 * The run's id is chosen here so that the task can be written to disk, naming its run,
 * before the run has started and before the caller hears of either.
 */
async function startTask(app: App, name: string, args: Record<string, unknown>): Promise<TaskRecord> {
  const run = `${name.replace(/[^\w-]/g, "_")}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  const store = tasksOf(app);
  const record = await store.create(name, run, TASK_TTL_MS);

  const active = drivenBy(app);
  active.add(record.id);
  void app
    .startWorkflow(name, args, { id: run })
    .then(
      () => undefined,
      async (err: unknown) => {
        // Refused before it began, or the runner itself threw. Either way the run's own
        // file may say nothing, so the reason is kept with the task. Re-read first: the
        // task may have been cancelled since.
        const current = (await store.load(record.id)) ?? record;
        await store.save({ ...current, error: (err as Error).message }).catch(() => undefined);
      },
    )
    .finally(() => active.delete(record.id));
  return record;
}

/**
 * A task as `tasks/get` reports it, read from the record and the run it stands for.
 *
 * Nothing about the run's progress is stored with the task. A gate is answered in the
 * dashboard or at `/api/runs/{id}`, possibly by another process, and the run file is the
 * one place every one of them writes.
 */
async function taskState(app: App, record: TaskRecord): Promise<Record<string, unknown>> {
  const at = (ms: number): string => new Date(ms).toISOString();
  const base = {
    taskId: record.id,
    createdAt: at(record.createdAt),
    ttlMs: record.ttlMs,
    pollIntervalMs: TASK_POLL_MS,
  };

  // A cancellation wins over whatever the run went on to do: a caller that cancelled is
  // entitled not to be told the task completed.
  if (record.cancelledAt !== undefined) {
    return { ...base, status: "cancelled", statusMessage: "cancelled by the caller", lastUpdatedAt: at(record.cancelledAt) };
  }

  const failed = (message: string, when: number): Record<string, unknown> => ({
    ...base,
    status: "failed",
    statusMessage: message,
    lastUpdatedAt: at(when),
    error: { code: -32603, message },
  });
  if (record.error !== undefined) return failed(record.error, record.createdAt);

  const run = await app.runs.load(record.run);
  if (!run) {
    if (drivenBy(app).has(record.id)) return { ...base, status: "working", lastUpdatedAt: at(record.createdAt) };
    return failed(
      `run ${record.run} was never recorded: the server stopped between accepting this call and starting it. Call the tool again.`,
      record.createdAt,
    );
  }

  // A run still marked running that no live process is driving stays `working` until the
  // task's time is up. Nothing here can tell that from a run another process is driving.
  if (run.status === "running") return { ...base, status: "working", lastUpdatedAt: at(run.updatedAt) };

  const { text, isError, waiting } = outcomeOf(run);
  if (waiting) {
    return {
      ...base,
      status: "input_required",
      statusMessage:
        `Waiting for a person to approve step "${waiting.step}" of run ${run.id}: ` +
        `${run.waitingFor?.prompt ?? "approval is required"} ` +
        `Approve or reject it in the dashboard, or POST to /api/runs/${run.id}. It cannot be approved over MCP.`,
      lastUpdatedAt: at(run.updatedAt),
      // Empty, and meant: what the run needs is a person's decision, which is not a
      // request this protocol lets a client answer.
      inputRequests: {},
    };
  }
  if (isError) return failed(text, run.updatedAt);
  return { ...base, status: "completed", lastUpdatedAt: at(run.updatedAt), result: toolResult(text) };
}

/** A connection that stays open: somewhere to send messages, and word of when it closes. */
export interface McpStream {
  /** Send one JSON-RPC message ahead of the reply. */
  send(message: unknown): void;
  /** Aborted when the caller has gone, or has cancelled the request. */
  signal: AbortSignal;
}

/** The key every message on a subscription carries: the id of the request that opened it. */
const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

/** How often a subscribed task is looked at when nothing in this process said it moved. */
const TASK_WATCH_MS = 1_000;

/**
 * Serve one subscription to task changes, until every task it follows is finished or
 * the caller goes away.
 *
 * Acknowledges first, with the ids it will follow: the ones that exist and that this
 * caller may see. One it may not see is left out without a word, which is what an id
 * that does not exist gets. Then each task's state is sent whole whenever it changes,
 * so a client needs no `tasks/get` to learn what happened.
 *
 * A task's state is read from its run, and a run may be moved by another process, with
 * an approval given in a dashboard somewhere else. So a change is looked for two ways:
 * at once when this process's own run store reports one, and every second regardless.
 *
 * When the last task finishes the subscription is closed with a reply, which is the
 * protocol's way of saying it ended on purpose.
 */
async function followTasks(
  app: App,
  caller: Caller,
  ids: string[],
  id: string | number,
  stream: McpStream,
  ok: (result: Record<string, unknown>) => unknown,
): Promise<unknown | undefined> {
  const store = tasksOf(app);
  const tagged = { [SUBSCRIPTION_ID]: id };
  const visible = async (taskId: string): Promise<TaskRecord | undefined> => {
    const record = await store.load(taskId);
    const owner = record ? entriesOf(app).find((candidate) => candidate.name === record.tool) : undefined;
    return record && owner && permits(caller, owner.spec, owner.group) ? record : undefined;
  };

  const following = new Map<string, string | undefined>();
  for (const taskId of ids) if (await visible(taskId)) following.set(taskId, undefined);

  stream.send({
    jsonrpc: "2.0",
    method: "notifications/subscriptions/acknowledged",
    params: { _meta: tagged, notifications: following.size ? { taskIds: [...following.keys()] } : {} },
  });

  let wake: () => void = () => undefined;
  const unwatch = app.onRunChange(() => wake());
  const gone = (): void => wake();
  stream.signal.addEventListener("abort", gone, { once: true });
  try {
    let first = true;
    while (following.size && !stream.signal.aborted) {
      for (const taskId of following.keys()) {
        const record = await visible(taskId);
        if (!record) {
          // Its time ran out. There is nothing left to say about it.
          following.delete(taskId);
          continue;
        }
        const state = await taskState(app, record);
        const mark = `${String(state.status)}\n${String(state.statusMessage ?? "")}`;
        // The first look says where a task already is, unless that is only "working":
        // it may have finished between being created and being listened for, and a
        // change made before anyone was listening would otherwise never be sent.
        const news = first ? state.status !== "working" : following.get(taskId) !== mark;
        following.set(taskId, mark);
        if (news && !stream.signal.aborted) {
          stream.send({ jsonrpc: "2.0", method: "notifications/tasks", params: { ...state, _meta: tagged } });
        }
        if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") {
          following.delete(taskId);
        }
      }
      first = false;
      if (!following.size || stream.signal.aborted) break;
      await new Promise<void>((done) => {
        const timer = setTimeout(done, TASK_WATCH_MS);
        wake = () => {
          clearTimeout(timer);
          done();
        };
      });
    }
  } finally {
    unwatch();
    stream.signal.removeEventListener("abort", gone);
  }
  // Gone, or cancelled: there is nobody to reply to, and a cancelled request gets none.
  if (stream.signal.aborted) return undefined;
  return ok({ _meta: tagged });
}

/**
 * What the far end of the connection is allowed to see.
 *
 * `identified` is deliberately not "authenticated": how a caller proved itself
 * is the transport's business, and the two transports do it differently — a
 * hosted endpoint checks a token, a local one is trusted because the person who
 * launched it is the person using it.
 */
export interface Caller {
  identified?: boolean;
  /** Publish only these groups. Undefined means all of them. */
  groups?: string[];
  /**
   * Publish only what changes nothing. For a caller that came to read — an
   * indexer, a search box, a colleague looking around — this removes the
   * question of whether it may act, rather than answering it.
   */
  readOnly?: boolean;
  /**
   * The HTTP headers this request arrived with, when it arrived over HTTP.
   *
   * Absent on stdio, where there are no headers and nothing to disagree with the body.
   * Passing them is what lets the handler enforce the header/body agreement the spec
   * requires — a validation that cannot be done at the transport, because only the
   * handler has parsed the body it must be compared against.
   */
  headers?: Record<string, string>;
  /**
   * The person a request is for, as the caller vouches for them. Read from
   * `params._meta["com.praecise/person"]` on `tools/call`. It names a per-person
   * self and binds the answer's ticket; it grants nothing.
   */
  person?: string;
  /**
   * Where the request was made, as the caller names it: `_meta["com.praecise/surface"]`
   * on `tools/call`. It chooses a self's per-surface persona; it grants nothing.
   */
  surface?: string;
  /**
   * What the request is about, when `arguments.input` carries grounding as well:
   * `_meta["com.praecise/task"]` on a `tools/call`.
   */
  task?: string;
}

/**
 * Where the mirrored headers disagree with the request body, if they do.
 *
 * Only meaningful over HTTP; stdio has no headers and this returns nothing there. The
 * comparison is against the DECODED header, because a name that could not be spelled in
 * ASCII arrives base64-wrapped and would otherwise never match the body it came from.
 */
export function headerFault(
  request: { method?: string; params?: Record<string, unknown> },
  headers?: Record<string, string>,
): string | undefined {
  if (!headers) return undefined;
  const read = (key: string): string | undefined => {
    const found = Object.entries(headers).find(([name]) => name.toLowerCase() === key);
    return found?.[1];
  };

  const version = read("mcp-protocol-version");
  const stated = (request.params?._meta as Record<string, unknown> | undefined)?.[
    "io.modelcontextprotocol/protocolVersion"
  ];
  if (version !== undefined && typeof stated === "string" && version !== stated) {
    return `MCP-Protocol-Version header "${version}" does not match the body's "${stated}"`;
  }

  const method = read("mcp-method");
  if (method === undefined) return "the Mcp-Method header is required";
  if (method !== request.method) {
    return `Mcp-Method header "${method}" does not match the body's "${String(request.method)}"`;
  }

  // The three core methods that name something, and the three of the Tasks extension,
  // which mirror the task's id the same way.
  const wants =
    request.method === "resources/read" ? "uri" : String(request.method).startsWith("tasks/") ? "taskId" : "name";
  const needsName = ["tools/call", "prompts/get", "resources/read", "tasks/get", "tasks/update", "tasks/cancel"].includes(
    String(request.method),
  );
  if (!needsName) return undefined;

  const sent = read("mcp-name");
  const actual = request.params?.[wants];
  if (typeof actual !== "string") return undefined; // the body is malformed; that error is elsewhere
  if (sent === undefined) return `the Mcp-Name header is required on ${String(request.method)}`;
  // The client's own encoder, run backwards — one definition of the sentinel, so the
  // two sides cannot drift into disagreeing about what a value decodes to.
  const decoded = decodeHeaderValue(sent);
  if (decoded !== actual) {
    return `Mcp-Name header "${decoded}" does not match the body's "${actual}"`;
  }
  return undefined;
}



/** Everything published, alongside the declaration that governs it. */
interface Entry {
  name: string;
  group: string;
  spec: Published;
  tool: McpTool;
}

/** May this caller see and call it? */
function permits(caller: Caller, spec: Published, group: string): boolean {
  const access: Access = spec.access ?? "open";
  if (access === "internal") return false;
  if (access === "gated" && !caller.identified) return false;
  // Publishing an agent or a workflow by default is the point of the endpoint.
  // Publishing something declared `effect: "destructive"` by default is not: the
  // author has already said calling it is not undoable and not repeatable, and
  // "I did not write an `access` line" cannot be what puts that in front of every
  // stranger with an MCP client. Naming an access tier is the opt-in — `"open"`
  // publishes it, and now says so on purpose.
  if ((spec.effect ?? "write") === "destructive" && spec.access === undefined) return false;
  if (caller.readOnly && (spec.effect ?? "write") !== "read") return false;
  return !caller.groups || caller.groups.includes(spec.group ?? group);
}

/**
 * How many tools a caller can hold in mind at once before it starts acting where
 * it should have declined. Twenty is where the measured decline rate falls off,
 * and the fix is never a longer list — it is groups, or marking the parts that
 * were never meant for strangers `internal`.
 */
const CROWDED = 20;

/** What is worth telling the author about the surface they are about to publish. */
export function noticesOf(app: App, caller: Caller = {}): string[] {
  const tools = toolsOf(app, caller);
  const notices: string[] = [];
  for (const entry of entriesOf(app)) {
    const fault = viewOf(app, entry.spec).fault;
    if (fault) notices.push(`"${entry.name}" is published without its view: ${fault}.`);
  }
  if (tools.length <= CROWDED) return notices;
  return [
    ...notices,
    `${tools.length} tools published. A caller shown more than about ${CROWDED} starts ` +
      `acting where it should have declined — publish a group at a time, or mark what ` +
      `was never meant to leave \`access: "internal"\`.`,
  ];
}

/**
 * Effects, as the protocol's hints. The defaults are the cautious reading: an
 * undeclared thing is assumed to change the world and to be unsafe to repeat,
 * because the cost of guessing wrong that way is a stale warning, and the cost
 * of guessing wrong the other way is a caller destroying something quietly.
 */
function annotate(effect: Effect = "write"): Record<string, unknown> {
  return {
    readOnlyHint: effect === "read",
    destructiveHint: effect === "destructive",
    idempotentHint: effect !== "destructive",
    openWorldHint: true,
  };
}

interface Request {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** What rides beside the tool: its interactive view, for a client that renders them. */
  _meta?: Record<string, unknown>;
}

/** MCP Apps: a tool may name a `ui://` page for a host to show beside its result. */
export const UI_EXTENSION = "io.modelcontextprotocol/ui";
/** The media type an MCP App's page is served as. */
export const UI_MIME = "text/html;profile=mcp-app";

/** The media type a resource is served as: what it said, or what its address implies. */
function mimeOf(spec: { uri: string; mime?: string }): string {
  return spec.mime ?? (spec.uri.startsWith("ui://") ? UI_MIME : "text/plain");
}

/** Whether a request's client said it renders MCP Apps. */
function rendersViews(meta: Record<string, unknown>): boolean {
  const declared = meta["io.modelcontextprotocol/clientCapabilities"] as
    | { extensions?: Record<string, { mimeTypes?: unknown } | undefined> }
    | undefined;
  const types = declared?.extensions?.[UI_EXTENSION]?.mimeTypes;
  return Array.isArray(types) && types.includes(UI_MIME);
}

/**
 * What a published thing declared about its view, checked against the app's resources.
 *
 * A declaration is honoured only if it names a `ui://` resource the app really has and
 * serves as an MCP App. One that names anything else is left off the tool and reported
 * by `noticesOf`: a client told of a view it cannot then read shows a broken frame.
 * A tool for views only keeps that marking even without a page, since it is a statement
 * about who may call it.
 */
function viewOf(app: App, spec: Published): { ui?: Record<string, unknown>; fault?: string } {
  if (spec.ui === undefined) return {};
  const declared = typeof spec.ui === "string" ? { resource: spec.ui } : spec.ui;
  const visibility = declared.visibility?.filter((who) => who === "model" || who === "app");
  const page = Object.values(app.project.resources).find((entry) => entry.uri === declared.resource);
  if (!declared.resource.startsWith("ui://")) {
    return { fault: `its \`ui\` is "${declared.resource}", and a view's address starts ui://` };
  }
  if (!page) return { fault: `its \`ui\` names ${declared.resource}, and no resource in resources/ has that uri` };
  if (mimeOf(page) !== UI_MIME) {
    return { fault: `its \`ui\` names ${declared.resource}, which is served as ${mimeOf(page)} and not ${UI_MIME}` };
  }
  return { ui: { resourceUri: declared.resource, ...(visibility?.length ? { visibility } : {}) } };
}

/** Everything the app could publish, before a caller narrows it down. */
function entriesOf(app: App): Entry[] {
  const entries: Entry[] = [];
  const taken = new Set<string>();

  const add = (name: string, group: string, spec: Published, tool: McpTool) => {
    if (taken.has(name)) return;
    taken.add(name);
    const { ui } = viewOf(app, spec);
    entries.push({ name, group, spec, tool: ui ? { ...tool, _meta: { ui } } : tool });
  };

  for (const name of app.agentNames) {
    add(name, "agents", app.project.agents[name] ?? {}, {
      name,
      description: app.plans[name]!.description,
      inputSchema: {
        type: "object",
        properties: { input: { type: "string", description: `What to ask ${name}.` } },
        required: ["input"],
        additionalProperties: false,
      },
      annotations: annotate(app.project.agents[name]?.effect),
    });
  }

  for (const name of app.workflowNames) {
    const spec = app.project.workflows[name]!;
    add(name, "workflows", spec, {
      name,
      description: spec.description ?? `Run the ${name} workflow.`,
      inputSchema: schemaFor(spec.input),
      annotations: annotate(spec.effect),
    });
  }

  for (const [name, spec] of Object.entries(app.project.functions)) {
    add(name, "functions", spec, {
      name,
      description: spec.description ?? `Call the ${name} function.`,
      inputSchema: schemaFor(spec.input),
      annotations: annotate(spec.effect),
    });
  }

  return entries;
}

/**
 * The tools this caller may see.
 *
 * `views` is for a caller that renders MCP Apps: it is told which tools bring a view,
 * and is shown the tools that only a view may call, which it is then bound to keep from
 * its model. Anyone else gets the list without either. A client that has never heard of
 * views would hand a view-only tool straight to a model.
 */
export function toolsOf(app: App, caller: Caller = {}, views = false): McpTool[] {
  return publishedOf(app, caller, views).map((entry) => entry.tool);
}

/**
 * The same list, with the group each capability came from.
 *
 * `toolsOf` drops it, which is right for MCP — a tool is called by name there and the route does
 * not exist. Anything building an HTTP link needs it: agents, workflows and functions are served
 * on three different paths, and a discovery document that guesses one of them is a dead link for
 * two thirds of what it advertises.
 */
export function publishedOf(app: App, caller: Caller = {}, views = false): { tool: McpTool; group: string }[] {
  const forViewsOnly = (tool: McpTool): boolean => {
    const visibility = (tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility;
    return Array.isArray(visibility) && !visibility.includes("model");
  };
  return entriesOf(app)
    .filter((entry) => permits(caller, entry.spec, entry.group))
    .filter((entry) => views || !forViewsOnly(entry.tool))
    .map((entry) => {
      const { _meta: _beside, ...plain } = entry.tool;
      return { tool: views ? entry.tool : plain, group: entry.spec.group ?? entry.group };
    });
}

/** The groups an app publishes, for a packager or a caller choosing a subset. */
export function groupsOf(app: App): string[] {
  return [...new Set(entriesOf(app).map((entry) => entry.spec.group ?? entry.group))].sort();
}

/** Canned requests a person picks, filled in from their arguments. */
export function promptsOf(app: App): { name: string; description?: string; arguments: unknown[] }[] {
  return Object.entries(app.project.prompts).map(([name, spec]) => ({
    name,
    description: spec.description,
    arguments: Object.entries(spec.input ?? {}).map(([key, hint]) => ({
      name: key,
      description: hint,
      required: true,
    })),
  }));
}

/** Context the application offers, for a client to attach. */
export function resourcesOf(
  app: App,
): { uri: string; name: string; description?: string; mimeType?: string; _meta?: Record<string, unknown> }[] {
  return Object.entries(app.project.resources).map(([name, spec]) => ({
    uri: spec.uri,
    name,
    description: spec.description,
    mimeType: mimeOf(spec),
    // What a view's page needs of whoever renders it, listed with it so a client can
    // decide before it reads.
    ...(spec.ui && spec.uri.startsWith("ui://") ? { _meta: { ui: spec.ui } } : {}),
  }));
}

/**
 * What a workflow run has come to, as a published call reports it.
 *
 * `waiting` is set when the run stopped at an approval gate. The text says so either way;
 * the field is for a protocol that has a state for "this needs a person" and should not
 * have to find that out by reading prose.
 */
export function outcomeOf(run: Run): { text: string; isError?: boolean; waiting?: { run: string; step: string } } {
  if (run.status === "waiting" && run.waitingFor) {
    return {
      text:
        `Run ${run.id} is paused for approval at step "${run.waitingFor.step}".\n\n` +
        `${run.waitingFor.prompt}\n\n` +
        `Approve or reject it in the dashboard, or POST to /api/runs/${run.id}.`,
      waiting: { run: run.id, step: run.waitingFor.step },
    };
  }
  if (run.status === "failed") return { text: run.error ?? "the run failed", isError: true };
  return {
    text: typeof run.result === "string" ? run.result : JSON.stringify(run.result ?? null, null, 2),
  };
}

/**
 * Call one published thing by name, under the same rules the protocol applies.
 *
 * Exported because the tool list is not the only way an app is used: something
 * that can run code calls this directly, and it must get the same answer and
 * the same refusals as something speaking JSON-RPC.
 */
export async function callPublished(
  app: App,
  name: string,
  args: Record<string, unknown>,
  caller: Caller = {},
  /**
   * For a caller that can do something with the work while it happens. `onProgress` is
   * passed to an agent's ask and never called for a workflow or a function, which report
   * nothing on the way; `signal` stops an agent's ask.
   */
  live: { onProgress?: (event: Progress) => void; signal?: AbortSignal } = {},
): Promise<{ text: string; isError?: boolean; self?: AnswerSelf; waiting?: { run: string; step: string } }> {
  // Checked here and not only in `tools/list`: nothing stops a caller asking for
  // a name it was never told about. A thing it may not reach reads exactly like
  // a thing that does not exist, so the refusal does not confirm what is behind
  // the gate.
  const entry = entriesOf(app).find((candidate) => candidate.name === name);
  if (!entry || !permits(caller, entry.spec, entry.group)) {
    return { text: `nothing named "${name}" in this app`, isError: true };
  }

  if (app.agentNames.includes(name)) {
    const input = typeof args.input === "string" ? args.input : JSON.stringify(args);
    // Middleware may replace the reply, so a fragment shown before it ran could be one
    // the answer does not contain. `App.watch` withholds them for that reason, and so
    // does this.
    const held = Boolean(app.project.middleware);
    const onProgress = live.onProgress;
    const answer = await app.ask(name, input, {
      ...(caller.person ? { caller: { person: caller.person } } : {}),
      ...(caller.surface ? { surface: caller.surface } : {}),
      ...(caller.task ? { task: caller.task } : {}),
      ...(live.signal ? { signal: live.signal } : {}),
      ...(onProgress
        ? { onProgress: (event: Progress) => (held && event.kind === "text" ? undefined : onProgress(event)) }
        : {}),
    });
    return { text: answer.text, ...(answer.self ? { self: answer.self } : {}) };
  }

  if (app.workflowNames.includes(name)) {
    return outcomeOf(await app.startWorkflow(name, args));
  }

  if (app.project.functions[name]) {
    // Marked as having come over the published surface, so a guard can hold the
    // MCP endpoint to a different rule than a workflow step or the CLI.
    const value = await app.callTool(name, args, { via: "mcp" });
    return { text: typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2) };
  }

  return { text: `nothing named "${name}" in this app`, isError: true };
}

/**
 * Handle one JSON-RPC message. Returns `undefined` for notifications, which
 * take a 202 with no body.
 */
export async function handleMcp(
  app: App,
  message: unknown,
  caller: Caller = {},
  /**
   * Where to send what is said before the reply, for a transport that can hold a
   * connection open. Only `subscriptions/listen` uses it, and without it that method is
   * refused. For that one method the promise settles when the subscription is over:
   * with the reply that closes it, or with nothing if the caller went away first.
   */
  stream?: McpStream,
): Promise<unknown | undefined> {
  const request = message as Request;
  const id = request?.id ?? null;

  // Every result says what kind it is and who produced it. `resultType` is required in
  // this revision and load-bearing: it is what lets a client tell a finished answer from
  // an interim one asking for input, without inspecting the shape and guessing.
  const ok = (result: Record<string, unknown>) => ({
    jsonrpc: "2.0" as const,
    id,
    result: {
      resultType: "complete",
      ...result,
      _meta: {
        ...((result._meta as Record<string, unknown>)),
        "io.modelcontextprotocol/serverInfo": { name: app.name, version: app.version },
      },
    },
  });
  /** A list or read result, with the freshness hints this revision requires. */
  const cacheable = (result: Record<string, unknown>) =>
    ok({ ...result, ttlMs: CACHE_TTL_MS, cacheScope: CACHE_SCOPE });
  const fail = (code: number, msg: string, data?: unknown) => ({
    jsonrpc: "2.0" as const,
    id,
    error: { code, message: msg, ...(data === undefined ? {} : { data }) },
  });

  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return fail(-32600, "invalid request");
  }

  // ── Per-request protocol metadata ────────────────────────────────────────
  //
  // This is where a stateless protocol earns its keep and also where it can be got
  // wrong quietly. There is no handshake to have established the version, so a request
  // that does not state one cannot be served on an assumption — the spec makes the
  // missing field a malformed request rather than a defaulted one, precisely so that a
  // client speaking an older revision fails loudly instead of being half-understood.
  const meta = (request.params?._meta ?? {}) as Record<string, unknown>;
  const spoken = meta["io.modelcontextprotocol/protocolVersion"];
  const notification = id === null || id === undefined;

  if (!notification && request.method !== "server/discover") {
    if (typeof spoken !== "string") {
      return fail(
        -32602,
        `_meta["io.modelcontextprotocol/protocolVersion"] is required on every request; ` +
          `this server speaks MCP ${PROTOCOL_VERSION}`,
      );
    }
    if (spoken !== PROTOCOL_VERSION) {
      return fail(UNSUPPORTED_VERSION, "Unsupported protocol version", {
        supported: [PROTOCOL_VERSION],
        requested: spoken,
      });
    }
    if (meta["io.modelcontextprotocol/clientCapabilities"] === undefined) {
      return fail(
        -32602,
        `_meta["io.modelcontextprotocol/clientCapabilities"] is required on every request`,
      );
    }
  }

  // Headers mirror body fields so intermediaries can route without parsing, and this is
  // the check that keeps that from becoming a confused deputy: if a proxy authorises on
  // the header while this executes on the body, a disagreement between them is the
  // exploit. Refusing the request is the only safe resolution — there is no way to know
  // which of the two the caller meant.
  //
  // Notifications are exempt, and not as a convenience: this revision states outright
  // that it does not define header requirements for a notification POST. Enforcing rules
  // the spec declines to state would refuse conforming clients.
  const mismatch = notification ? undefined : headerFault(request, caller.headers);
  if (mismatch) return fail(HEADER_MISMATCH, mismatch);

  switch (request.method) {
    // The one RPC every server MUST implement. It carries no `_meta` requirement of its
    // own, by design: it is what a client asks when it does not yet know what to claim.
    case "server/discover":
      return ok({
        protocolVersions: [PROTOCOL_VERSION],
        // No `listChanged` anywhere: claiming it obliges us to emit the notification,
        // and a caller that trusts a claim we do not honour ends up with a stale
        // surface. What changes at runtime here is which agents exist inside the app,
        // not what it publishes.
        //
        // The Tasks extension is declared bare, which is all it has: it defines no
        // setting for its push channel. `subscriptions/listen` is served for task ids
        // and acknowledges exactly those, so a client that asks for list changes too is
        // told, in the acknowledgement, that it will not get them.
        //
        // Skills are declared when the app has some to serve, with directory reading,
        // which is answered from the same file list as the manifests. MCP Apps has no
        // server declaration: a client says it renders them, and is then told which
        // tools bring one.
        capabilities: {
          tools: {},
          prompts: {},
          resources: {},
          extensions: {
            [TASKS_EXTENSION]: {},
            ...(servesSkills(app) ? { [SKILLS_EXTENSION]: { directoryRead: true } } : {}),
          },
        },
        serverInfo: { name: app.name, version: app.version },
      });

    case "tools/list":
      // Deterministic order, which is not cosmetic: a client caches this list and puts
      // it in a model's context, so a stable order is what makes a prompt-cache hit
      // possible on the next turn.
      return cacheable({
        tools: [...toolsOf(app, caller, rendersViews(meta))].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      });

    case "tools/call": {
      const name = request.params?.name;
      // A bad argument is the model's mistake to correct, so it comes back as a
      // tool error it can read and retry, not a protocol error that ends the turn.
      if (typeof name !== "string") {
        return ok({
          content: [{ type: "text", text: "params.name is required, as a string" }],
          isError: true,
        });
      }
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      const callMeta = (request.params?._meta ?? {}) as Record<string, unknown>;
      const person = typeof callMeta["com.praecise/person"] === "string" ? String(callMeta["com.praecise/person"]) : undefined;
      const surface = typeof callMeta["com.praecise/surface"] === "string" ? String(callMeta["com.praecise/surface"]).slice(0, 40) : undefined;
      const task = typeof callMeta["com.praecise/task"] === "string" ? String(callMeta["com.praecise/task"]).slice(0, 2000) : undefined;
      // A workflow, for a client that said it understands tasks, is started and not
      // waited for. A client that did not say so MUST NOT be sent a task, and gets the
      // call that blocks until the run stops, as it always did. The access check is the
      // one `callPublished` makes; a name this caller may not reach falls through to it
      // and is refused there in the usual words.
      const published = entriesOf(app).find((candidate) => candidate.name === name);
      if (
        speaksTasks(meta) &&
        app.workflowNames.includes(name) &&
        published &&
        permits(caller, published.spec, published.group)
      ) {
        try {
          const record = await startTask(app, name, args);
          const created = new Date(record.createdAt).toISOString();
          return ok({
            resultType: "task",
            taskId: record.id,
            status: "working",
            createdAt: created,
            lastUpdatedAt: created,
            ttlMs: record.ttlMs,
            pollIntervalMs: TASK_POLL_MS,
          });
        } catch (err) {
          return ok(toolResult(`could not record a task for "${name}": ${(err as Error).message}`, true));
        }
      }
      try {
        const { text, isError, self } = await callPublished(app, name, args, { ...caller, ...(person ? { person } : {}), ...(surface ? { surface } : {}), ...(task ? { task } : {}) });
        // The self that answered travels in _meta, beside the content a model reads.
        return ok({ content: [{ type: "text", text }], isError: isError ?? false, ...(self ? { _meta: { "com.praecise/self": self } } : {}) });
      } catch (err) {
        return ok({
          content: [{ type: "text", text: (err as Error).message }],
          isError: true,
        });
      }
    }

    case "prompts/list":
      return cacheable({ prompts: promptsOf(app) });

    case "prompts/get": {
      const name = request.params?.name;
      if (typeof name !== "string") return fail(-32602, "params.name is required");
      const spec = app.project.prompts[name];
      if (!spec) return fail(-32602, `no prompt named "${name}"`);
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      // An argument the template needs and the caller did not send is the
      // caller's mistake, and it is answerable: the refusal names the reference
      // and lists what did arrive. Filling the hole with nothing and handing
      // back a prompt with a gap in it is not an answer to anything.
      let text: string;
      try {
        text = String(interpolate(spec.text, args, `prompt "${name}"`) ?? spec.text);
      } catch (err) {
        return fail(-32602, (err as Error).message);
      }
      return ok({
        description: spec.description,
        messages: [{ role: "user", content: { type: "text", text } }],
      });
    }

    case "resources/list":
      return cacheable({ resources: resourcesOf(app) });

    case "resources/read": {
      const uri = request.params?.uri;
      if (typeof uri !== "string") return fail(-32602, "params.uri is required");
      const spec = Object.values(app.project.resources).find((entry) => entry.uri === uri);
      if (!spec) {
        // A file of one of the app's skills is read the same way, at its own address.
        try {
          const file = await readSkillFile(app, uri);
          if (file) return cacheable({ contents: [file] });
        } catch (err) {
          return fail(-32603, `could not read "${uri}": ${(err as Error).message}`);
        }
        return fail(-32602, `no resource at "${uri}"`);
      }
      try {
        return ok({
          contents: [
            {
              uri,
              mimeType: mimeOf(spec),
              text: await spec.read(),
              // A view's page carries what it needs of its renderer on the block itself,
              // which is where the extension has a host look for it.
              ...(spec.ui && uri.startsWith("ui://") ? { _meta: { ui: spec.ui } } : {}),
            },
          ],
          // Required on a read in this revision. Zero, because a resource here is read
          // from the app when it is asked for: what was true a minute ago is not it.
          ttlMs: 0,
          cacheScope: CACHE_SCOPE,
        });
      } catch (err) {
        return fail(-32603, `could not read "${uri}": ${(err as Error).message}`);
      }
    }

    case "skills/list":
    case "skills/get":
    case "resources/directory/read": {
      // Declared only when there are skills to serve, and so served only then: a method
      // of an extension this server did not declare is a method it does not have.
      if (!servesSkills(app)) return fail(-32601, `unknown method: ${request.method}`);
      try {
        if (request.method === "skills/list") return cacheable({ skills: await listSkills(app) });
        const uri = request.params?.uri;
        if (typeof uri !== "string") return fail(-32602, "params.uri is required, as a string");
        if (request.method === "skills/get") {
          const skill = await getSkill(app, uri);
          return skill ? cacheable({ skill }) : fail(-32602, `no skill at "${uri.slice(0, 200)}"`);
        }
        const children = await readSkillDirectory(app, uri);
        return children ? cacheable({ resources: children }) : fail(-32602, `no directory at "${uri.slice(0, 200)}"`);
      } catch (err) {
        return fail(-32603, `${request.method} failed: ${(err as Error).message}`);
      }
    }

    case "tasks/get":
    case "tasks/update":
    case "tasks/cancel": {
      if (!speaksTasks(meta)) {
        return fail(
          MISSING_CAPABILITY,
          `${request.method} belongs to the ${TASKS_EXTENSION} extension, which this request's client capabilities do not declare; ` +
            `declare it under capabilities.extensions in _meta["io.modelcontextprotocol/clientCapabilities"]`,
          { requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } },
        );
      }
      const taskId = request.params?.taskId;
      if (typeof taskId !== "string") return fail(-32602, "params.taskId is required, as a string");

      const store = tasksOf(app);
      const record = await store.load(taskId);
      // A task belongs to the tool that created it, and a caller who may not call that
      // tool is told what a caller with a wrong id is told. The id is unguessable, but it
      // can be passed on, and a task must not be a way round the access rules.
      const owner = record ? entriesOf(app).find((candidate) => candidate.name === record.tool) : undefined;
      if (!record || !owner || !permits(caller, owner.spec, owner.group)) {
        return fail(
          -32602,
          `no task with id "${taskId.slice(0, 64)}": it does not exist here or its time is up ` +
            `(a task is kept for ${TASK_TTL_MS / 3_600_000} hours from when it was created). Call the tool again to start another.`,
        );
      }

      const state = await taskState(app, record);
      if (request.method === "tasks/get") return ok(state);

      if (request.method === "tasks/update") {
        // Never accepted, whatever it carries. The only thing a task here waits for is an
        // approval, and a message from a peer must not be what approves a gate: the gate
        // exists so that a person decides, on a channel that knows who they are.
        return fail(
          -32602,
          state.status === "input_required"
            ? `${String(state.statusMessage)} Nothing sent with tasks/update is taken as that decision; ` +
                `keep polling tasks/get, which follows the run once a person has decided.`
            : `task "${taskId}" is ${String(state.status)} and has asked for no input, so there is nothing for tasks/update to answer`,
        );
      }

      // tasks/cancel. The workflow runner has no way to stop a run from outside, so this
      // does not stop one: it marks the task cancelled, durably, and the task is never
      // reported as working or completed again. A run in flight goes on to its end; a
      // run at a gate stays there until a person rejects it. A task that had already
      // finished is left as it finished. The acknowledgement is the same either way,
      // because cancellation is a request and not a guarantee.
      if (state.status === "working" || state.status === "input_required") {
        await store.save({ ...record, cancelledAt: Date.now() });
      }
      return ok({});
    }

    // Named so that a client is told why, and not only that the name is unknown.
    case "tasks/list":
    case "tasks/result":
      return fail(
        -32601,
        `${request.method} is not a method of the ${TASKS_EXTENSION} extension: ` +
          `tasks/get returns a task and, once it has completed, its result`,
      );

    case "subscriptions/listen": {
      // The one request answered late. What is pushed here is the state of tasks: a
      // run moves when a model finishes a step or a person answers a gate, and a client
      // told at that moment has no reason to keep asking.
      //
      // Nothing else is acknowledged. What this app publishes is fixed for as long as
      // it runs, and a resource is read from the app when it is asked for, so there is
      // no list change or resource update this server could honestly promise to send.
      // The acknowledgement leaves those out, which is how the protocol says so.
      if (notification) return fail(-32600, "subscriptions/listen is a request and needs an id: the id names the subscription");
      if (!stream) {
        return fail(
          -32601,
          `subscriptions/listen needs a connection that stays open, and this request arrived on one that does not; poll tasks/get`,
        );
      }
      const wanted = request.params?.notifications;
      if (!wanted || typeof wanted !== "object" || Array.isArray(wanted)) {
        return fail(-32602, "params.notifications is required: an object naming what to be told about");
      }
      const asked = (wanted as { taskIds?: unknown }).taskIds;
      const ids = Array.isArray(asked) ? [...new Set(asked.filter((entry): entry is string => typeof entry === "string"))] : [];
      if (ids.length && !speaksTasks(meta)) {
        return fail(
          MISSING_CAPABILITY,
          `task notifications belong to the ${TASKS_EXTENSION} extension, which this request's client capabilities do not declare`,
          { requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } },
        );
      }
      return followTasks(app, caller, ids, id as string | number, stream, ok);
    }

    default:
      if (request.method.startsWith("notifications/")) return undefined;
      return fail(-32601, `unknown method: ${request.method}`);
  }
}
