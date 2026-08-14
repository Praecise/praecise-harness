/**
 * The SDK door: an app as a value, rather than a folder somebody scans.
 *
 * The claim under test is not "you can build an app in code" — that is easy and would be
 * easy to get wrong in the way that matters. It is that the two doors open onto the same
 * room: an app that the folder loader rejects is rejected here, in the same words, and an
 * app that runs one way runs the other. Two front doors with two standards is a framework
 * where a bug report cannot be reproduced, so most of this file is about agreement rather
 * than about features.
 */
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { agent, fn, guard, store, workflow } from "../src/define.js";
import { createApp, defineApp, mergeApps } from "../src/sdk.js";
import { handleMcp, toolsOf } from "../src/server/mcp.js";
import { mcpRequest } from "../src/harness/mcp.js";
import { agentCard } from "../src/server/a2a.js";
import { MODEL_ENV, TEST_ENDPOINT, cleanup, FRAMEWORK, makeProject, stubModel } from "./helpers.js";

const roots: string[] = [];
const stub = stubModel(Array.from({ length: 40 }, () => ({ text: "an answer" })));

afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanup));
});

const CONFIG = {
  models: {
    house: {
      url: "https://models.test",
      credential: "HOUSE_KEY",
      speaks: "messages" as const,
      fast: "small",
      balanced: "mid",
      best: "large",
    },
  },
};

const SUPPORT = agent({ role: "Help.", description: "Answers questions.", effect: "read" });

describe("an app described in code", () => {
  it("runs without a directory ever being read", async () => {
    const app = await createApp(
      {
        name: "acme",
        version: "2.1.0",
        config: CONFIG,
        agents: { support: SUPPORT },
      },
      { env: MODEL_ENV, fetch: stub.fetch },
    );

    expect(app.name).toBe("acme");
    expect(app.version).toBe("2.1.0");
    expect(app.agentNames).toEqual(["support"]);
    expect((await app.ask("support", "hello")).text).toBeTruthy();
  });

  it("names things by their key, exactly as a filename would", async () => {
    // `agents/support.ts` is the agent `support`; `{ agents: { support } }` is the same
    // agent by the same name. One rule, two spellings.
    const app = await createApp(
      {
        config: CONFIG,
        agents: { triage: SUPPORT },
        functions: {
          lookup: fn({ description: "Look up an order.", input: { id: "order id" }, effect: "read", run: ({ id }) => ({ id }) }),
        },
      },
      { env: MODEL_ENV, fetch: stub.fetch },
    );
    expect(app.agentNames).toEqual(["triage"]);
    expect(await app.callTool("lookup", { id: "x" })).toEqual({ id: "x" });
  });

  it("carries a guard, which is the thing an app most needs to keep", async () => {
    // A guard in this framework is the boundary for what an agent may REACH: it sees the
    // attempted tool call, not the answer, and returns the reason to refuse. Wiring one
    // through the SDK door has to gate the same calls it gates through the folder door.
    const app = await createApp(
      {
        config: CONFIG,
        agents: { support: agent({ role: "Help.", description: "d", tools: ["purge"] }) },
        functions: {
          purge: fn({
            description: "Delete everything.",
            input: { confirm: "yes to proceed" },
            effect: "write",
            run: () => ({ purged: true }),
          }),
        },
        guard: guard((attempt) =>
          attempt.effect === "write" ? `"${attempt.tool}" writes, and this app is read-only today` : undefined,
        ),
      },
      { env: MODEL_ENV, fetch: stub.fetch },
    );

    const refused = await app.callTool("purge", { confirm: "yes" }).catch((err: Error) => err);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain("read-only today");
  });
});

describe("both doors judge an app the same way", () => {
  /** The same broken app, expressed each way. */
  const BROKEN = {
    agents: {
      // No `role` — a fault the folder loader reports, so this one must too.
      support: { kind: "agent", description: "Answers questions." } as never,
    },
  };

  it("rejects in code what it rejects on disk", async () => {
    const inCode = defineApp({ config: CONFIG, ...BROKEN });

    const root = await makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({ ${TEST_ENDPOINT} });`,
      "agents/support.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ description: "Answers questions." });`,
    });
    roots.push(root);
    const onDisk = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    // Same complaint, same words. If these ever diverge, one door is lying about the
    // other's standard.
    //
    // This test is also what found the crash it now guards: `App.load` used to throw a
    // raw TypeError here, destroying the very report that said what was wrong.
    expect(inCode.faults?.join(" ")).toContain('agent "support": `role` is required');
    expect(onDisk.problems.join(" ")).toContain('agent "support": `role` is required');
  });

  it("catches memory pointing at a store that does not exist", async () => {
    const project = defineApp({
      config: CONFIG,
      agents: { support: agent({ role: "Help.", description: "d", memory: { store: "nowhere" } }) },
    });
    expect(project.faults?.join(" ")).toContain("unknown store");
  });

  it("catches a store that cannot be built as declared", async () => {
    const project = defineApp({
      config: CONFIG,
      // A vector store with no dimensions is not a store, whichever door it came through.
      stores: { vectors: store({ of: "vector" }) },
    });
    expect(project.faults?.join(" ")).toContain("dimensions");
  });

  it("catches a workflow whose steps refer to nothing", async () => {
    const project = defineApp({
      config: CONFIG,
      agents: { support: SUPPORT },
      workflows: {
        handle: workflow({
          input: { case: "what happened" },
          steps: [{ id: "read", ask: "Read {{case}}", agent: "nobody" }],
        }),
      },
    });
    expect(project.faults?.length).toBeGreaterThan(0);
  });

  it("refuses to start a faulted app rather than serving a broken one", async () => {
    // The folder loader KEEPS a faulted project so `check` can list every problem at
    // once. Starting one in code is a different moment: the caller is about to serve
    // requests with it.
    await expect(createApp({ config: CONFIG, ...BROKEN }, { env: MODEL_ENV })).rejects.toThrow(
      /cannot run as written/,
    );
  });

  it("publishes the same surface over MCP as a folder app would", async () => {
    const app = await createApp(
      {
        name: "acme",
        config: CONFIG,
        agents: { support: SUPPORT },
        functions: { lookup: fn({ description: "Look up an order.", input: { id: "order id" }, effect: "read", run: ({ id }) => ({ id }) }) },
      },
      { env: MODEL_ENV, fetch: stub.fetch },
    );

    const listed = (await handleMcp(app, mcpRequest("tools/list"))) as {
      result: { tools: { name: string }[]; resultType: string };
    };
    expect(listed.result.resultType).toBe("complete");
    expect(listed.result.tools.map((t) => t.name).sort()).toEqual(["lookup", "support"]);
    // And over A2A, from the same app object.
    expect((agentCard(app).skills as { id: string }[]).map((s) => s.id).sort()).toEqual(["lookup", "support"]);
  });
});

describe("an app assembled from parts that do not know each other", () => {
  /** What a library would export: a piece of an app, not an app. */
  const LIBRARY = {
    agents: { auditor: agent({ role: "Audit.", description: "Audits things.", effect: "read" }) },
    functions: {
      measure: fn({ description: "Measure something.", input: { x: "a number" }, effect: "read", run: ({ x }) => ({ x }) }),
    },
  };

  it("merges a library's pieces with an application's own", async () => {
    const merged = mergeApps(LIBRARY, { name: "acme", config: CONFIG, agents: { support: SUPPORT } });
    const app = await createApp(merged, { env: MODEL_ENV, fetch: stub.fetch });

    expect(app.agentNames.sort()).toEqual(["auditor", "support"]);
    expect(toolsOf(app).map((t) => t.name).sort()).toEqual(["auditor", "measure", "support"]);
    expect(merged.collisions).toEqual([]);
  });

  it("lets the application win, because merge order is a statement of precedence", async () => {
    const overridden = mergeApps(LIBRARY, {
      config: CONFIG,
      agents: { auditor: agent({ role: "Audit differently.", description: "Ours.", effect: "read" }) },
    });
    const app = await createApp(overridden, { env: MODEL_ENV, fetch: stub.fetch });
    const listed = toolsOf(app).find((tool) => tool.name === "auditor");
    expect(listed?.description).toBe("Ours.");
  });

  it("reports a collision rather than letting one silently disappear", () => {
    // Two packages that both export `auditor` produce an app where one is simply gone.
    // Nobody notices until the wrong one answers.
    const merged = mergeApps(LIBRARY, LIBRARY);
    expect(merged.collisions.join(" ")).toContain('agent "auditor"');
    expect(merged.collisions.join(" ")).toContain('function "measure"');
  });

  it("will not quietly run one of two guards", () => {
    // Two guards is not a guard. Running only the last one silently is the worst
    // outcome available, so the merge says so.
    const merged = mergeApps(
      { guard: guard(() => undefined) },
      { guard: guard(() => "refused") },
    );
    expect(merged.collisions.join(" ")).toContain("more than one guard");
  });

  it("accumulates knowledge instead of replacing it", () => {
    const merged = mergeApps(
      { knowledge: [{ name: "policy", content: "one" }] },
      { knowledge: [{ name: "tone", content: "two" }] },
    );
    expect(merged.knowledge?.map((doc) => doc.name)).toEqual(["policy", "tone"]);
  });

  it("layers config rather than overwriting the whole of it", () => {
    const merged = mergeApps({ config: CONFIG }, { config: { preference: "quality" } });
    expect(merged.config?.models?.house).toBeDefined();
    expect(merged.config?.preference).toBe("quality");
  });
});
