/**
 * The client side of everything an MCP server offers that is not a tool.
 *
 * The framework SERVED resources and prompts and could not consume them, which is an
 * odd asymmetry — an agent pointed at a server that publishes a runbook could hold
 * every tool it exposed and none of what it knows.
 *
 * Pagination is the other half, and it was a live bug rather than a missing feature:
 * `tools/list` read the first page and dropped the rest, so an agent talking to a
 * server with more tools than fit in one page silently never learned they existed. A
 * model cannot ask for what it was never shown, so the failure had no symptom.
 *
 * Everything here runs against in-process fakes and one real spawned process. No
 * network.
 */
import { describe, expect, test } from "vitest";

/** A request's own parameters, without the protocol metadata every request carries. */
function without(params: unknown): Record<string, unknown> {
  const { _meta, ...rest } = (params ?? {}) as Record<string, unknown>;
  return rest;
}
import {
  McpClient,
  collectResources,
  collectTools,
  toolName,
} from "../src/harness/mcp.js";
import type { ResolvedService } from "../src/compile/services.js";
import { resolveServices } from "../src/compile/services.js";
import { tool } from "../src/define.js";

const HTTP: ResolvedService = {
  name: "ledger",
  url: "https://mcp.example.com",
  credential: "LEDGER_API_KEY",
  apiKey: "k",
  auth: "bearer",
};

/** An HTTP MCP server whose answers a test writes, and whose requests it can read. */
function serving(
  answer: (method: string, params: Record<string, unknown>) => unknown,
  service: ResolvedService = HTTP,
) {
  const seen: { method: string; params: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    if (body.id === undefined) return new Response("", { status: 202 });
    seen.push({ method: body.method, params: body.params ?? {} });
    const result =
      body.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: {} }
        : answer(body.method, body.params ?? {});
    const payload =
      result instanceof Error
        ? { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: result.message } }
        : { jsonrpc: "2.0", id: body.id, result };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { client: new McpClient(service, fetchImpl), seen, fetchImpl };
}

describe("following a cursor to the end of a list", () => {
  test("every page of tools/list arrives, not just the first", async () => {
    // Three pages of two. Reading only the first would report a third of this server's
    // abilities and look exactly like a server with two tools.
    const pages: Record<string, { tools: { name: string }[]; nextCursor?: string }> = {
      "": { tools: [{ name: "a" }, { name: "b" }], nextCursor: "p2" },
      p2: { tools: [{ name: "c" }, { name: "d" }], nextCursor: "p3" },
      p3: { tools: [{ name: "e" }] },
    };
    const { client, seen } = serving((method, params) =>
      method === "tools/list" ? pages[String(params.cursor ?? "")] : undefined,
    );

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["a", "b", "c", "d", "e"]);
    // The first request must not carry a cursor: an opaque token invented by the client
    // is not a position the server ever issued.
    // Every request carries the per-request protocol metadata now; what matters here is
    // that nothing ELSE was smuggled into a plain list call.
    const listed = seen.find((call) => call.method === "tools/list")?.params as Record<string, unknown>;
    expect(Object.keys(listed).filter((key) => key !== "_meta")).toEqual([]);
  });

  test("resources and prompts are followed the same way", async () => {
    const { client } = serving((method, params) => {
      const first = params.cursor === undefined;
      if (method === "resources/list") {
        return first
          ? { resources: [{ uri: "doc://one" }], nextCursor: "more" }
          : { resources: [{ uri: "doc://two" }] };
      }
      if (method === "prompts/list") {
        return first
          ? { prompts: [{ name: "triage" }], nextCursor: "more" }
          : { prompts: [{ name: "escalate" }] };
      }
      return undefined;
    });

    expect((await client.listResources()).map((r) => r.uri)).toEqual(["doc://one", "doc://two"]);
    expect((await client.listPrompts()).map((p) => p.name)).toEqual(["triage", "escalate"]);
  });

  test("a server that offers a next page forever is stopped, and says so", async () => {
    // A `nextCursor` that is never absent costs its author nothing to write and would
    // spin this loop until the process died. How long a client runs is not a remote
    // party's decision to make.
    let page = 0;
    const { client, seen } = serving((method) =>
      method === "tools/list" ? { tools: [{ name: `t${page}` }], nextCursor: `p${++page}` } : undefined,
    );

    const tools = await client.listTools();
    expect(tools.length).toBe(50);
    expect(seen.filter((call) => call.method === "tools/list").length).toBe(50);
    expect(client.warnings.join(" ")).toMatch(/after 50/);
  });

  test("a server that repeats one cursor is caught before fifty round trips", async () => {
    const { client, seen } = serving((method) =>
      method === "tools/list" ? { tools: [{ name: "same" }], nextCursor: "stuck" } : undefined,
    );

    expect((await client.listTools()).length).toBe(2);
    expect(seen.filter((call) => call.method === "tools/list").length).toBe(2);
    expect(client.warnings.join(" ")).toMatch(/repeated cursor/);
  });

  test("a page that is not a list, or has no items, ends the walk rather than throwing", async () => {
    const { client } = serving((method) => (method === "tools/list" ? {} : undefined));
    expect(await client.listTools()).toEqual([]);
  });
});

describe("reading a resource", () => {
  test("a text resource comes back as its text", async () => {
    const { client, seen } = serving((method, params) =>
      method === "resources/read"
        ? { contents: [{ uri: params.uri, mimeType: "text/markdown", text: "# Runbook\nrestart it" }] }
        : undefined,
    );

    expect(await client.readResourceText("doc://runbook")).toBe("# Runbook\nrestart it");
    expect(seen.at(-1)?.method).toBe("resources/read");
    expect(without(seen.at(-1)?.params)).toEqual({ uri: "doc://runbook" });
  });

  test("several blocks join, in the order the server sent them", async () => {
    const { client } = serving(() => ({
      contents: [
        { uri: "doc://a", text: "first" },
        { uri: "doc://b", text: "second" },
      ],
    }));
    expect(await client.readResourceText("doc://both")).toBe("first\nsecond");
  });

  test("a binary resource is described, not decoded into the prompt", async () => {
    // Base64 in a prompt is a large number of tokens spent on something no model can
    // read. The honest rendering of an image is a line saying an image is there.
    const { client } = serving(() => ({
      contents: [{ uri: "img://logo", mimeType: "image/png", blob: "A".repeat(400) }],
    }));
    const text = await client.readResourceText("img://logo");
    expect(text).toMatch(/image\/png/);
    expect(text).toMatch(/300 bytes/);
    expect(text).not.toContain("AAAA");
  });

  test("the raw blocks are available for a caller that wants the bytes", async () => {
    const { client } = serving(() => ({
      contents: [{ uri: "img://logo", mimeType: "image/png", blob: "QUJD" }],
    }));
    expect(await client.readResource("img://logo")).toEqual([
      { uri: "img://logo", mimeType: "image/png", blob: "QUJD" },
    ]);
  });

  test("a resource that will not read fails loudly rather than reading as empty", async () => {
    const { client } = serving(() => new Error('no resource at "doc://gone"'));
    await expect(client.readResourceText("doc://gone")).rejects.toThrow(/no resource/);
  });
});

describe("getting a prompt", () => {
  test("a prompt comes back as messages, with whose turn it is intact", async () => {
    // A prompt is a conversation the server wrote, not a string. Flattening the roles
    // away would change what several of them mean.
    const { client, seen } = serving((method) =>
      method === "prompts/get"
        ? {
            description: "Triage an incident",
            messages: [
              { role: "user", content: { type: "text", text: "Incident 12 is open." } },
              { role: "assistant", content: { type: "text", text: "What changed?" } },
            ],
          }
        : undefined,
    );

    const got = await client.getPrompt("triage", { id: 12 });
    expect(got.description).toBe("Triage an incident");
    expect(got.messages).toEqual([
      { role: "user", text: "Incident 12 is open." },
      { role: "assistant", text: "What changed?" },
    ]);
    expect(without(seen.at(-1)?.params)).toEqual({ name: "triage", arguments: { id: 12 } });
  });

  test("an embedded resource keeps its text, and content may be a list", async () => {
    const { client } = serving(() => ({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read this:" },
            { type: "resource", resource: { uri: "doc://a", text: "the document" } },
            { type: "resource", resource: { uri: "img://b", mimeType: "image/png" } },
          ],
        },
      ],
    }));
    const got = await client.getPrompt("with-context");
    expect(got.messages[0]?.text).toBe("Read this:\nthe document\n[image/png img://b]");
  });

  test("an unknown role is read as the user's, because a wrong turn is worse than a flat one", async () => {
    const { client } = serving(() => ({ messages: [{ role: "system", content: { type: "text", text: "hi" } }] }));
    expect((await client.getPrompt("odd")).messages).toEqual([{ role: "user", text: "hi" }]);
  });

  test("a prompt missing a required argument fails with the server's words", async () => {
    const { client } = serving(() => new Error('prompt "triage" needs {{id}}'));
    await expect(client.getPrompt("triage", {})).rejects.toThrow(/needs \{\{id\}\}/);
  });
});

describe("argument autocomplete", () => {
  test("suggestions come back with whatever the server said about them", async () => {
    const { client, seen } = serving((method) =>
      method === "completion/complete"
        ? { completion: { values: ["main", "master"], total: 2, hasMore: false } }
        : undefined,
    );

    const done = await client.complete({ type: "ref/prompt", name: "review" }, { name: "branch", value: "ma" });
    expect(done).toEqual({ values: ["main", "master"], total: 2, hasMore: false });
    expect(without(seen.at(-1)?.params)).toEqual({
      ref: { type: "ref/prompt", name: "review" },
      argument: { name: "branch", value: "ma" },
    });
  });

  test("a server that does not implement it has no suggestions, which is not a failure", async () => {
    // Not knowing what to suggest is a normal outcome of asking for suggestions.
    const { client } = serving(() => new Error("unknown method: completion/complete"));
    expect(await client.complete({ type: "ref/resource", uri: "doc://x" }, { name: "q", value: "" })).toEqual({
      values: [],
      total: undefined,
      hasMore: false,
    });
  });
});

describe("attaching resources as knowledge", () => {
  const declared = (resources: string[]): ResolvedService => ({ ...HTTP, resources });

  test("named resources are read and rendered with where they came from", async () => {
    const { client } = serving((method, params) =>
      method === "resources/read" ? { contents: [{ uri: params.uri, text: `body of ${params.uri}` }] } : undefined,
    );
    const service = declared(["doc://one", "doc://two"]);

    const { text, notes } = await collectResources([service], new Map([["ledger", client]]));
    expect(text).toBe("# ledger — doc://one\nbody of doc://one\n\n# ledger — doc://two\nbody of doc://two");
    expect(notes).toEqual([]);
  });

  test('"*" attaches everything the server lists', async () => {
    const { client } = serving((method, params) => {
      if (method === "resources/list") return { resources: [{ uri: "doc://a" }, { uri: "doc://b" }] };
      if (method === "resources/read") return { contents: [{ uri: params.uri, text: `text ${params.uri}` }] };
      return undefined;
    });

    const { text } = await collectResources([declared(["*"])], new Map([["ledger", client]]));
    expect(text).toContain("text doc://a");
    expect(text).toContain("text doc://b");
  });

  test("one resource that will not read is a note, not a dead request", async () => {
    // Losing one document should not cost the agent the whole turn, for the same reason
    // losing one integration does not.
    const { client } = serving((method, params) =>
      method === "resources/read" && params.uri === "doc://gone"
        ? new Error("no such resource")
        : { contents: [{ uri: params.uri, text: "still here" }] },
    );

    const { text, notes } = await collectResources(
      [declared(["doc://gone", "doc://fine"])],
      new Map([["ledger", client]]),
    );
    expect(text).toBe("# ledger — doc://fine\nstill here");
    expect(notes.join(" ")).toMatch(/could not read doc:\/\/gone/);
  });

  test("a service nobody could reach says so instead of quietly attaching nothing", async () => {
    const { notes } = await collectResources([declared(["doc://a"])], new Map());
    expect(notes.join(" ")).toMatch(/was unavailable/);
  });

  test("a warning discovery already reported is not reported again", async () => {
    // The client keeps its warnings for its whole life. Reporting the list it holds,
    // rather than what this call provoked, would make one truncated list look like two.
    let page = 0;
    const { client, fetchImpl } = serving((method) => {
      if (method === "tools/list") return { tools: [{ name: `t${page}` }], nextCursor: `p${++page}` };
      if (method === "resources/list") return { resources: [{ uri: "doc://a" }] };
      return { contents: [{ uri: "doc://a", text: "here" }] };
    });
    void client;

    const service = declared(["*"]);
    const discovery = await collectTools([service], fetchImpl);
    expect(discovery.notes.filter((note) => /after 50/.test(note)).length).toBe(1);

    const { notes } = await collectResources([service], discovery.clients);
    expect(notes).toEqual([]);
  });

  test("a service that declared no resources costs no round trips", async () => {
    const { client, seen } = serving(() => ({ contents: [] }));
    const { text } = await collectResources([HTTP], new Map([["ledger", client]]));
    expect(text).toBe("");
    expect(seen).toEqual([]);
  });

  test("a declared list survives compiling, and an empty one is refused", async () => {
    const env = { LEDGER_API_KEY: "k" };
    const good = resolveServices(
      ["ledger"],
      { ledger: tool({ url: "https://mcp.example.com", resources: ["doc://a", " "] }) },
      env,
    );
    expect(good.services[0]?.resources).toEqual(["doc://a"]);
    expect(good.problems).toEqual([]);

    const bad = resolveServices(
      ["ledger"],
      { ledger: tool({ url: "https://mcp.example.com", resources: ["", "  "] }) },
      env,
    );
    expect(bad.problems.join(" ")).toMatch(/none of them are URIs/);
  });
});

/** A stdio MCP server with two pages of tools, written inline so the test carries it. */
const PAGED_SERVER = `
const pages = {
  "": { tools: [{ name: "one", description: "first" }], nextCursor: "p2" },
  p2: { tools: [{ name: "two", description: "second" }] },
};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let cut;
  while ((cut = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const result =
      msg.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: {} }
        : msg.method === "tools/list"
          ? pages[msg.params?.cursor ?? ""]
          : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  }
});
`;

describe("a launched server, reached through the client", () => {
  test("a stdio service with no credential is contacted rather than skipped", async () => {
    // `resolveServices` does not demand a credential for a launched server — it takes
    // its secrets from the environment it inherits. Skipping every service without an
    // `apiKey` therefore skipped every stdio server, blaming a credential the author
    // was never asked for, and made the whole transport unreachable through this path.
    const service: ResolvedService = {
      name: "local",
      command: [process.execPath, "-e", PAGED_SERVER],
      credential: "LOCAL_API_KEY",
      auth: "bearer",
    };

    const { schemas, clients, notes } = await collectTools([service]);
    try {
      expect(notes).toEqual([]);
      expect(schemas.map((s) => s.name)).toEqual([toolName("local", "one"), toolName("local", "two")]);
    } finally {
      for (const client of clients.values()) client.close();
    }
  });

  test("an HTTP service with no credential is still skipped, because it cannot work", async () => {
    const { notes, clients } = await collectTools([{ ...HTTP, apiKey: undefined }]);
    expect(clients.size).toBe(0);
    expect(notes.join(" ")).toMatch(/LEDGER_API_KEY is not set/);
  });
});
