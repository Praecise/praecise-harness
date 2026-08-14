/**
 * A tool that declares an output schema answers TWICE — once as prose for a reader, once
 * as data in `structuredContent`. Reading only the prose throws the typed copy away and
 * hands the model a rendering of a value instead of the value.
 *
 * The spec requires a server sending `structuredContent` to send `content` as well, for
 * clients that predate it. So the prose is not a fallback worth preferring; it is the
 * duplicate.
 */
import { describe, expect, test } from "vitest";
import { McpClient } from "../src/harness/mcp.js";

/** An HTTP MCP server that answers whatever the test hands it. */
function serving(result: unknown) {
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id?: number; method: string };
    if (body.method === "initialize") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (body.id === undefined) return new Response("", { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const service = { name: "ledger", url: "https://mcp.example.com", credential: "K", apiKey: "k", auth: "bearer" as const };
  return new McpClient(service, fetchImpl);
}

describe("typed tool results", () => {
  test("the structured copy is what reaches the model, not the prose rendering", async () => {
    const client = serving({
      content: [{ type: "text", text: "Invoice 41 total: one thousand two hundred and thirty dollars" }],
      structuredContent: { invoice: 41, total: 1230, currency: "USD" },
    });
    const out = await client.call("get_invoice", {});
    expect(JSON.parse(out)).toEqual({ invoice: 41, total: 1230, currency: "USD" });
  });

  test("prose still answers when a server sends no structured copy", async () => {
    const client = serving({ content: [{ type: "text", text: "done" }] });
    expect(await client.call("ship", {})).toBe("done");
  });

  test("a structured falsy value is data, not an absent one", async () => {
    // `0`, `false` and `null` are answers. Testing presence rather than truthiness is
    // the difference between reporting a balance of zero and reporting nothing.
    const client = serving({ content: [{ type: "text", text: "zero" }], structuredContent: 0 });
    expect(await client.call("balance", {})).toBe("0");

    const empty = serving({ content: [{ type: "text", text: "none" }], structuredContent: [] });
    expect(await empty.call("list", {})).toBe("[]");
  });

  test("an error is still an error, however it was expressed", async () => {
    const client = serving({ content: [{ type: "text", text: "no such invoice" }], isError: true });
    await expect(client.call("get_invoice", {})).rejects.toThrow("no such invoice");
  });
});
