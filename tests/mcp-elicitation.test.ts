/**
 * A server that asks a person for something in the middle of a call.
 *
 * In MCP 2026-07-28 a server no longer sends a request of its own. It ends the call with
 * `input_required`, and the client makes the same call again carrying the answers. The
 * ways this fails quietly are all on the client: declaring a mode nothing can answer,
 * reading the interim result as the final one, losing the server's `requestState`, or
 * sending a server an answer that does not fit the form it asked for.
 */
import { afterEach, describe, expect, test } from "vitest";

import { App } from "../src/app.js";
import { FRAMEWORK, MODEL_ENV, TEST_ENDPOINT, cleanup, makeProject, stubModel } from "./helpers.js";
import type { ResolvedService } from "../src/compile/services.js";
import { InputRequired, McpClient, clientCapabilities, elicitedFault, type Elicit, type McpHost } from "../src/harness/mcp.js";

const service = (): ResolvedService =>
  ({ name: "svc", url: "https://example.invalid/mcp", credential: "SVC_KEY", apiKey: "k", auth: "bearer" }) as ResolvedService;

type Body = { id: number; method: string; params: Record<string, any> };

/** A fake endpoint: records every request and answers each with what `reply` returns. */
function serving(reply: (body: Body, round: number) => unknown, host: McpHost = {}) {
  const seen: Body[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    seen.push(body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: reply(body, seen.length) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { seen, client: new McpClient(service(), fetchImpl, undefined, host) };
}

const FORM = {
  method: "elicitation/create",
  params: {
    mode: "form",
    message: "Which account?",
    requestedSchema: {
      type: "object",
      properties: { account: { type: "string", minLength: 3 }, seats: { type: "integer", minimum: 1, maximum: 10 } },
      required: ["account"],
    },
  },
};
const done = (text: string) => ({ resultType: "complete", content: [{ type: "text", text }] });

describe("a mode is declared only where something can answer it", () => {
  test("no handler, no elicitation capability at all", () => {
    expect(clientCapabilities()).toEqual({ extensions: { "io.modelcontextprotocol/tasks": {} } });
  });

  test("each handler declares its own mode and not the other", () => {
    expect(clientCapabilities({ elicit: { form: () => ({ action: "decline" }) } }).elicitation).toEqual({ form: {} });
    expect(clientCapabilities({ elicit: { url: () => ({ action: "decline" }) } }).elicitation).toEqual({ url: {} });
    expect(
      clientCapabilities({ elicit: { form: () => ({ action: "decline" }), url: () => ({ action: "decline" }) } }).elicitation,
    ).toEqual({ form: {}, url: {} });
  });

  test("what is declared rides on every request the client makes", async () => {
    const { seen, client } = serving(() => ({ resultType: "complete", tools: [] }), {
      elicit: { form: () => ({ action: "cancel" }) },
    });
    await client.listTools();
    expect(seen[0]!.params._meta["io.modelcontextprotocol/clientCapabilities"].elicitation).toEqual({ form: {} });
  });

  test("sampling, roots and logging are never declared: the revision deprecates all three", () => {
    const declared = clientCapabilities({ elicit: { form: () => ({ action: "cancel" }), url: () => ({ action: "cancel" }) }, apps: true });
    expect(declared).not.toHaveProperty("sampling");
    expect(declared).not.toHaveProperty("roots");
    expect(declared).not.toHaveProperty("logging");
  });
});

describe("a form is answered and the call is made again", () => {
  test("the retry carries the answer and the server's state, under a new id", async () => {
    const asked: unknown[] = [];
    const elicit: Elicit = {
      form: (request) => {
        asked.push(request);
        return { action: "accept", content: { account: "acme", seats: 3 } };
      },
    };
    const { seen, client } = serving(
      (_body, round) =>
        round === 1
          ? { resultType: "input_required", inputRequests: { which: FORM }, requestState: "opaque-blob" }
          : done("provisioned"),
      { elicit },
    );

    expect(await client.call("provision", { plan: "team" })).toBe("provisioned");

    // The person was told who is asking, for what, and why.
    expect(asked).toEqual([
      { service: "svc", method: "tools/call", name: "provision", message: "Which account?", schema: FORM.params.requestedSchema },
    ]);
    const [first, retry] = seen;
    expect(retry!.method).toBe("tools/call");
    expect(retry!.id).not.toBe(first!.id);
    expect(retry!.params.name).toBe("provision");
    expect(retry!.params.arguments).toEqual({ plan: "team" });
    // At the top of params, where the schema puts them, and the state exactly as it came.
    expect(retry!.params.inputResponses).toEqual({ which: { action: "accept", content: { account: "acme", seats: 3 } } });
    expect(retry!.params.requestState).toBe("opaque-blob");
    expect(first!.params.requestState).toBeUndefined();
  });

  test("a request with no mode is a form, as servers written before there were two send it", async () => {
    const { seen, client } = serving(
      (_body, round) =>
        round === 1
          ? { resultType: "input_required", inputRequests: { q: { method: "elicitation/create", params: { message: "Name?", requestedSchema: { type: "object", properties: { name: { type: "string" } } } } } } }
          : done("ok"),
      { elicit: { form: () => ({ action: "accept", content: { name: "Ada" } }) } },
    );
    await client.call("greet", {});
    expect(seen[1]!.params.inputResponses.q).toEqual({ action: "accept", content: { name: "Ada" } });
    // No state came, so none is invented.
    expect("requestState" in seen[1]!.params).toBe(false);
  });

  test("a refusal is passed on as a refusal, with nothing else", async () => {
    const { seen, client } = serving(
      (_body, round) => (round === 1 ? { resultType: "input_required", inputRequests: { which: FORM } } : done("skipped")),
      { elicit: { form: () => ({ action: "decline", content: { account: "should not travel" } }) } },
    );
    expect(await client.call("provision", {})).toBe("skipped");
    expect(seen[1]!.params.inputResponses.which).toEqual({ action: "decline" });
  });

  test("an answer that does not fit the form is not sent", async () => {
    const { seen, client } = serving(() => ({ resultType: "input_required", inputRequests: { which: FORM } }), {
      elicit: { form: () => ({ action: "accept", content: { account: "ab", seats: 3 } }) },
    });
    await expect(client.call("provision", {})).rejects.toThrow(/does not fit the form.*"account" is shorter than 3.*Nothing was sent/);
    expect(seen).toHaveLength(1);
  });

  test("state with nothing to ask is a retry, straight away", async () => {
    const { seen, client } = serving(
      (_body, round) => (round === 1 ? { resultType: "input_required", requestState: "resume-here" } : done("resumed")),
      {},
    );
    expect(await client.call("slow", {})).toBe("resumed");
    expect(seen[1]!.params.requestState).toBe("resume-here");
    expect("inputResponses" in seen[1]!.params).toBe(false);
  });

  test("prompts and resources may be answered the same way", async () => {
    const { seen, client } = serving(
      (body, round) =>
        round === 1
          ? { resultType: "input_required", inputRequests: { which: FORM } }
          : body.method === "resources/read"
            ? { resultType: "complete", contents: [{ uri: "doc://a", text: "body" }] }
            : { resultType: "complete", messages: [] },
      { elicit: { form: () => ({ action: "accept", content: { account: "acme" } }) } },
    );
    expect(await client.readResourceText("doc://a")).toBe("body");
    expect(seen[1]!.params.uri).toBe("doc://a");
    expect(seen[1]!.params.inputResponses.which.action).toBe("accept");
  });

  test("a server that never stops asking is given up on", async () => {
    let asked = 0;
    const { client } = serving(() => ({ resultType: "input_required", inputRequests: { which: FORM } }), {
      elicit: {
        form: () => {
          asked += 1;
          return { action: "accept", content: { account: "acme" } };
        },
      },
    });
    await expect(client.call("provision", {})).rejects.toThrow(/asked for more input 9 times running/);
    expect(asked).toBe(8);
  });
});

describe("a URL is consented to, never opened here", () => {
  const URL_REQUEST = { method: "elicitation/create", params: { mode: "url", message: "Connect your account.", url: "https://pay.example.com/connect?x=1" } };

  test("the handler is shown the whole address and its host, and only the decision travels", async () => {
    const shown: unknown[] = [];
    let fetched = 0;
    const { seen, client } = serving(
      (_body, round) => {
        fetched += 1;
        return round === 1 ? { resultType: "input_required", inputRequests: { pay: URL_REQUEST }, requestState: "s" } : done("connected");
      },
      {
        elicit: {
          url: (request) => {
            shown.push(request);
            // A handler that tried to return what was typed there has it dropped.
            return { action: "accept", content: { card: "4111" } } as never;
          },
        },
      },
    );
    expect(await client.call("pay", {})).toBe("connected");
    expect(shown).toEqual([
      { service: "svc", method: "tools/call", name: "pay", message: "Connect your account.", url: "https://pay.example.com/connect?x=1", host: "pay.example.com" },
    ]);
    expect(seen[1]!.params.inputResponses.pay).toEqual({ action: "accept" });
    // Two requests to the MCP server and none to the address: it is never fetched.
    expect(fetched).toBe(2);
  });

  test("an address that is not a web page is shown to nobody", async () => {
    let asked = 0;
    const { client } = serving(
      () => ({ resultType: "input_required", inputRequests: { x: { method: "elicitation/create", params: { mode: "url", message: "Open", url: "file:///etc/passwd" } } } }),
      { elicit: { url: () => ((asked += 1), { action: "accept" }) } },
    );
    await expect(client.call("x", {})).rejects.toThrow(/not a web address; it was not shown to anyone/);
    expect(asked).toBe(0);
  });

  test("a form handler does not answer a URL, and the other way about", async () => {
    const { client } = serving(() => ({ resultType: "input_required", inputRequests: { pay: URL_REQUEST } }), {
      elicit: { form: () => ({ action: "accept", content: {} }) },
    });
    await expect(client.call("pay", {})).rejects.toBeInstanceOf(InputRequired);
  });
});

describe("what cannot be answered is refused whole", () => {
  test("a sampling request is refused, and the form beside it is not put to anyone", async () => {
    let asked = 0;
    const { seen, client } = serving(
      () => ({
        resultType: "input_required",
        inputRequests: { which: FORM, think: { method: "sampling/createMessage", params: { messages: [], maxTokens: 10 } } },
      }),
      { elicit: { form: () => ((asked += 1), { action: "accept", content: { account: "acme" } }) } },
    );
    const failure = await client.call("provision", {}).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(InputRequired);
    expect((failure as Error).message).toContain("think");
    expect((failure as Error).message).toContain("deprecated");
    expect(asked).toBe(0);
    expect(seen).toHaveLength(1);
  });

  test("roots is refused the same way", async () => {
    const { client } = serving(() => ({ resultType: "input_required", inputRequests: { dirs: { method: "roots/list" } } }), {
      elicit: { form: () => ({ action: "cancel" }) },
    });
    await expect(client.call("x", {})).rejects.toBeInstanceOf(InputRequired);
  });
});

describe("a task that asks is answered with tasks/update", () => {
  const task = (over: Record<string, unknown>) => ({
    taskId: "task-1",
    status: "working",
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    ttlMs: 60_000,
    pollIntervalMs: 1,
    ...over,
  });

  test("the answer goes to the task, once, and the task is followed to its end", async () => {
    let gets = 0;
    let asked = 0;
    const { seen, client } = serving(
      (body) => {
        if (body.method === "tools/call") return { ...task({}), resultType: "task" };
        if (body.method === "tasks/get") {
          gets += 1;
          // Still asking on the second look: the server has not caught up with the answer.
          if (gets <= 2) return { ...task({ status: "input_required", inputRequests: { which: FORM } }), resultType: "complete" };
          return { ...task({ status: "completed", result: { content: [{ type: "text", text: "deployed" }] } }), resultType: "complete" };
        }
        return { resultType: "complete" };
      },
      { elicit: { form: () => ((asked += 1), { action: "accept", content: { account: "acme" } }) } },
    );

    expect(await client.call("deploy", {})).toBe("deployed");

    expect(asked).toBe(1);
    const updates = seen.filter((body) => body.method === "tasks/update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.params).toMatchObject({
      taskId: "task-1",
      inputResponses: { which: { action: "accept", content: { account: "acme" } } },
    });
    expect(seen.some((body) => body.method === "tasks/cancel")).toBe(false);
  });
});

describe("an app's handler answers for every client the app makes", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => cleanup(root).catch(() => undefined)));
  });

  test("an agent's tool call that is asked a question is answered by `mcp.elicit` and finishes", async () => {
    const seen: Body[] = [];
    const mcp = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Body;
      seen.push(body);
      const result =
        body.method === "tools/list"
          ? { resultType: "complete", tools: [{ name: "provision", description: "Provision seats.", inputSchema: { type: "object", properties: {} } }] }
          : body.params.inputResponses
            ? done(`provisioned for ${body.params.inputResponses.which.content.account}`)
            : { resultType: "input_required", inputRequests: { which: FORM }, requestState: "s1" };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const model = stubModel([{ text: "", tool: { name: "svc__provision", args: {} } }, { text: "Done." }]);
    const routed = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("https://svc.test/") ? mcp(input, init) : model.fetch(input, init)) as typeof fetch;

    const root = await makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({ name: "desk", ${TEST_ENDPOINT} });`,
      "tools/svc.ts": `import { tool } from "${FRAMEWORK}";
        export default tool({ url: "https://svc.test/mcp" });`,
      "agents/helper.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Help.", tools: ["svc"] });`,
    });
    roots.push(root);
    const asked: string[] = [];
    const app = await App.load({
      root,
      env: { ...MODEL_ENV, SVC_API_KEY: "k" },
      fetch: routed,
      mcp: { elicit: { form: (request) => (asked.push(`${request.service}: ${request.message}`), { action: "accept", content: { account: "acme" } }) } },
    });

    const answer = await app.ask("helper", "provision seats");

    expect(answer.text).toBe("Done.");
    expect(asked).toEqual(["svc: Which account?"]);
    // The mode was declared on the listing too, since a handler for it exists.
    expect(seen[0]!.params._meta["io.modelcontextprotocol/clientCapabilities"].elicitation).toEqual({ form: {} });
    // What the model was handed is the tool's final result, not the interim one.
    expect(JSON.stringify(model.calls[1]!.body.messages)).toContain("provisioned for acme");

    // A direct call, as a workflow step makes one, goes through the same handler.
    expect(await app.callTool("svc.provision", {})).toBe("provisioned for acme");
    expect(asked).toHaveLength(2);
    await app.close();
  });
});

describe("a form's answer is checked against the form", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 5 },
      colour: { type: "string", enum: ["red", "green"] },
      shade: { type: "string", oneOf: [{ const: "#f00", title: "Red" }] },
      picks: { type: "array", minItems: 1, items: { anyOf: [{ const: "a" }, { const: "b" }] } },
      count: { type: "integer", minimum: 0 },
      ratio: { type: "number", maximum: 1 },
      agree: { type: "boolean" },
    },
    required: ["name"],
  };

  test("what fits passes", () => {
    expect(
      elicitedFault(schema, { name: "Ada", colour: "red", shade: "#f00", picks: ["a", "b"], count: 2, ratio: 0.5, agree: true }),
    ).toBeUndefined();
  });

  test.each([
    [{}, '"name" is required'],
    [{ name: "Augusta" }, "longer than 5"],
    [{ name: "Ada", colour: "blue" }, "one of its choices"],
    [{ name: "Ada", shade: "Red" }, "one of its choices"],
    [{ name: "Ada", picks: ["c"] }, 'holds "c"'],
    [{ name: "Ada", picks: [] }, "at least 1"],
    [{ name: "Ada", count: 1.5 }, "whole number"],
    [{ name: "Ada", ratio: 2 }, "above 1"],
    [{ name: "Ada", agree: "yes" }, "true or false"],
    [{ name: "Ada", extra: 1 }, "not a field of the form"],
  ])("%j is refused", (content, why) => {
    expect(elicitedFault(schema, content as Record<string, unknown>)).toContain(why);
  });
});
