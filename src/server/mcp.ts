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

import { schemaFor } from "../compile/plan.js";
import { interpolate } from "../workflow/interpolate.js";
import type { Access, Effect, Published } from "../define.js";
import type { App } from "../app.js";

export const PROTOCOL_VERSION = "2025-11-25";

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
  if (tools.length <= CROWDED) return [];
  return [
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
}

/** Everything the app could publish, before a caller narrows it down. */
function entriesOf(app: App): Entry[] {
  const entries: Entry[] = [];
  const taken = new Set<string>();

  const add = (name: string, group: string, spec: Published, tool: McpTool) => {
    if (taken.has(name)) return;
    taken.add(name);
    entries.push({ name, group, spec, tool });
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

/** The tools this caller may see. */
export function toolsOf(app: App, caller: Caller = {}): McpTool[] {
  return entriesOf(app)
    .filter((entry) => permits(caller, entry.spec, entry.group))
    .map((entry) => entry.tool);
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
export function resourcesOf(app: App): { uri: string; name: string; description?: string; mimeType?: string }[] {
  return Object.entries(app.project.resources).map(([name, spec]) => ({
    uri: spec.uri,
    name,
    description: spec.description,
    mimeType: spec.mime ?? "text/plain",
  }));
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
): Promise<{ text: string; isError?: boolean }> {
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
    const answer = await app.ask(name, input);
    return { text: answer.text };
  }

  if (app.workflowNames.includes(name)) {
    const run = await app.startWorkflow(name, args);
    if (run.status === "waiting" && run.waitingFor) {
      return {
        text:
          `Run ${run.id} is paused for approval at step "${run.waitingFor.step}".\n\n` +
          `${run.waitingFor.prompt}\n\n` +
          `Approve or reject it in the dashboard, or POST to /api/runs/${run.id}.`,
      };
    }
    if (run.status === "failed") return { text: run.error ?? "the run failed", isError: true };
    return {
      text:
        typeof run.result === "string" ? run.result : JSON.stringify(run.result ?? null, null, 2),
    };
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
): Promise<unknown | undefined> {
  const request = message as Request;
  const id = request?.id ?? null;

  const ok = (result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
  const fail = (code: number, msg: string) => ({
    jsonrpc: "2.0" as const,
    id,
    error: { code, message: msg },
  });

  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return fail(-32600, "invalid request");
  }

  switch (request.method) {
    case "initialize":
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        // No `listChanged` anywhere: claiming it obliges us to emit the
        // notification, and a caller that trusts a claim we do not honour ends
        // up with a stale surface. What changes at runtime here is which agents
        // exist inside the app, not what it publishes.
        capabilities: { tools: {}, prompts: {}, resources: {} },
        serverInfo: { name: app.name, version: app.version },
      });

    case "notifications/initialized":
      return undefined;

    case "ping":
      return ok({});

    case "tools/list":
      return ok({ tools: toolsOf(app, caller) });

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
      try {
        const { text, isError } = await callPublished(app, name, args, caller);
        return ok({ content: [{ type: "text", text }], isError: isError ?? false });
      } catch (err) {
        return ok({
          content: [{ type: "text", text: (err as Error).message }],
          isError: true,
        });
      }
    }

    case "prompts/list":
      return ok({ prompts: promptsOf(app) });

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
      return ok({ resources: resourcesOf(app) });

    case "resources/read": {
      const uri = request.params?.uri;
      if (typeof uri !== "string") return fail(-32602, "params.uri is required");
      const spec = Object.values(app.project.resources).find((entry) => entry.uri === uri);
      if (!spec) return fail(-32602, `no resource at "${uri}"`);
      try {
        return ok({
          contents: [{ uri, mimeType: spec.mime ?? "text/plain", text: await spec.read() }],
        });
      } catch (err) {
        return fail(-32603, `could not read "${uri}": ${(err as Error).message}`);
      }
    }

    default:
      if (request.method.startsWith("notifications/")) return undefined;
      return fail(-32601, `unknown method: ${request.method}`);
  }
}
