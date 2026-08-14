import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { buildPackage } from "../src/package/build.js";
import { handleMcp, noticesOf, toolsOf, PROTOCOL_VERSION } from "../src/server/mcp.js";
import { mcpRequest } from "../src/harness/mcp.js";
import { serveStdio } from "../src/server/stdio.js";
import { MODEL_ENV, TEST_ENDPOINT, cleanup, FRAMEWORK, makeProject, stubModel } from "./helpers.js";

const roots: string[] = [];

const stub = stubModel(Array.from({ length: 20 }, () => ({ text: "an answer" })));

async function load(files: Record<string, string>) {
  const root = await makeProject({
    "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
      export default defineConfig({ name: "acme", version: "2.1.0", ${TEST_ENDPOINT} });`,
    ...files,
  });
  roots.push(root);
  return App.load({ root, env: MODEL_ENV, fetch: stub.fetch });
}

/** One of each access level, so every test can pick the case it needs. */
const MIXED = {
  "agents/support.ts": `import { agent } from "${FRAMEWORK}";
    export default agent({ role: "Help.", description: "Answers questions.", effect: "read" });`,
  "agents/auditor.ts": `import { agent } from "${FRAMEWORK}";
    export default agent({ role: "Audit.", description: "Reviews the books.", access: "gated" });`,
  "agents/scratch.ts": `import { agent } from "${FRAMEWORK}";
    export default agent({ role: "Think.", description: "Working notes.", access: "internal" });`,
  // `access: "open"` is not decoration: a destructive entry is withheld until its
  // author says out loud that it may be published. See the dedicated test below.
  "functions/purge.ts": `import { fn } from "${FRAMEWORK}";
    export default fn({ description: "Delete everything.", effect: "destructive", access: "open", run: () => "gone" });`,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanup));
});

describe("what an app publishes", () => {
  it("hides internal work from everyone, however trusted", async () => {
    const app = await load(MIXED);
    const names = toolsOf(app, { identified: true }).map((tool) => tool.name);
    expect(names).not.toContain("scratch");
    expect(names).toContain("support");
  });

  it("shows gated work only once the caller is known", async () => {
    const app = await load(MIXED);
    expect(toolsOf(app, {}).map((t) => t.name)).not.toContain("auditor");
    expect(toolsOf(app, { identified: true }).map((t) => t.name)).toContain("auditor");
  });

  it("refuses a hidden tool the same way it refuses one that does not exist", async () => {
    const app = await load(MIXED);
    const call = (name: string) =>
      handleMcp(app, mcpRequest("tools/call", { name }), {});

    const hidden = (await call("scratch")) as { result: { content: { text: string }[] } };
    const absent = (await call("nothing-at-all")) as { result: { content: { text: string }[] } };
    // Identical wording: a refusal must not confirm that the gated thing is there.
    expect(hidden.result.content[0]?.text).toBe(
      absent.result.content[0]?.text.replace("nothing-at-all", "scratch"),
    );
  });

  it("will not run a tool it never advertised", async () => {
    const app = await load(MIXED);
    const reply = (await handleMcp(
      app,
      mcpRequest("tools/call", { name: "auditor", arguments: { input: "hi" } }),
      {},
    )) as { result: { isError: boolean } };
    expect(reply.result.isError).toBe(true);
  });

  it("publishes one group when asked for one group", async () => {
    const app = await load(MIXED);
    const names = toolsOf(app, { identified: true, groups: ["functions"] }).map((t) => t.name);
    expect(names).toEqual(["purge"]);
  });

  it("publishes only what changes nothing when that is all the caller wants", async () => {
    const app = await load(MIXED);
    const names = toolsOf(app, { identified: true, readOnly: true }).map((t) => t.name);
    expect(names).toEqual(["support"]);
  });

  it("will not run a writing tool for a caller that asked to only read", async () => {
    const app = await load(MIXED);
    const reply = (await handleMcp(
      app,
      mcpRequest("tools/call", { name: "purge", arguments: {} }),
      { identified: true, readOnly: true },
    )) as { result: { isError: boolean } };
    expect(reply.result.isError).toBe(true);
  });

  it("says when the surface has grown past what a caller can weigh", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 22 }, (_, index) => [
        `functions/task${index}.ts`,
        `import { fn } from "${FRAMEWORK}";
          export default fn({ description: "Files a report about item ${index}.", run: () => "ok" });`,
      ]),
    );
    const app = await load(many);
    expect(noticesOf(app, { identified: true })).toHaveLength(1);
    expect(noticesOf(app, { identified: true })[0]).toContain("22 tools");
    // Narrowing is the fix, so a narrowed surface says nothing.
    expect(noticesOf(app, { identified: true, readOnly: true })).toEqual([]);
  });

  it("says what calling a tool would do", async () => {
    const app = await load(MIXED);
    const tools = toolsOf(app, { identified: true });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    expect(byName.support).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.purge).toMatchObject({ destructiveHint: true, idempotentHint: false });
    // Undeclared means assume the worst: it writes, and repeating it is safe.
    expect(byName.auditor).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});

describe("discovery, which replaced the handshake", () => {
  it("answers with the revision we implement", async () => {
    const app = await load(MIXED);
    const reply = (await handleMcp(app, mcpRequest("server/discover"))) as {
      result: { protocolVersions: string[]; serverInfo: { version: string } };
    };
    expect(reply.result.protocolVersions).toEqual([PROTOCOL_VERSION]);
    expect(reply.result.serverInfo.version).toBe("2.1.0");
  });

  it("claims no capability it does not honour", async () => {
    const app = await load(MIXED);
    const reply = (await handleMcp(app, mcpRequest("server/discover"))) as {
      result: { capabilities: Record<string, Record<string, unknown>> };
    };
    for (const capability of Object.values(reply.result.capabilities)) {
      expect(capability.listChanged).toBeUndefined();
    }
  });

  it("no longer answers the handshake it used to", async () => {
    // `initialize` is not a method this revision has. Answering it anyway would tell a
    // legacy client it had negotiated a session that does not exist, and every request
    // after it would be served on state nobody is keeping.
    const app = await load(MIXED);
    const reply = (await handleMcp(app, mcpRequest("initialize"))) as { error?: { code: number } };
    expect(reply.error?.code).toBe(-32601);
  });

  it("refuses a request that does not say which protocol it speaks", async () => {
    // The whole of what the handshake used to establish now rides on each request. A
    // request without it cannot be served on an assumption — that is what statelessness
    // costs, and defaulting it would quietly half-understand an older client.
    const app = await load(MIXED);
    const reply = (await handleMcp(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    })) as { error?: { code: number; message: string } };
    expect(reply.error?.code).toBe(-32602);
    expect(reply.error?.message).toContain("protocolVersion");
  });

  it("names what it does speak when asked for a version it does not", async () => {
    const app = await load(MIXED);
    const reply = (await handleMcp(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2025-11-25",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    })) as { error?: { code: number; data?: { supported?: string[] } } };
    expect(reply.error?.code).toBe(-32022);
    expect(reply.error?.data?.supported).toEqual([PROTOCOL_VERSION]);
  });

  it("says what kind of result every result is", async () => {
    // `resultType` is what lets a client tell a finished answer from an interim one
    // asking for input, without inspecting the shape and guessing.
    const app = await load(MIXED);
    const reply = (await handleMcp(app, mcpRequest("tools/list"))) as {
      result: { resultType: string; ttlMs: number; cacheScope: string };
    };
    expect(reply.result.resultType).toBe("complete");
    // A list is cacheable, and privately so: what this publishes depends on the caller.
    expect(typeof reply.result.ttlMs).toBe("number");
    expect(reply.result.cacheScope).toBe("private");
  });

  it("returns tools in a stable order, so a client can cache the list", async () => {
    const app = await load(MIXED);
    const once = (await handleMcp(app, mcpRequest("tools/list"))) as { result: { tools: { name: string }[] } };
    const twice = (await handleMcp(app, mcpRequest("tools/list"))) as { result: { tools: { name: string }[] } };
    const names = once.result.tools.map((t) => t.name);
    expect(twice.result.tools.map((t) => t.name)).toEqual(names);
    expect(names).toEqual([...names].sort());
  });

  it("hands a bad argument back as a tool error the model can fix", async () => {
    const app = await load(MIXED);
    const reply = (await handleMcp(app, mcpRequest("tools/call", {}))) as {
      result?: { isError: boolean };
      error?: unknown;
    };
    expect(reply.error).toBeUndefined();
    expect(reply.result?.isError).toBe(true);
  });
});

describe("serving on a pipe", () => {
  it("answers a request written to stdin", async () => {
    const app = await load(MIXED);
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) => lines.push(chunk.toString()));

    const server = serveStdio({ app, input, output });
    input.write(`${JSON.stringify(mcpRequest("tools/list", {}, 7))}\n`);
    input.end();
    await server.done;

    const reply = JSON.parse(lines.join("")) as { id: number; result: { tools: unknown[] } };
    expect(reply.id).toBe(7);
    expect(reply.result.tools.length).toBeGreaterThan(0);
  });

  it("survives a line that is not JSON instead of dying on it", async () => {
    const app = await load(MIXED);
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) => lines.push(chunk.toString()));

    const server = serveStdio({ app, input, output });
    input.write("this is not json\n");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
    input.end();
    await server.done;

    expect(JSON.parse(lines.join("")).id).toBe(2);
  });

  it("writes nothing at all for a notification", async () => {
    const app = await load(MIXED);
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) => lines.push(chunk.toString()));

    const server = serveStdio({ app, input, output });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.end();
    await server.done;

    expect(lines.join("")).toBe("");
  });
});

describe("packaging", () => {
  it("writes something a stranger can install and run", async () => {
    const app = await load(MIXED);
    const out = join(app.root, "out");
    const result = await buildPackage({ app, out });

    expect(result.files).toContain("package.json");
    const pkg = JSON.parse(await readFile(join(out, "package.json"), "utf8")) as {
      name: string;
      version: string;
      bin: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(pkg.version).toBe("2.1.0");
    expect(pkg.bin.acme).toBe("./start.js");
    expect(pkg.dependencies.praecise).toBeTruthy();

    // The author's own files travel with it: the folder is the app.
    expect(await readFile(join(out, "agents/support.ts"), "utf8")).toContain("agent(");
  });

  it("writes a typed module beside the tool list", async () => {
    const app = await load(MIXED);
    const out = join(app.root, "out");
    await buildPackage({ app, out });

    const types = await readFile(join(out, "api.d.ts"), "utf8");
    expect(types).toContain(`"support"(args:`);
    expect(types).toContain("Promise<string>");
    // The two projections agree: internal work is missing from both.
    expect(types).not.toContain("scratch");

    const module = await readFile(join(out, "api.js"), "utf8");
    expect(module).toContain("callPublished");

    const pkg = JSON.parse(await readFile(join(out, "package.json"), "utf8")) as {
      types: string;
      files: string[];
    };
    expect(pkg.types).toBe("./api.d.ts");
    expect(pkg.files).toContain("api.js");
  });

  it("packages the local shape open and the hosted shape closed", async () => {
    const app = await load(MIXED);
    const local = await buildPackage({ app, out: join(app.root, "local") });
    const hosted = await buildPackage({ app, out: join(app.root, "hosted"), shape: "hosted" });

    const names = (files: typeof local) => files.manifest.tools.map((tool) => tool.name);
    expect(names(local)).toContain("auditor");
    // Nobody has proved anything to a hosted server yet, so gated work stays in.
    expect(names(hosted)).not.toContain("auditor");
    expect(names(hosted)).toContain("support");
  });

  it("never packages internal work, in either shape", async () => {
    const app = await load(MIXED);
    const result = await buildPackage({ app, out: join(app.root, "out") });
    const written = await readFile(join(result.out, "mcp.json"), "utf8");
    expect(result.manifest.tools.map((t) => t.name)).not.toContain("scratch");
    expect(JSON.parse(written).protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("keeps its own name wherever it is unpacked", async () => {
    const app = await load(MIXED);
    const result = await buildPackage({ app, out: join(app.root, "somewhere-else") });
    // The launcher must carry the identity: the install directory is the
    // installer's business and says nothing about what the app is called.
    const start = await readFile(join(result.out, "start.js"), "utf8");
    expect(start).toContain(`name: "acme"`);
    expect(start).toContain(`version: "2.1.0"`);

    const reloaded = await App.load({
      root: app.root,
      env: MODEL_ENV,
      fetch: stub.fetch,
      name: "acme",
      version: "2.1.0",
    });
    expect(reloaded.name).toBe("acme");
    expect(reloaded.version).toBe("2.1.0");
  });

  it("refuses to hand over something a stranger could not read", async () => {
    const app = await load({
      "functions/doit.ts": `import { fn } from "${FRAMEWORK}";
        export default fn({ run: () => "done" })`,
    });
    // The generated fallback is not a description: it says the name back.
    await expect(buildPackage({ app, out: join(app.root, "out") })).rejects.toThrow(
      /doit: `description` only says "doit" back/,
    );
  });

  it("refuses a description written to the agent rather than about it", async () => {
    const app = await load({
      "agents/helper.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "You are a helpful assistant for Acme." });`,
    });
    await expect(buildPackage({ app, out: join(app.root, "out") })).rejects.toThrow(
      /addressed to the agent/,
    );
  });

  it("lets an undescribed thing through once it is marked internal", async () => {
    const app = await load({
      "agents/good.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Answers billing questions." });`,
      "functions/doit.ts": `import { fn } from "${FRAMEWORK}";
        export default fn({ access: "internal", run: () => "done" })`,
    });
    const result = await buildPackage({ app, out: join(app.root, "out") });
    expect(result.manifest.tools.map((t) => t.name)).toEqual(["good"]);
  });

  it("packages a JavaScript app's guard, which the .ts-only copy list dropped", async () => {
    // The defect: `CARRIED` said "guard.ts", the copy failure was swallowed, and
    // an app written in .js shipped with no guard and no warning — a security
    // control that disappeared in transit.
    const app = await load({
      "agents/support.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Answers questions about orders." });`,
      "guard.js": `export default ({ tool }) => (tool === "purge" ? "Not allowed." : undefined);`,
      "middleware.js": `export default (call, next) => next();`,
    });

    const result = await buildPackage({ app, out: join(app.root, "out") });
    expect(await readFile(join(result.out, "guard.js"), "utf8")).toContain("Not allowed.");

    const pkg = JSON.parse(await readFile(join(result.out, "package.json"), "utf8")) as {
      files: string[];
    };
    expect(pkg.files).toContain("guard.js");
    expect(pkg.files).toContain("middleware.js");
  });

  it("refuses to publish an app whose guard could not travel with it", async () => {
    const app = await load({
      "agents/support.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Answers questions about orders." });`,
      "guard.ts": `export default () => undefined;`,
    });

    // Same app, packaged from a root with no guard file beside it: the package
    // would run more permissively than the app it claims to be.
    const moved = await App.from({ ...app.project, root: app.root }, {
      root: join(app.root, "elsewhere"),
      env: MODEL_ENV,
      fetch: stub.fetch,
      name: "acme",
    });
    await expect(buildPackage({ app: moved, out: join(app.root, "out") })).rejects.toThrow(
      /this app has a guard, and there is no guard\.ts/,
    );
    await moved.close();
  });

  it("gives npm a name npm will take, and keeps the one a person chose", async () => {
    // The defect: `name: "Acme Support"` emitted `"name": "Acme Support"` and
    // `bin: { "Acme Support": … }` — a package npm rejects and npx cannot find.
    const root = await makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({ name: "Acme Support", version: "1.0.0", ${TEST_ENDPOINT} });`,
      "agents/support.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Answers questions about orders." });`,
    });
    roots.push(root);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    const result = await buildPackage({ app, out: join(root, "out") });
    const pkg = JSON.parse(await readFile(join(result.out, "package.json"), "utf8")) as {
      name: string;
      bin: Record<string, string>;
    };

    expect(pkg.name).toBe("acme-support");
    expect(pkg.bin["acme-support"]).toBe("./start.js");
    // The human name survives everywhere a person reads it.
    expect(result.manifest.name).toBe("Acme Support");
    expect(await readFile(join(result.out, "README.md"), "utf8")).toContain("# Acme Support");
    expect(await readFile(join(result.out, "README.md"), "utf8")).toContain("npx acme-support");
    expect(await readFile(join(result.out, "start.js"), "utf8")).toContain(`name: "Acme Support"`);
  });

  it("refuses a name with no npm package name in it at all", async () => {
    const root = await makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({ name: "!!!", ${TEST_ENDPOINT} });`,
      "agents/support.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Answers questions about orders." });`,
    });
    roots.push(root);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    await expect(buildPackage({ app, out: join(root, "out") })).rejects.toThrow(
      /there is no npm package name in it/,
    );
  });

  it("says so plainly when an app publishes nothing", async () => {
    const app = await load({
      "agents/secret.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Hidden.", access: "internal" });`,
    });
    const result = await buildPackage({ app, out: join(app.root, "out") });
    expect(result.manifest.tools).toEqual([]);
    expect(await readFile(join(result.out, "README.md"), "utf8")).toContain("marked internal");
  });
});
