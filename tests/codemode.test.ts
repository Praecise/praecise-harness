import { describe, expect, it } from "vitest";
import { SiloExecutor, bindingsFor, codeTool, render, tsType, typesFor } from "../src/harness/codemode.js";
import type { ResolvedService } from "../src/compile/services.js";

const svc = (s: Partial<ResolvedService> & { name: string }): ResolvedService =>
  ({ credential: "X_API_KEY", auth: "bearer", ...s }) as ResolvedService;

describe("code mode", () => {
  it("turns schemas into readable types", () => {
    const t = tsType({
      type: "object",
      required: ["q"],
      properties: { q: { type: "string", description: "What to find" }, n: { type: "integer" }, tags: { type: "array", items: { type: "string" } }, mode: { enum: ["a", "b"] }, "odd-key": { type: "boolean" } },
    });
    expect(t).toContain("/** What to find */ q: string");
    expect(t).toContain("n?: number");
    expect(t).toContain("tags?: string[]");
    expect(t).toContain('mode?: "a" | "b"');
    expect(t).toContain('"odd-key"?: boolean');
  });

  it("binds HTTP services, keeps launched programs as tools, and puts keys in headers", () => {
    const { bindings, bound, http, direct } = bindingsFor([
      svc({ name: "crm", url: "https://crm.example/mcp", apiKey: "k1" }),
      svc({ name: "Ledger API", url: "https://ledger.example/mcp", apiKey: "k2", auth: "header", header: "X-Key" }),
      svc({ name: "acme", openapi: "https://acme.example/openapi.json", baseUrl: "https://acme.example/v1", apiKey: "k3" }),
      svc({ name: "inline", openapi: { openapi: "3.1.0" }, baseUrl: "https://x" }),
      svc({ name: "files", command: ["npx", "server-filesystem"] }),
    ]);
    expect(bindings.map((b) => b.name)).toEqual(["crm", "ledger_api", "acme"]);
    expect(bindings[0]!.headers).toEqual({ Authorization: "Bearer k1" });
    expect(bindings[1]!.headers).toEqual({ "X-Key": "k2" });
    expect(bindings[2]).toMatchObject({ kind: "http", url: "https://acme.example/v1", spec: "https://acme.example/openapi.json" });
    expect([...http]).toEqual(["acme"]);
    expect(bound.get("crm")).toBe("crm");
    expect(direct.map((d) => d.name)).toEqual(["inline", "files"]);
  });

  it("declares MCP tools as functions and HTTP APIs as request() with a spec", () => {
    const types = typesFor(
      [
        { name: "crm__find_contact", description: "Find a contact.", parameters: { type: "object", properties: { email: { type: "string" } } } },
        { name: "acme__getThing", description: "op", parameters: { type: "object" } },
        { name: "files__read", description: "not bound", parameters: { type: "object" } },
      ],
      new Map([["crm", "crm"], ["acme", "acme"]]),
      new Set(["acme"]),
    );
    expect(types).toContain("find_contact(args: { email?: string }): Promise<any>;");
    expect(types).toContain("request(args: { method:");
    expect(types).toContain("declare const spec: { acme: any };");
    expect(types).not.toContain("getThing");
    expect(types).not.toContain("files");
    expect(codeTool(types).description).toContain("declare const tools");
  });

  it("creates one silo, runs in it, and starts a fresh one when the old has expired", async () => {
    const calls: string[] = [];
    let created = 0;
    let expired = false;
    const post = async (path: string, body: any) => {
      calls.push(path);
      if (path === "/v1/silo/create") return { status: 200, json: { id: `s${++created}`, bindings: body.bindings } };
      if (path === "/v1/silo/run") {
        if (expired && body.id === "s1") return { status: 404, json: { error: "no silo s1" } };
        return { status: 200, json: { exit: 0, stdout: `ran in ${body.id}\n`, stderr: "" } };
      }
      return { status: 200, json: {} };
    };
    const ex = new SiloExecutor([{ name: "crm", url: "https://crm.example/mcp" }], {}, post);
    expect(await ex.call("run", { code: "return 1" })).toBe("ran in s1");
    expect(await ex.call("run", { code: "return 2" })).toBe("ran in s1");
    expired = true;
    expect(await ex.call("run", { code: "return 3" })).toBe("ran in s2");
    expect(created).toBe(2);
    await expect(ex.call("run", { code: " " })).rejects.toThrow(/code is required/);
  });

  it("tells the model what failed and cuts long output", () => {
    expect(render({ exit: 1, stdout: "", stderr: "TypeError: x" })).toContain("failed (exit 1)");
    expect(render({ exit: 137, timed_out: true, stdout: "", stderr: "" })).toContain("ran out of time");
    const long = render({ exit: 0, stdout: "x".repeat(30_000), stderr: "" });
    expect(long.endsWith("--- TRUNCATED ---")).toBe(true);
  });
});
