/**
 * Talking to an MCP server that is a PROGRAM rather than a URL.
 *
 * A large share of published MCP servers are distributed as something you run, not
 * something you call. A client that spoke only HTTP could not reach any of them, and the
 * failure was not degraded service but "no such thing".
 *
 * These spawn a real process and speak real newline-delimited JSON-RPC to it. A mocked
 * transport would prove the code calls itself correctly and nothing about whether it can
 * hold a conversation with another process.
 */
import { describe, expect, test } from "vitest";
import { StdioTransport } from "../src/harness/stdio-transport.js";

/** A minimal MCP-shaped server, written inline so the test carries its own counterpart. */
const SERVER = `
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
    if (msg.method === "slow") { setTimeout(() => {}, 10_000); continue; }
    if (msg.method === "boom") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { message: "it broke" } }) + "\\n");
      continue;
    }
    // Answer out of order on purpose, and interleave a notification.
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message" }) + "\\n");
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echoed: msg.method } }) + "\\n");
    }, msg.method === "first" ? 40 : 5);
  }
});
`;

const spawnServer = (extra = "") =>
  new StdioTransport({ command: process.execPath, args: ["-e", SERVER + extra] });

describe("an MCP server that is a local program", () => {
  test("a request gets its own reply back", async () => {
    const t = spawnServer();
    try {
      await expect(t.request(1, "tools/list")).resolves.toEqual({ echoed: "tools/list" });
    } finally {
      t.close();
    }
  });

  test("replies are matched by id, not by arrival order", async () => {
    // The server answers "first" slowly and "second" quickly, and emits a notification
    // in between. Reading the next line and assuming it belongs to the last request is
    // the bug this shape exists to prevent.
    const t = spawnServer();
    try {
      const first = t.request("a", "first");
      const second = t.request("b", "second");
      await expect(second).resolves.toEqual({ echoed: "second" });
      await expect(first).resolves.toEqual({ echoed: "first" });
    } finally {
      t.close();
    }
  });

  test("a notification addressed to nobody does not resolve a pending request", async () => {
    const t = spawnServer();
    try {
      await expect(t.request(7, "tools/call")).resolves.toEqual({ echoed: "tools/call" });
    } finally {
      t.close();
    }
  });

  test("a JSON-RPC error becomes a rejection carrying the server's words", async () => {
    const t = spawnServer();
    try {
      await expect(t.request(3, "boom")).rejects.toThrow("it broke");
    } finally {
      t.close();
    }
  });

  test("a command that does not exist fails with what was tried, not ENOENT", async () => {
    const t = new StdioTransport({ command: "definitely-not-a-real-program-9f3a" });
    try {
      await expect(t.request(1, "tools/list")).rejects.toThrow(/definitely-not-a-real-program-9f3a/);
    } finally {
      t.close();
    }
  });

  test("a server that dies takes its stderr with it, because that is the explanation", async () => {
    const t = new StdioTransport({
      command: process.execPath,
      args: ["-e", 'process.stderr.write("missing API key\\n"); process.exit(3);'],
    });
    try {
      await expect(t.request(1, "tools/list")).rejects.toThrow(/missing API key/);
    } finally {
      t.close();
    }
  });

  test("closing rejects what was in flight rather than leaving it hanging", async () => {
    const t = spawnServer();
    const pending = t.request(1, "slow");
    t.close();
    await expect(pending).rejects.toThrow(/closed/);
  });
});
