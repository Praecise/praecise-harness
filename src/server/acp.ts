/**
 * The app's agent, inside an editor: the Agent Client Protocol.
 *
 * MCP over stdio publishes an app as tools for somebody else's agent. ACP is the other
 * way round: the editor is the client, it launches this process, and what it talks to
 * is the agent itself. The person types in the editor's panel, the agent's words and
 * tool calls stream back as they happen, and where the agent needs something only the
 * editor has (the unsaved contents of a file, a terminal, the person's say-so) it asks
 * the editor for it. Both directions are JSON-RPC 2.0, one message per line, on stdin
 * and stdout, and as in `serveStdio` nothing but protocol may be written to stdout.
 *
 * ── What maps onto what ───────────────────────────────────────────────────────
 *
 *   session                a named conversation (`harness/threads.ts`), so a session
 *                          can be loaded again by a later process, and replayed
 *   session/prompt         one ask of the agent, with its progress as `session/update`
 *   text                   `agent_message_chunk`
 *   a tool call            `tool_call`, then `tool_call_update` with how it ended
 *   session/cancel         the ask's own signal, which stops models and tools alike
 *   request_permission     the app's approval gate: asked when the app's authority
 *                          says a call needs a person, and what comes back is checked
 *                          by `App.approvalOf` exactly as a workflow gate's answer is
 *   fs/*, terminal/*       tools lent to the agent for the session, and only the ones
 *                          the client declared it has
 *
 * The lent tools are `LocalTool`s, so the app's guard and authority are asked about
 * each call as they are about any other tool. They exist because the client offered
 * them, not because the app's author chose them; an app that does not want its agent
 * writing files in an editor says so in `guard.ts`.
 *
 * ── What is not here ──────────────────────────────────────────────────────────
 *
 * No `plan` updates: an agent's ask has no plan to report, and inventing one would be
 * describing work that is not structured that way. No reasoning chunks, for the reason
 * the AG-UI stream has none. No session modes, config options, authentication methods,
 * or `session/list`: none is declared at `initialize`, so a conforming client does not
 * ask. MCP servers a client names in `session/new` are NOT connected: an agent's tools
 * are its author's, and the list is accepted and said, on stderr, to be unused.
 */

import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

import type { App } from "../app.js";
import type { LocalTool } from "../compile/plan.js";
import type { Attachment, Progress, StepUp } from "../harness/types.js";

/** The protocol version this speaks. ACP counts in whole numbers and bumps only on a breaking change. */
export const ACP_PROTOCOL_VERSION = 1;

export interface AcpOptions {
  app: App;
  /** Which agent the editor talks to. Needed when the app has more than one. */
  agent?: string;
  input?: Readable;
  output?: Writable;
  /** How long the client is given to answer a request of ours. Default five minutes. */
  requestTimeoutMs?: number;
}

export interface AcpServer {
  /** Resolves when the input closes, which is how a client says goodbye. */
  done: Promise<void>;
  close(): void;
}

/** JSON-RPC's own error codes, and the two ACP adds. */
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const REQUEST_CANCELLED = -32800;
const RESOURCE_NOT_FOUND = -32002;

/** A failure that is the caller's to read: it becomes the JSON-RPC error as written. */
class Refusal extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

interface Session {
  id: string;
  cwd: string;
  /**
   * The prompt under way, if there is one: how to stop it, and the request it answers.
   * `byRequest` is set when it was stopped by `$/cancel_request`, which is answered
   * with an error, where `session/cancel` is answered with a stop reason.
   */
  running?: { stop: AbortController; request: number | string; byRequest?: boolean };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What kind of tool call this is, in the words an editor chooses an icon by. */
function kindOf(name: string, effect?: string): string {
  if (name === READ_FILE) return "read";
  if (name === WRITE_FILE) return "edit";
  if (name === RUN_COMMAND) return "execute";
  if (effect === "read") return "read";
  if (effect === "destructive") return "delete";
  return "other";
}

const READ_FILE = "read_text_file";
const WRITE_FILE = "write_text_file";
const RUN_COMMAND = "run_command";

/**
 * Serve one app's agent to an ACP client on a pair of streams.
 *
 * Throws at once, before reading anything, when it cannot tell which agent is meant:
 * an editor that launched this has no way to choose, so the choice is made by whoever
 * wrote the launch command.
 */
export function serveAcp(options: AcpOptions): AcpServer {
  const { app } = options;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const patience = options.requestTimeoutMs ?? 300_000;

  const agent = options.agent ?? (app.agentNames.length === 1 ? app.agentNames[0] : undefined);
  if (!agent || !app.plans[agent]) {
    throw new Error(
      options.agent
        ? `no agent named "${options.agent}" in this app; its agents are ${app.agentNames.join(", ") || "none"}`
        : `this app has ${app.agentNames.length} agents (${app.agentNames.join(", ") || "none"}); say which one the editor talks to`,
    );
  }

  const sessions = new Map<string, Session>();
  /** What the client said it can do for the agent, at `initialize`. Nothing until then. */
  let client: { readTextFile: boolean; writeTextFile: boolean; terminal: boolean; name?: string } = {
    readTextFile: false,
    writeTextFile: false,
    terminal: false,
  };

  const write = (message: Record<string, unknown>): void => {
    output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const update = (sessionId: string, body: Record<string, unknown>): void =>
    write({ method: "session/update", params: { sessionId, update: body } });

  // ── Asking the client ────────────────────────────────────────────────────────

  let asked = 0;
  const pending = new Map<number, { resolve: (result: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();

  /** A request of ours to the client. Rejects if it says no, takes too long, or the signal fires. */
  function request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const id = ++asked;
    return new Promise<unknown>((done, fail) => {
      const finish = (): void => {
        clearTimeout(entry.timer);
        pending.delete(id);
        signal?.removeEventListener("abort", stopped);
      };
      const stopped = (): void => {
        finish();
        fail(new Error("the request was cancelled"));
      };
      const entry = {
        resolve: (result: unknown) => {
          finish();
          done(result);
        },
        reject: (err: Error) => {
          finish();
          fail(err);
        },
        timer: setTimeout(() => {
          finish();
          fail(new Error(`the client did not answer ${method} within ${Math.round(patience / 1000)}s`));
        }, patience),
      };
      entry.timer.unref?.();
      pending.set(id, entry);
      if (signal?.aborted) return stopped();
      signal?.addEventListener("abort", stopped, { once: true });
      write({ id, method, params });
    });
  }

  // ── What the client lends the agent ──────────────────────────────────────────

  /**
   * The client's file system and terminal, as tools, for one prompt.
   *
   * Only what the client declared. Paths are made absolute against the session's
   * working directory, because the protocol requires absolute ones and a model writes
   * relative ones. What a file or a command says is the outside world's and is marked
   * so: an instruction found in it is data.
   */
  function lent(session: Session, signal: AbortSignal, callOf: (tool: string) => string | undefined): LocalTool[] {
    const tools: LocalTool[] = [];
    const at = (path: unknown): string => {
      if (typeof path !== "string" || !path) throw new Error("path is required");
      return isAbsolute(path) ? path : resolve(session.cwd, path);
    };

    if (client.readTextFile) {
      tools.push({
        name: READ_FILE,
        description:
          "Read a text file from the person's editor, including changes they have not saved. " +
          "`line` (1-based) and `limit` read part of a long file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "The file, absolute or relative to the working directory." },
            line: { type: "integer", description: "The line to start at, counting from 1." },
            limit: { type: "integer", description: "The most lines to read." },
          },
          required: ["path"],
        },
        effect: "read",
        trust: "untrusted",
        async run(args) {
          const result = await request(
            "fs/read_text_file",
            {
              sessionId: session.id,
              path: at(args.path),
              ...(Number.isInteger(args.line) ? { line: args.line } : {}),
              ...(Number.isInteger(args.limit) ? { limit: args.limit } : {}),
            },
            signal,
          );
          const content = isObject(result) ? result.content : undefined;
          if (typeof content !== "string") throw new Error("the client answered without the file's content");
          return content;
        },
      });
    }

    if (client.writeTextFile) {
      tools.push({
        name: WRITE_FILE,
        description: "Write a text file in the person's editor, replacing what it holds. Send the whole of the new content.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "The file, absolute or relative to the working directory." },
            content: { type: "string", description: "The whole of the file's new content." },
          },
          required: ["path", "content"],
        },
        effect: "write",
        action: (args) => ({ operation: "write file", detail: { path: String(args.path ?? "") } }),
        async run(args) {
          if (typeof args.content !== "string") throw new Error("content is required");
          const path = at(args.path);
          await request("fs/write_text_file", { sessionId: session.id, path, content: args.content }, signal);
          return `Wrote ${path}.`;
        },
      });
    }

    if (client.terminal) {
      tools.push({
        name: RUN_COMMAND,
        description:
          "Run a command in a terminal in the person's editor and return what it printed and how it exited. " +
          "The person can see it running.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The program to run." },
            args: { type: "array", items: { type: "string" }, description: "Its arguments." },
            cwd: { type: "string", description: "Where to run it. Defaults to the working directory." },
          },
          required: ["command"],
        },
        // A command can do anything the person can. Declared as the worst case, so a
        // guard or an authority that gates destructive calls gates this one.
        effect: "destructive",
        trust: "untrusted",
        action: (args) => ({
          operation: "run command",
          detail: { command: String(args.command ?? ""), ...(Array.isArray(args.args) ? { args: args.args.map(String) } : {}) },
        }),
        async run(args) {
          if (typeof args.command !== "string" || !args.command) throw new Error("command is required");
          const created = await request(
            "terminal/create",
            {
              sessionId: session.id,
              command: args.command,
              ...(Array.isArray(args.args) ? { args: args.args.map(String) } : {}),
              cwd: args.cwd === undefined ? session.cwd : at(args.cwd),
              // Enough to see what happened; the client keeps the tail when there is more.
              outputByteLimit: 200_000,
            },
            signal,
          );
          const terminalId = isObject(created) ? created.terminalId : undefined;
          if (typeof terminalId !== "string") throw new Error("the client answered without a terminal id");
          const named = { sessionId: session.id, terminalId };
          // The editor shows the terminal inside the tool call it belongs to.
          const call = callOf(RUN_COMMAND);
          if (call) update(session.id, { sessionUpdate: "tool_call_update", toolCallId: call, content: [{ type: "terminal", terminalId }] });
          try {
            const exit = await request("terminal/wait_for_exit", named, signal).catch(async (err: Error) => {
              // Cancelled or out of patience: the command must not be left running.
              await request("terminal/kill", named).catch(() => undefined);
              throw err;
            });
            const printed = await request("terminal/output", named);
            const text = isObject(printed) && typeof printed.output === "string" ? printed.output : "";
            const cut = isObject(printed) && printed.truncated === true;
            const code = isObject(exit) ? exit.exitCode : undefined;
            const killed = isObject(exit) ? exit.signal : undefined;
            return [
              text,
              cut ? "(the start of the output was cut)" : "",
              typeof killed === "string" ? `Ended by signal ${killed}.` : `Exit code ${typeof code === "number" ? code : "unknown"}.`,
            ]
              .filter(Boolean)
              .join("\n");
          } finally {
            await request("terminal/release", named).catch(() => undefined);
          }
        },
      });
    }
    return tools;
  }

  // ── What the client asks ─────────────────────────────────────────────────────

  /** The words of a prompt, and what came with them that is not words. */
  function promptOf(blocks: unknown): { text: string; attachments: Attachment[] } {
    if (!Array.isArray(blocks)) throw new Refusal(INVALID_PARAMS, "prompt must be a list of content blocks");
    const texts: string[] = [];
    const attachments: Attachment[] = [];
    for (const block of blocks) {
      if (!isObject(block)) continue;
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
        attachments.push({ mime: block.mimeType, data: block.data });
      } else if (block.type === "resource_link" && typeof block.uri === "string") {
        texts.push(`[${typeof block.name === "string" ? block.name : "a resource"}: ${block.uri}]`);
      } else if (block.type === "resource" && isObject(block.resource) && typeof block.resource.uri === "string") {
        const { uri, text, blob, mimeType } = block.resource;
        if (typeof text === "string") texts.push(`${uri}:\n${text}`);
        else if (typeof blob === "string" && typeof mimeType === "string") attachments.push({ mime: mimeType, data: blob, name: uri as string });
      } else {
        // Audio is the one kind this does not declare, and a client that sends it anyway
        // is told, not answered as though it had been heard.
        throw new Refusal(INVALID_PARAMS, `a "${String(block.type)}" content block is not one this agent takes`);
      }
    }
    return { text: texts.join("\n\n"), attachments };
  }

  async function prompt(id: number | string, params: Record<string, unknown>): Promise<unknown> {
    const session = typeof params.sessionId === "string" ? sessions.get(params.sessionId) : undefined;
    if (!session) throw new Refusal(RESOURCE_NOT_FOUND, `no session "${String(params.sessionId)}"; open one with session/new or session/load`);
    if (session.running) throw new Refusal(INVALID_REQUEST, "a prompt is already running in this session; cancel it or wait for it");
    const asking = promptOf(params.prompt);
    if (!asking.text && !asking.attachments.length) throw new Refusal(INVALID_PARAMS, "the prompt is empty");

    const stop = new AbortController();
    const running: NonNullable<Session["running"]> = { stop, request: id };
    session.running = running;
    /** How a stopped prompt is answered: the stop reason, or the error a cancelled request gets. */
    const stopped = (): { stopReason: string } => {
      if (running.byRequest) throw new Refusal(REQUEST_CANCELLED, "Request cancelled");
      return { stopReason: "cancelled" };
    };

    // Progress names the tool and not the call, so calls are told apart by order: a
    // result belongs to the oldest unanswered call of that name. The same bookkeeping
    // the AG-UI stream does, for the same reason.
    let calls = 0;
    const open = new Map<string, string[]>();
    const callOf = (tool: string): string | undefined => open.get(tool)?.[0];
    const tools = lent(session, stop.signal, callOf);
    const effects = new Map(tools.map((tool) => [tool.name, tool.effect]));

    /** What the last run of fragments said, to know whether the answer repeats it. */
    let said = "";
    let saying = false;

    const approve = async (step: StepUp) => {
      const toolCallId = callOf(step.tool) ?? `call-${++calls}`;
      let outcome: unknown;
      try {
        outcome = await request(
          "session/request_permission",
          {
            sessionId: session.id,
            toolCall: {
              toolCallId,
              title: `${step.tool}: ${step.challenge}`,
              kind: kindOf(step.tool, step.effect),
              status: "pending",
              rawInput: step.args,
            },
            // Once, either way: an approval is for one action, named by its digest, and
            // "always" would be a promise about actions nobody has seen yet.
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          },
          stop.signal,
        );
      } catch (err) {
        return `Not allowed: the person could not be asked (${(err as Error).message}).`;
      }
      const chosen = isObject(outcome) && isObject(outcome.outcome) ? outcome.outcome : undefined;
      if (chosen?.outcome !== "selected") return "Not allowed: the request was cancelled before the person answered.";
      // The editor's answer is a decision arriving on the "acp" channel. Whether it
      // counts is the app's rule, the same one a workflow gate's answer is held to.
      return app.approvalOf(step, {
        approved: chosen.optionId === "allow",
        ...(client.name ? { approver: client.name } : {}),
        channel: "acp",
      });
    };

    // Read in the call that reports it, and not from a queue read afterwards: a
    // permission request and a terminal both name the tool call they belong to, so the
    // call must have its id before the tool is asked about. Middleware may replace the
    // reply, so where one is installed the fragments are withheld, as `App.watch`
    // withholds them, and the answer is said whole.
    const held = Boolean(app.project.middleware);
    const onProgress = (event: Progress): void => {
      if (stop.signal.aborted) return;
      switch (event.kind) {
        case "text":
          if (held) break;
          if (!saying) said = "";
          saying = true;
          said += event.text;
          update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } });
          break;
        case "tool": {
          saying = false;
          const toolCallId = `call-${++calls}`;
          open.set(event.name, [...(open.get(event.name) ?? []), toolCallId]);
          update(session.id, {
            sessionUpdate: "tool_call",
            toolCallId,
            title: event.name,
            name: event.name,
            kind: kindOf(event.name, effects.get(event.name)),
            status: "in_progress",
            rawInput: event.args,
          });
          break;
        }
        case "tool result": {
          saying = false;
          const toolCallId = open.get(event.name)?.shift();
          if (toolCallId) update(session.id, { sessionUpdate: "tool_call_update", toolCallId, status: event.failed ? "failed" : "completed" });
          break;
        }
        case "refused": {
          saying = false;
          const toolCallId = open.get(event.name)?.shift();
          if (toolCallId) {
            update(session.id, {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: "failed",
              content: [{ type: "content", content: { type: "text", text: event.why } }],
            });
          }
          break;
        }
        default:
          // Routing, checking, climbing: how the answer was arrived at has no update
          // of its own in this protocol, and is not dressed up as the agent thinking.
          saying = false;
      }
    };

    try {
      const answer = await app.ask(agent!, asking.text, {
        thread: session.id,
        signal: stop.signal,
        surface: "acp",
        approve,
        onProgress,
        ...(tools.length ? { tools } : {}),
        ...(asking.attachments.length ? { attachments: asking.attachments } : {}),
      });
      if (stop.signal.aborted) return stopped();
      // What was just said, fragment by fragment, is the answer; otherwise the answer
      // is said now, whole.
      if (answer.text && answer.text !== said) {
        update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer.text } });
      }
      return { stopReason: "end_turn" };
    } catch (err) {
      // A prompt that was cancelled ends as cancelled, whatever the ask threw on its
      // way out: the protocol requires that answer, not the ask's own error.
      if (stop.signal.aborted) return stopped();
      throw new Refusal(INTERNAL_ERROR, (err as Error).message);
    } finally {
      session.running = undefined;
    }
  }

  /** Say a kept conversation again, as the updates that would have built it. */
  async function replay(session: Session): Promise<void> {
    const thread = await app.threads.load(session.id);
    for (const turn of thread?.turns ?? []) {
      if (turn.role !== "user" && turn.role !== "assistant") continue;
      if (!turn.content) continue;
      update(session.id, {
        sessionUpdate: turn.role === "user" ? "user_message_chunk" : "agent_message_chunk",
        content: { type: "text", text: turn.content },
      });
    }
  }

  function workingDirectory(params: Record<string, unknown>): string {
    if (typeof params.cwd !== "string" || !isAbsolute(params.cwd)) {
      throw new Refusal(INVALID_PARAMS, "cwd is required and must be an absolute path");
    }
    if (Array.isArray(params.mcpServers) && params.mcpServers.length) {
      process.stderr.write(
        `praecise: the client named ${params.mcpServers.length} MCP server(s) for this session; they are not connected. ` +
          `An agent's tools are the ones its app declares.\n`,
      );
    }
    return params.cwd;
  }

  async function handle(method: string, params: Record<string, unknown>, id: number | string): Promise<unknown> {
    switch (method) {
      case "initialize": {
        if (!Number.isInteger(params.protocolVersion)) throw new Refusal(INVALID_PARAMS, "protocolVersion is required");
        const capabilities = isObject(params.clientCapabilities) ? params.clientCapabilities : {};
        const fs = isObject(capabilities.fs) ? capabilities.fs : {};
        const info = isObject(params.clientInfo) ? params.clientInfo : {};
        client = {
          readTextFile: fs.readTextFile === true,
          writeTextFile: fs.writeTextFile === true,
          terminal: capabilities.terminal === true,
          ...(typeof info.name === "string" ? { name: info.name } : {}),
        };
        return {
          // The client's version where it is ours, and ours where it is not: the client
          // then decides whether it can go on.
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            mcpCapabilities: { http: false, sse: false },
            sessionCapabilities: {},
          },
          authMethods: [],
          agentInfo: { name: app.name, title: `${app.name}: ${agent}`, version: app.version },
        };
      }

      case "session/new": {
        const cwd = workingDirectory(params);
        const session: Session = { id: `acp-${randomBytes(12).toString("hex")}`, cwd };
        sessions.set(session.id, session);
        return { sessionId: session.id };
      }

      case "session/load": {
        const cwd = workingDirectory(params);
        if (typeof params.sessionId !== "string") throw new Refusal(INVALID_PARAMS, "sessionId is required");
        const known = sessions.get(params.sessionId);
        const kept = await app.threads.load(params.sessionId);
        // A session of this app's is a conversation with this agent, under the name
        // this server gave it. Anything else is not a session, whatever else it is.
        if (!known && !(kept && kept.agent === agent && params.sessionId.startsWith("acp-"))) {
          throw new Refusal(RESOURCE_NOT_FOUND, `no session "${params.sessionId}"`);
        }
        const session: Session = known ?? { id: params.sessionId, cwd };
        session.cwd = cwd;
        sessions.set(session.id, session);
        // The whole conversation, before the answer: the client rebuilds its view from it.
        await replay(session);
        return {};
      }

      case "session/prompt":
        return prompt(id, params);

      default:
        throw new Refusal(METHOD_NOT_FOUND, `"${method}" is not a method this agent has; what it has is declared at initialize`);
    }
  }

  /** Stop the prompt a session is running, if it is running one. */
  function cancel(found: Session | undefined): void {
    found?.running?.stop.abort();
  }

  function dispatch(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write({ id: null, error: { code: -32700, message: "that line was not JSON" } });
      return;
    }
    if (!isObject(message)) {
      write({ id: null, error: { code: INVALID_REQUEST, message: "a message must be a JSON object" } });
      return;
    }

    // An answer to something we asked.
    if (typeof message.method !== "string") {
      const waiting = typeof message.id === "number" ? pending.get(message.id) : undefined;
      if (!waiting) return;
      if (isObject(message.error)) waiting.reject(new Error(String(message.error.message ?? "the client refused")));
      else waiting.resolve(message.result);
      return;
    }

    const params = isObject(message.params) ? message.params : {};
    const id = message.id;

    // A notification: nothing is answered, whatever happens.
    if (id === undefined || id === null) {
      if (message.method === "session/cancel") cancel(typeof params.sessionId === "string" ? sessions.get(params.sessionId) : undefined);
      else if (message.method === "$/cancel_request") {
        for (const session of sessions.values()) {
          const running = session.running;
          if (!running || running.request !== params.requestId) continue;
          running.byRequest = true;
          cancel(session);
        }
      }
      return;
    }
    if (typeof id !== "number" && typeof id !== "string") {
      write({ id: null, error: { code: INVALID_REQUEST, message: "a request's id must be a number or a string" } });
      return;
    }

    // Not queued behind one another: a prompt runs for as long as it runs, and while
    // it does the client must still be able to answer our requests and to cancel it.
    void handle(message.method, params, id).then(
      (result) => {
        write({ id, result });
        return undefined;
      },
      (err: unknown) => {
        const code = err instanceof Refusal ? err.code : INTERNAL_ERROR;
        write({ id, error: { code, message: (err as Error).message } });
        if (!(err instanceof Refusal)) process.stderr.write(`praecise: ${message.method} failed: ${(err as Error).message}\n`);
      },
    );
  }

  let buffer = "";
  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    let cut = buffer.indexOf("\n");
    while (cut >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf("\n");
      if (line) dispatch(line);
    }
  };
  input.on("data", onData);

  const done = new Promise<void>((finished) => {
    const over = (): void => {
      // The client has gone: nothing it was asked can be answered, and nothing it
      // asked for has anyone to read it.
      for (const session of sessions.values()) cancel(session);
      for (const waiting of pending.values()) waiting.reject(new Error("the client went away"));
      finished();
    };
    input.once("end", over);
    input.once("close", over);
  });

  if (typeof (input as Readable & { resume?: () => void }).resume === "function") input.resume();

  return {
    done,
    close() {
      input.off("data", onData);
      for (const session of sessions.values()) cancel(session);
      if (input === process.stdin) input.pause();
    },
  };
}
