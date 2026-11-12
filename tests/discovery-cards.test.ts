/**
 * The documents a client reads before it connects: the MCP server card, and the one URL
 * that lists the rest. Each is only worth serving if what it names is really there.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { serve, type DevServer } from "../src/server/index.js";
import { PROTOCOL_VERSION } from "../src/server/mcp.js";
import {
  AI_CATALOG_PATH,
  AI_CATALOG_VERSION,
  MCP_SERVER_CARD_PATH,
  aiCatalog,
  jsonLd,
  llmsTxt,
  mcpServerCard,
  robotsTxt,
} from "../src/server/discovery.js";
import { FRAMEWORK, MODEL_ENV, TEST_ENDPOINT, TEST_TOKEN, cleanup, makeProject } from "./helpers.js";

let root: string;
let server: DevServer;
let origin: string;

beforeAll(async () => {
  root = await makeProject({
    "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
      export default defineConfig({ name: "acme", version: "1.2.3", ${TEST_ENDPOINT} });`,
    "agents/support.md": "---\ndescription: Answers a question.\n---\nYou answer questions.",
  });
  const offline: typeof fetch = async () => {
    throw new Error("these tests make no outbound request");
  };
  server = await serve({ root, port: 0, watch: false, env: MODEL_ENV, fetch: offline, token: TEST_TOKEN });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
  await cleanup(root);
});

describe("the MCP server card", () => {
  it("says who the server is and where it listens, and lists no tools or capabilities", () => {
    const card = mcpServerCard(server.app(), "https://acme.example");
    expect(card).toEqual({
      name: "acme",
      title: "acme",
      version: "1.2.3",
      description: "acme, published by Praecise Harness",
      remotes: [{ type: "streamable-http", url: "https://acme.example/mcp" }],
      supportedProtocolVersions: [PROTOCOL_VERSION],
    });
    for (const absent of ["tools", "capabilities", "icons", "repository", "websiteUrl"]) {
      expect(card).not.toHaveProperty(absent);
    }
  });

  it("is served without a credential at the endpoint's URL plus /server-card", async () => {
    expect(MCP_SERVER_CARD_PATH).toBe("/mcp/server-card");
    const res = await fetch(`${origin}${MCP_SERVER_CARD_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const card = (await res.json()) as { remotes: { url: string }[] };
    expect(card.remotes[0]!.url).toBe(`${origin}/mcp`);
  });

  it("can be cached and revalidated", async () => {
    const first = await fetch(`${origin}${MCP_SERVER_CARD_PATH}`);
    expect(first.headers.get("cache-control")).toBe("public, max-age=300");
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[\w-]+"$/);

    const again = await fetch(`${origin}${MCP_SERVER_CARD_PATH}`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(await again.text()).toBe("");

    const stale = await fetch(`${origin}${MCP_SERVER_CARD_PATH}`, { headers: { "if-none-match": '"something-else"' } });
    expect(stale.status).toBe(200);
  });

  it("answers GET only", async () => {
    const res = await fetch(`${origin}${MCP_SERVER_CARD_PATH}`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("is named by llms.txt and left open by robots.txt", () => {
    expect(llmsTxt(server.app(), {}, "https://acme.example")).toContain("(https://acme.example/mcp/server-card)");
    expect(robotsTxt()).toContain("Allow: /mcp/server-card");
  });
});

describe("the AI catalog", () => {
  interface Entry {
    type: string;
    url: string;
    description: string;
  }

  it("is versioned and links each discovery document with a type, a url and a description", () => {
    const catalog = aiCatalog(server.app(), "https://acme.example") as { catalogVersion: string; entries: Entry[] };
    expect(catalog.catalogVersion).toBe(AI_CATALOG_VERSION);
    expect(catalog.entries.map((entry) => [entry.type, entry.url])).toEqual([
      ["mcp-server-card", "https://acme.example/mcp/server-card"],
      ["mcp-server", "https://acme.example/mcp"],
      ["a2a-agent-card", "https://acme.example/.well-known/agent-card.json"],
      ["llms-txt", "https://acme.example/llms.txt"],
      ["json-ld", "https://acme.example/ai.json"],
      ["asyncapi", "https://acme.example/asyncapi.json"],
    ]);
    for (const entry of catalog.entries) expect(entry.description.length).toBeGreaterThan(10);
  });

  it("links only to routes the server answers", async () => {
    const res = await fetch(`${origin}${AI_CATALOG_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeTruthy();
    const { entries } = (await res.json()) as { entries: Entry[] };
    expect(entries).toHaveLength(6);

    for (const entry of entries) {
      expect(entry.url.startsWith(origin)).toBe(true);
      if (entry.type === "mcp-server") {
        // The endpoint takes POST and a credential; reaching that refusal is what shows
        // the route is there, where a dead link would answer 404.
        const refused = await fetch(entry.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(refused.status).toBe(401);
      } else {
        const found = await fetch(entry.url);
        expect(found.status, entry.url).toBe(200);
      }
    }
  });

  it("is advertised by the documents that already list endpoints", () => {
    expect(llmsTxt(server.app(), {}, "https://acme.example")).toContain(`(https://acme.example${AI_CATALOG_PATH})`);
    const { subjectOf } = jsonLd(server.app(), {}, "https://acme.example") as { subjectOf: { url: string }[] };
    expect(subjectOf.map((subject) => subject.url)).toContain(`https://acme.example${AI_CATALOG_PATH}`);
  });
});
