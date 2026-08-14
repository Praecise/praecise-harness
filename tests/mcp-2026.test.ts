/**
 * What `2026-07-28` changed, and the specific ways each change fails quietly if it is
 * only half-implemented.
 *
 * The revision made MCP stateless. That reads like a simplification and is mostly the
 * opposite: everything the `initialize` handshake used to establish once now has to be
 * restated on every single request, a server is required to REFUSE a request that omits
 * it rather than assume, and three new error codes distinguish refusals that used to be
 * one opaque 400. Each test here covers something that would otherwise fail as silence.
 */
import { describe, expect, test } from "vitest";

import {
  InputRequired,
  McpClient,
  decodeHeaderValue,
  explain,
  headerParamsOf,
  headerValue,
  mcpHeaders,
  mcpRequest,
  nameFor,
} from "../src/harness/mcp.js";
import type { ResolvedService } from "../src/compile/services.js";

const service = (over: Partial<ResolvedService> = {}): ResolvedService =>
  ({
    name: "svc",
    url: "https://example.invalid/mcp",
    credential: "SVC_KEY",
    apiKey: "k",
    ...over,
  }) as ResolvedService;

/** A fake endpoint that records what it was sent and answers with what it was given. */
function serving(reply: (body: Record<string, unknown>) => unknown) {
  const seen: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    seen.push({ body, headers: init.headers as Record<string, string> });
    const result = reply(body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { seen, client: new McpClient(service(), fetchImpl) };
}

describe("every request states the protocol, because nothing else does", () => {
  test("the three per-request fields ride on every call", async () => {
    const { seen, client } = serving(() => ({ resultType: "complete", tools: [] }));
    await client.listTools();

    const meta = (seen[0]!.body.params as { _meta: Record<string, unknown> })._meta;
    expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    expect(meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({});
    expect(meta["io.modelcontextprotocol/clientInfo"]).toEqual({ name: "praecise", version: "0.1.0" });
  });

  test("no handshake is sent before the first real request", async () => {
    // The specific regression this guards: a client that still calls `initialize` first
    // gets a method-not-found from a modern server and never reaches the request it
    // actually came to make.
    const { seen, client } = serving(() => ({ resultType: "complete", tools: [] }));
    await client.listTools();
    expect(seen.map((call) => call.body.method)).toEqual(["tools/list"]);
  });

  test("no session id is minted, kept, or echoed", async () => {
    const { seen, client } = serving(() => ({ resultType: "complete", tools: [] }));
    await client.listTools();
    await client.listTools();
    for (const call of seen) {
      expect(Object.keys(call.headers).map((h) => h.toLowerCase())).not.toContain("mcp-session-id");
    }
  });
});

describe("headers mirror the body, and a server checks that they do", () => {
  test("the required headers are on every request", () => {
    const headers = mcpHeaders("tools/call", { name: "get_weather", arguments: {} });
    expect(headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(headers["mcp-method"]).toBe("tools/call");
    expect(headers["mcp-name"]).toBe("get_weather");
  });

  test("Mcp-Name is sent only where the body has a name to mirror", () => {
    // Sending it elsewhere is not harmless: the server compares header to body, and a
    // name attached to a request whose body has no such field is a mismatch by
    // construction — a refusal caused entirely by the client being over-helpful.
    expect(mcpHeaders("tools/list", {})["mcp-name"]).toBeUndefined();
    expect(nameFor("resources/read", { uri: "file:///x" })).toBe("file:///x");
    expect(nameFor("prompts/get", { name: "triage" })).toBe("triage");
    expect(nameFor("tools/list", {})).toBeUndefined();
  });

  test("a value a header cannot carry is wrapped rather than mangled", () => {
    // A resource URI with a space or a non-Latin character is ordinary, and putting it
    // raw into a header produces either an invalid header or a splittable one.
    const awkward = "doc://Hello, 世界";
    const encoded = headerValue(awkward);
    expect(encoded.startsWith("=?base64?")).toBe(true);
    expect(decodeHeaderValue(encoded)).toBe(awkward);
  });

  test("a plain value that merely looks like the sentinel is encoded too", () => {
    // Otherwise a server decoding it would produce something the client never sent —
    // and the comparison against the body would fail for a value that was always legal.
    const mimic = "=?base64?literal?=";
    const encoded = headerValue(mimic);
    expect(encoded).not.toBe(mimic);
    expect(decodeHeaderValue(encoded)).toBe(mimic);
  });

  test("ordinary ASCII passes through untouched", () => {
    expect(headerValue("get_weather")).toBe("get_weather");
    expect(decodeHeaderValue("get_weather")).toBe("get_weather");
  });
});

describe("x-mcp-header: tool parameters the server wants in headers", () => {
  const schema = {
    type: "object",
    properties: {
      region: { type: "string", "x-mcp-header": "Region" },
      query: { type: "string" },
    },
  };

  test("an annotated argument is mirrored into its header", () => {
    const headers = mcpHeaders(
      "tools/call",
      { name: "execute_sql", arguments: { region: "us-west1", query: "SELECT 1" } },
      schema,
    );
    expect(headers["mcp-param-region"]).toBe("us-west1");
  });

  test("an argument that was not supplied sends no header at all", () => {
    // The server MUST NOT expect a header for an absent argument, so an empty one is a
    // mismatch rather than a harmless default.
    const headers = mcpHeaders("tools/call", { name: "execute_sql", arguments: { query: "SELECT 1" } }, schema);
    expect(headers["mcp-param-region"]).toBeUndefined();
  });

  test("a tool with an illegal annotation is dropped, not repaired", async () => {
    // The client MUST exclude it. An annotation names what goes into a header an
    // intermediary may route or authorise on; one that cannot be followed exactly must
    // not be followed approximately.
    const { client } = serving(() => ({
      resultType: "complete",
      tools: [
        { name: "fine", description: "", inputSchema: { type: "object", properties: {} } },
        {
          name: "broken",
          description: "",
          inputSchema: {
            type: "object",
            // `number` is excluded by the spec: 42.0 and 42 are one header value and two
            // JSON values, so a server comparing them has no unambiguous rule.
            properties: { size: { type: "number", "x-mcp-header": "Size" } },
          },
        },
      ],
    }));

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["fine"]);
    // Dropped loudly: one bad definition must not silently shrink the surface.
    expect(client.warnings.join(" ")).toContain("broken");
  });

  test("an annotation nested where no client can read a value is rejected", () => {
    // Inside an array, a `oneOf` branch, or behind a `$ref` there is no single
    // well-defined location to read at call time.
    const { faults } = headerParamsOf({
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "object", properties: { id: { type: "string", "x-mcp-header": "Id" } } } },
      },
    });
    expect(faults.length).toBeGreaterThan(0);
  });

  test("the same header claimed twice is a fault, not a last-one-wins", () => {
    const { faults } = headerParamsOf({
      type: "object",
      properties: {
        a: { type: "string", "x-mcp-header": "Tenant" },
        b: { type: "string", "x-mcp-header": "tenant" },
      },
    });
    expect(faults.join(" ")).toContain("more than once");
  });
});

describe("results say what kind of result they are", () => {
  test("an interim result is not read as an answer", async () => {
    // This is the failure the field exists to prevent: `input_required` is close enough
    // in shape to a real result that treating it as final yields an empty answer and no
    // error at all.
    const { client } = serving(() => ({
      resultType: "input_required",
      inputRequests: { github_login: { method: "elicitation/create" } },
    }));

    await expect(client.call("anything", {})).rejects.toBeInstanceOf(InputRequired);
    await expect(client.call("anything", {})).rejects.toThrow("github_login");
  });

  test("an unrecognised result type is refused rather than assumed complete", async () => {
    const { client } = serving(() => ({ resultType: "something_later", tools: [] }));
    await expect(client.listTools()).rejects.toThrow("does not recognise");
  });

  test("a complete result passes through", async () => {
    const { client } = serving(() => ({
      resultType: "complete",
      content: [{ type: "text", text: "done" }],
    }));
    expect(await client.call("t", {})).toBe("done");
  });
});

describe("the three refusals this revision defines are told apart", () => {
  test("an old server is named as an old server", () => {
    const error = explain("svc", "tools/list", {
      code: -32022,
      message: "Unsupported protocol version",
      data: { supported: ["2025-11-25", "2025-06-18"], requested: "2026-07-28" },
    });
    // The remedy is the point: "upgrade the server" rather than "MCP request failed".
    expect(error.message).toContain("2025-11-25");
    expect(error.message).toContain("upgrading");
  });

  test("a capability this client lacks is named as such", () => {
    const error = explain("svc", "tools/call", {
      code: -32021,
      message: "missing capability",
      data: { requiredCapabilities: ["sampling"] },
    });
    expect(error.message).toContain("sampling");
  });

  test("a header disagreement points at the schema that moved", () => {
    const error = explain("svc", "tools/call", { code: -32020, message: "Mcp-Param-Region" });
    expect(error.message).toContain("x-mcp-header");
  });

  test("a refusal carried in a 400 body is read rather than stringified", async () => {
    // A conforming server puts a NAMED refusal in the body of a 400. Reading it is the
    // difference between an actionable message and "MCP request failed (400)".
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2025-11-25"] } },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const client = new McpClient(service(), fetchImpl);
    await expect(client.listTools()).rejects.toThrow("2025-11-25");
  });
});

describe("mcpRequest builds what a server will accept", () => {
  test("it carries the metadata a hand-built request forgets", () => {
    const request = mcpRequest("tools/list") as { params: { _meta: Record<string, unknown> } };
    expect(request.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    expect(request.params._meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({});
  });

  test("caller-supplied _meta survives rather than being overwritten", () => {
    const request = mcpRequest("tools/call", {
      name: "x",
      _meta: { traceparent: "00-abc-def-01" },
    }) as { params: { _meta: Record<string, unknown> } };
    expect(request.params._meta.traceparent).toBe("00-abc-def-01");
    expect(request.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
  });
});
