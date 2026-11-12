/**
 * The Agent Client Protocol server: an agent of the app, as an editor sees it.
 *
 * The editor here is a pair of streams and a script. What is held is the conversation
 * in both directions: the client's requests are answered in the protocol's shapes, the
 * agent's work arrives as updates while it happens, and what the agent needs from the
 * editor (a file, a terminal, a person's permission) is asked for only where the editor
 * said it has it, and counts only as far as the app's own rules allow.
 */

import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import type { Authority } from "../src/authority.js";
import { ACP_PROTOCOL_VERSION, serveAcp, type AcpServer } from "../src/server/acp.js";
import { MODEL_ENV, TEST_MODELS, cleanup, FRAMEWORK, makeProject, stubModel, type Reply } from "./helpers.js";

const roots: string[] = [];
const open: AcpServer[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) server.close();
  await Promise.all(roots.splice(0).map(cleanup));
});

const FILES = {
  ...TEST_MODELS,
  "agents/coder.ts": `import { agent } from "${FRAMEWORK}";
    export default agent({ role: "Write code.", tools: ["deploy"] });`,
  "functions/deploy.ts": `import { fn } from "${FRAMEWORK}";
    export default fn({ description: "Deploy.", input: { to: "where" }, effect: "write", run: ({ to }) => "deployed to " + to });`,
};

type Msg = Record<string, any>;

/** An editor: writes requests, reads what comes back, and answers what it is asked. */
async function editor(replies: Reply[], options: Record<string, unknown> = {}, files: Record<string, string> = FILES) {
  const root = await makeProject(files);
  roots.push(root);
  const stub = stubModel(replies);
  const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch, ...options });

  const input = new PassThrough();
  const output = new PassThrough();
  const received: Msg[] = [];
  /** How the editor answers a request from the agent, by method. */
  const answers: Record<string, (params: Msg) => unknown> = {};
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let cut = buffer.indexOf("\n");
    while (cut >= 0) {
      const message = JSON.parse(buffer.slice(0, cut)) as Msg;
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf("\n");
      received.push(message);
      // A request from the agent: answered if the script says how, left hanging if not.
      if (typeof message.method === "string" && message.id !== undefined && answers[message.method]) {
        const result = answers[message.method]!(message.params);
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      }
    }
  });

  const server = serveAcp({ app, input, output, requestTimeoutMs: 2_000 });
  open.push(server);

  let ids = 0;
  const until = async (found: () => Msg | undefined): Promise<Msg> => {
    for (let tries = 0; tries < 600; tries++) {
      const message = found();
      if (message) return message;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`nothing arrived; received ${JSON.stringify(received).slice(0, 600)}`);
  };
  const send = (method: string, params: Msg): number => {
    const id = ++ids;
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return id;
  };
  const call = async (method: string, params: Msg): Promise<Msg> => {
    const id = send(method, params);
    return until(() => received.find((message) => message.id === id && message.method === undefined));
  };
  const notify = (method: string, params: Msg): void => void input.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  const updates = (): Msg[] => received.filter((message) => message.method === "session/update").map((message) => message.params.update);

  return { app, stub, received, answers, call, send, notify, until, updates, input };
}

const CAPABLE = { fs: { readTextFile: true, writeTextFile: true }, terminal: true };

async function started(replies: Reply[], capabilities: Msg = {}, options: Record<string, unknown> = {}) {
  const ed = await editor(replies, options);
  await ed.call("initialize", { protocolVersion: 1, clientCapabilities: capabilities, clientInfo: { name: "test-editor", version: "1" } });
  const { result } = await ed.call("session/new", { cwd: process.cwd(), mcpServers: [] });
  return { ...ed, sessionId: result.sessionId as string };
}

describe("the handshake", () => {
  it("answers initialize with the version it speaks and only what it can do", async () => {
    const ed = await editor([]);
    const { result } = await ed.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
    expect(result.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    expect(result.agentCapabilities).toEqual({
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      mcpCapabilities: { http: false, sse: false },
      sessionCapabilities: {},
    });
    expect(result.authMethods).toEqual([]);
    expect(result.agentInfo.name).toBe(ed.app.name);

    // A client on a later version is told which one this is, and decides for itself.
    const later = await ed.call("initialize", { protocolVersion: 9 });
    expect(later.result.protocolVersion).toBe(1);
  });

  it("refuses what it did not declare, and a session without an absolute working directory", async () => {
    const ed = await editor([]);
    await ed.call("initialize", { protocolVersion: 1 });
    expect((await ed.call("session/list", {})).error.code).toBe(-32601);
    expect((await ed.call("authenticate", { methodId: "x" })).error.code).toBe(-32601);
    expect((await ed.call("session/new", { cwd: "relative/path", mcpServers: [] })).error.code).toBe(-32602);
    expect((await ed.call("session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "hi" }] })).error.code).toBe(-32002);
  });

  it("will not start without knowing which agent the editor talks to", async () => {
    const root = await makeProject({
      ...FILES,
      "agents/other.ts": `import { agent } from "${FRAMEWORK}"; export default agent({ role: "Other." });`,
    });
    roots.push(root);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stubModel([]).fetch });
    expect(() => serveAcp({ app, input: new PassThrough(), output: new PassThrough() })).toThrow(/say which one/);
    expect(() => serveAcp({ app, agent: "nobody", input: new PassThrough(), output: new PassThrough() })).toThrow(/no agent named/);
    open.push(serveAcp({ app, agent: "other", input: new PassThrough(), output: new PassThrough() }));
  });
});

describe("a prompt turn", () => {
  it("streams what the agent says and ends the turn", async () => {
    const ed = await started([{ text: "Here is the answer." }]);
    const reply = await ed.call("session/prompt", { sessionId: ed.sessionId, prompt: [{ type: "text", text: "explain this" }] });

    expect(reply.result).toEqual({ stopReason: "end_turn" });
    const chunks = ed.updates().filter((update) => update.sessionUpdate === "agent_message_chunk");
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(chunk.content.type).toBe("text");
    // Said once: the fragments are the answer, and the answer is not repeated after them.
    expect(chunks.map((chunk) => chunk.content.text).join("")).toBe("Here is the answer.");
    // Every update is addressed to the session it belongs to.
    for (const message of ed.received.filter((entry) => entry.method === "session/update")) {
      expect(message.params.sessionId).toBe(ed.sessionId);
    }
  });

  it("reports a tool call when it starts and when it ends", async () => {
    const ed = await started([{ text: "", tool: { name: "deploy", args: { to: "staging" } } }, { text: "Deployed." }]);
    await ed.call("session/prompt", { sessionId: ed.sessionId, prompt: [{ type: "text", text: "deploy it" }] });

    const begun = ed.updates().find((update) => update.sessionUpdate === "tool_call")!;
    expect(begun).toMatchObject({ title: "deploy", name: "deploy", status: "in_progress", rawInput: { to: "staging" } });
    const ended = ed.updates().find((update) => update.sessionUpdate === "tool_call_update")!;
    expect(ended).toEqual({ sessionUpdate: "tool_call_update", toolCallId: begun.toolCallId, status: "completed" });
    // No plan is reported: an ask has none.
    expect(ed.updates().some((update) => update.sessionUpdate === "plan")).toBe(false);
  });

  it("reads embedded context and resource links as part of the prompt, and refuses audio", async () => {
    const ed = await started([{ text: "ok" }]);
    await ed.call("session/prompt", {
      sessionId: ed.sessionId,
      prompt: [
        { type: "text", text: "what does this do?" },
        { type: "resource", resource: { uri: "file:///src/main.ts", text: "export const x = 1;" } },
        { type: "resource_link", uri: "file:///README.md", name: "README" },
      ],
    });
    const asked = JSON.stringify(ed.stub.calls[0]!.body.messages);
    expect(asked).toContain("what does this do?");
    expect(asked).toContain("export const x = 1;");
    expect(asked).toContain("file:///README.md");

    const refused = await ed.call("session/prompt", { sessionId: ed.sessionId, prompt: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }] });
    expect(refused.error.code).toBe(-32602);
  });

  it("is stopped by session/cancel, and says so with the stop reason", async () => {
    // A model that never answers, so the turn is still running when it is cancelled.
    const root = await makeProject(FILES);
    roots.push(root);
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const gone = (): void => reject(new DOMException("aborted", "AbortError"));
        if (init?.signal?.aborted) gone();
        else init?.signal?.addEventListener("abort", gone);
      })) as typeof fetch;
    const app = await App.load({ root, env: MODEL_ENV, fetch: hanging });
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Msg[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(line) as Msg);
    });
    open.push(serveAcp({ app, input, output }));
    const write = (message: Msg): void => void input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const answer = async (id: number): Promise<Msg> => {
      for (let tries = 0; tries < 600; tries++) {
        const found = lines.find((line) => line.id === id);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("no answer");
    };

    write({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
    write({ id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
    const sessionId = (await answer(2)).result.sessionId as string;

    write({ id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "think forever" }] } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    // A second prompt while one is running is refused, not queued behind it.
    write({ id: 4, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "and this" }] } });
    expect((await answer(4)).error.code).toBe(-32600);

    write({ method: "session/cancel", params: { sessionId } });
    expect((await answer(3)).result).toEqual({ stopReason: "cancelled" });

    // The same turn stopped by `$/cancel_request` is answered as a cancelled request.
    write({ id: 5, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "again" }] } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    write({ method: "$/cancel_request", params: { requestId: 5 } });
    expect((await answer(5)).error.code).toBe(-32800);
  });
});

describe("what the editor lends the agent", () => {
  it("offers file and terminal tools only where the client declared them", async () => {
    const bare = await started([{ text: "ok" }]);
    await bare.call("session/prompt", { sessionId: bare.sessionId, prompt: [{ type: "text", text: "hi" }] });
    const without = (bare.stub.calls[0]!.body.tools as { name: string }[]).map((tool) => tool.name);
    expect(without).not.toContain("read_text_file");
    expect(without).not.toContain("write_text_file");
    expect(without).not.toContain("run_command");

    const readOnly = await started([{ text: "ok" }], { fs: { readTextFile: true } });
    await readOnly.call("session/prompt", { sessionId: readOnly.sessionId, prompt: [{ type: "text", text: "hi" }] });
    const some = (readOnly.stub.calls[0]!.body.tools as { name: string }[]).map((tool) => tool.name);
    expect(some).toContain("read_text_file");
    expect(some).not.toContain("write_text_file");
    expect(some).not.toContain("run_command");
  });

  it("reads a file through the client, with the path made absolute", async () => {
    const ed = await started([{ text: "", tool: { name: "read_text_file", args: { path: "src/main.ts", line: 3 } } }, { text: "read it" }], CAPABLE);
    const asked: Msg[] = [];
    ed.answers["fs/read_text_file"] = (params) => {
      asked.push(params);
      return { content: "the unsaved contents" };
    };
    await ed.call("session/prompt", { sessionId: ed.sessionId, prompt: [{ type: "text", text: "read main" }] });

    expect(asked).toHaveLength(1);
    expect(asked[0]!.sessionId).toBe(ed.sessionId);
    expect(asked[0]!.line).toBe(3);
    expect(asked[0]!.path).toMatch(/src[\\/]main\.ts$/);
    expect(asked[0]!.path.startsWith(process.cwd())).toBe(true);
    expect(JSON.stringify(ed.stub.calls.at(-1)!.body.messages)).toContain("the unsaved contents");
    expect(ed.updates().find((update) => update.sessionUpdate === "tool_call")!.kind).toBe("read");
  });

  it("runs a command in the client's terminal, shows it in the tool call, and releases it", async () => {
    const ed = await started([{ text: "", tool: { name: "run_command", args: { command: "npm", args: ["test"] } } }, { text: "ran" }], CAPABLE);
    const order: string[] = [];
    ed.answers["terminal/create"] = (params) => {
      order.push(`create ${params.command} ${params.args.join(" ")}`);
      return { terminalId: "term-1" };
    };
    ed.answers["terminal/wait_for_exit"] = () => (order.push("wait"), { exitCode: 1, signal: null });
    ed.answers["terminal/output"] = () => (order.push("output"), { output: "1 failing", truncated: false });
    ed.answers["terminal/release"] = () => (order.push("release"), {});
    await ed.call("session/prompt", { sessionId: ed.sessionId, prompt: [{ type: "text", text: "run the tests" }] });

    expect(order).toEqual(["create npm test", "wait", "output", "release"]);
    const told = JSON.stringify(ed.stub.calls.at(-1)!.body.messages);
    expect(told).toContain("1 failing");
    expect(told).toContain("Exit code 1");
    const embedded = ed.updates().find((update) => update.sessionUpdate === "tool_call_update" && update.content);
    expect(embedded!.content).toEqual([{ type: "terminal", terminalId: "term-1" }]);
    expect(ed.updates().find((update) => update.sessionUpdate === "tool_call")!.kind).toBe("execute");
  });

  it("puts a lent tool to the app's guard like any other", async () => {
    const root = await makeProject({
      ...FILES,
      "guard.ts": `import { guard } from "${FRAMEWORK}";
        export default guard(({ tool }) => (tool === "write_text_file" ? "Not allowed: this agent does not write files." : undefined));`,
    });
    roots.push(root);
    // Rebuilt by hand, since `started` loads the default files.
    const stub = stubModel([{ text: "", tool: { name: "write_text_file", args: { path: "a.txt", content: "x" } } }, { text: "ok" }]);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Msg[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(line) as Msg);
    });
    open.push(serveAcp({ app, input, output }));
    const write = (message: Msg): void => void input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const answer = async (id: number): Promise<Msg> => {
      for (let tries = 0; tries < 600; tries++) {
        const found = lines.find((line) => line.id === id && line.method === undefined);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("no answer");
    };
    write({ id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: CAPABLE } });
    write({ id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
    const sessionId = (await answer(2)).result.sessionId as string;
    write({ id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "write it" }] } });
    await answer(3);

    // The client was never asked to write, and the call is shown as having failed, with why.
    expect(lines.some((line) => line.method === "fs/write_text_file")).toBe(false);
    const failed = lines.map((line) => line.params?.update).find((update) => update?.sessionUpdate === "tool_call_update");
    expect(failed.status).toBe("failed");
    expect(failed.content[0].content.text).toContain("does not write files");
  });
});

describe("permission", () => {
  const authority: Authority = {
    check: (attempt) => {
      if (attempt.tool !== "deploy") return { allow: true };
      const digest = `deploy:${String(attempt.args.to)}`;
      return attempt.approvals?.some((approval) => approval.digest === digest) ? { allow: true } : { stepUp: "deploying needs a person's approval", digest };
    },
  };
  const approvals = {
    sign: async (claim: { digest?: string }) => `signed:${claim.digest}`,
    verify: async (claim: { digest?: string }, signature: string) => (signature === `signed:${claim.digest}` ? "the person at the editor" : undefined),
  };
  const deploying: Reply[] = [{ text: "", tool: { name: "deploy", args: { to: "production" } } }, { text: "done" }];

  it("asks the person through the editor when the app's authority wants approval, and goes on when they allow it", async () => {
    const ed = await started(deploying, {}, { authority, approvals });
    const asked: Msg[] = [];
    ed.answers["session/request_permission"] = (params) => {
      asked.push(params);
      return { outcome: { outcome: "selected", optionId: "allow" } };
    };
    await ed.call("session/prompt", { sessionId: ed.sessionId, prompt: [{ type: "text", text: "ship it" }] });

    expect(asked).toHaveLength(1);
    expect(asked[0]!.sessionId).toBe(ed.sessionId);
    // The request is about the tool call the editor is already showing.
    const shown = ed.updates().find((update) => update.sessionUpdate === "tool_call")!;
    expect(asked[0]!.toolCall).toMatchObject({ toolCallId: shown.toolCallId, status: "pending", rawInput: { to: "production" } });
    expect(asked[0]!.toolCall.title).toContain("needs a person's approval");
    expect(asked[0]!.options).toEqual([
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ]);
    expect(JSON.stringify(ed.stub.calls.at(-1)!.body.messages)).toContain("deployed to production");
  });

  it("does not run the call when the person rejects it, or when the request is cancelled", async () => {
    for (const outcome of [{ outcome: "selected", optionId: "reject" }, { outcome: "cancelled" }]) {
      const ed = await started(deploying, {}, { authority, approvals });
      ed.answers["session/request_permission"] = () => ({ outcome });
      await ed.call("session/prompt", { sessionId: ed.sessionId, prompt: [{ type: "text", text: "ship it" }] });
      const told = JSON.stringify(ed.stub.calls.at(-1)!.body.messages);
      expect(told).not.toContain("deployed to production");
      expect(told).toContain("Not allowed");
      expect(ed.updates().find((update) => update.sessionUpdate === "tool_call_update")!.status).toBe("failed");
    }
  });

  it("is only as good as the app's own rules: an app whose gates answer elsewhere is not cleared from an editor", async () => {
    const ed = await started(deploying, {}, { authority, approvals: { ...approvals, channels: ["cli"] } });
    ed.answers["session/request_permission"] = () => ({ outcome: { outcome: "selected", optionId: "allow" } });
    await ed.call("session/prompt", { sessionId: ed.sessionId, prompt: [{ type: "text", text: "ship it" }] });
    expect(JSON.stringify(ed.stub.calls.at(-1)!.body.messages)).not.toContain("deployed to production");
  });

  it("asks for nothing where the app has no authority", async () => {
    const ed = await started(deploying);
    await ed.call("session/prompt", { sessionId: ed.sessionId, prompt: [{ type: "text", text: "ship it" }] });
    expect(ed.received.some((message) => message.method === "session/request_permission")).toBe(false);
    expect(JSON.stringify(ed.stub.calls.at(-1)!.body.messages)).toContain("deployed to production");
  });
});

describe("sessions", () => {
  it("is a named conversation: a second prompt carries the first", async () => {
    const ed = await started([{ text: "first answer" }, { text: "second answer" }]);
    await ed.call("session/prompt", { sessionId: ed.sessionId, prompt: [{ type: "text", text: "first question" }] });
    await ed.call("session/prompt", { sessionId: ed.sessionId, prompt: [{ type: "text", text: "second question" }] });
    const carried = JSON.stringify(ed.stub.calls.at(-1)!.body.messages);
    expect(carried).toContain("first question");
    expect(carried).toContain("first answer");
    expect(carried).toContain("second question");
  });

  it("loads a session a later process kept, replaying it before answering", async () => {
    const first = await started([{ text: "first answer" }]);
    await first.call("session/prompt", { sessionId: first.sessionId, prompt: [{ type: "text", text: "first question" }] });

    // Another server over the same app: nothing in memory, only what was kept.
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Msg[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(line) as Msg);
    });
    open.push(serveAcp({ app: first.app, input, output }));
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: first.sessionId, cwd: process.cwd(), mcpServers: [] } })}\n`);
    for (let tries = 0; tries < 400 && !lines.some((line) => line.id === 1); tries++) await new Promise((resolve) => setTimeout(resolve, 5));

    const answerAt = lines.findIndex((line) => line.id === 1);
    expect(lines[answerAt]!.result).toEqual({});
    // The replay comes first, in the order it was said.
    const replayed = lines.slice(0, answerAt).map((line) => line.params.update);
    expect(replayed).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "first question" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first answer" } },
    ]);

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "acp-nothing", cwd: process.cwd(), mcpServers: [] } })}\n`);
    for (let tries = 0; tries < 400 && !lines.some((line) => line.id === 2); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lines.find((line) => line.id === 2)!.error.code).toBe(-32002);
  });
});
