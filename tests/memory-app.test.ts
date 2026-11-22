/**
 * Memory as an app has it: what an agent that remembers is offered and told, what is
 * kept of a request, reading the record back, and what memory is worth on a suite.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AlreadyReflecting, agent, createApp, evaluation, store, type App } from "../src/index.js";
import { scriptedModel, type ScriptedModel } from "../src/testing/index.js";
import { cleanup, makeProject } from "./helpers.js";

describe("an agent that remembers", () => {
  let root: string | undefined;
  let app: App | undefined;

  afterEach(async () => {
    await app?.close();
    if (root) await cleanup(root);
    app = undefined;
    root = undefined;
  });

  async function build(model: ScriptedModel, extra: Record<string, unknown> = {}): Promise<App> {
    root = await makeProject({});
    app = await createApp({
      root,
      config: { models: model.models, preference: "quality" },
      agents: {
        keeper: agent({ role: "You keep notes.", memory: true }),
        plain: agent({ role: "You answer." }),
      },
      ...extra,
    });
    return app;
  }

  const offered = (model: ScriptedModel, at: number): string[] => model.requests[at]!.tools.map((tool) => tool.name);

  it("is told what its memory is for and given the tools to use it; one that does not is given neither", async () => {
    const model = scriptedModel([], { fallback: "Noted." });
    const made = await build(model);

    await made.ask("keeper", "hello");
    await made.ask("plain", "hello");

    expect(model.requests[0]!.system).toContain("You keep a memory across conversations.");
    expect(offered(model, 0)).toEqual(expect.arrayContaining(["search_memory", "read_memory", "write_note"]));
    expect(model.requests[1]!.system).not.toContain("You keep a memory");
    expect(offered(model, 1)).not.toContain("write_note");
  });

  it("keeps a note the agent writes, and the exchange, each as the agent's own", async () => {
    const model = scriptedModel(
      [{ tool: { name: "write_note", args: { subject: "vault", text: "The code is 4417, changed in March." } } }, "Kept."],
      { fallback: "Noted." },
    );
    const made = await build(model);

    await made.ask("keeper", "remember that the vault code is 4417", { thread: "t1" });

    const [note] = await made.jotted("keeper");
    expect(note).toMatchObject({ subject: "vault", origin: "agent", thread: "t1" });
    const [episode] = await made.recorded("keeper");
    expect(episode).toMatchObject({ answer: "Kept.", origin: "agent" });
    // A working note is searched for; it is never placed in front of the model.
    await made.ask("keeper", "something unrelated entirely");
    expect(model.requests.at(-1)!.system).not.toContain("changed in March");
  });

  it("keeps an exchange that read untrusted text as external", async () => {
    const made = await build(scriptedModel([], { fallback: "It says so." }));
    await made.ask("keeper", "what does the page say", { tainted: true });
    expect((await made.recorded("keeper"))[0]!.origin).toBe("external");
  });

  it("lets a person add a note, and finds it through the agent's search", async () => {
    const model = scriptedModel([{ tool: { name: "search_memory", args: { query: "vault code" } } }, "4417."], {
      fallback: "Noted.",
    });
    const made = await build(model);
    const note = await made.jot("keeper", "vault code", "It is 4417.");
    expect(note.origin).toBe("user");

    await made.ask("keeper", "what is the vault code?");
    expect(model.requests[1]!.last).toContain("It is 4417.");
    expect(model.requests[1]!.last).toContain("from a person");
  });

  it("reads the record back: a proposal that waits, pages that are written, and nothing told to the agent", async () => {
    const model = scriptedModel([], { fallback: "Acme is on the annual plan." });
    const made = await build(model);
    await made.ask("keeper", "which plan is Acme on?");
    const [episode] = await made.recorded("keeper");

    model.push(
      { text: { notes: [{ kind: "fact", text: "Acme is on the annual plan.", from: [episode!.id] }], retire: [] } },
      { text: { subjects: [{ slug: "acme", title: "Acme", entries: [episode!.id] }] } },
      { text: { body: `On the annual plan [${episode!.id}].` } },
    );
    const { candidate, filed } = await made.reflect("keeper");

    expect(candidate.notes.map((note) => note.text)).toEqual(["Acme is on the annual plan."]);
    expect(filed.pages.map((page) => page.slug)).toEqual(["acme"]);
    expect((await made.page("keeper", "acme"))?.body).toContain("annual plan");
    expect(await made.learned("keeper")).toEqual([]);
    expect((await made.pending("keeper"))?.notes).toHaveLength(1);

    await made.ask("keeper", "hello again");
    expect(model.requests.at(-1)!.system).not.toContain("What you have learned");

    const done = await made.accept("keeper");
    expect(done.kept).toHaveLength(1);
    await made.ask("keeper", "and again");
    expect(model.requests.at(-1)!.system).toContain("What you have learned across past conversations:\n- Acme is on the annual plan.");
  });

  it("files only what is new the next time, and leaves a waiting proposal when it proposes nothing", async () => {
    const model = scriptedModel([], { fallback: "Acme is on the annual plan." });
    const made = await build(model);
    await made.ask("keeper", "which plan is Acme on?");
    const [episode] = await made.recorded("keeper");
    model.push(
      { text: { notes: [{ kind: "fact", text: "Acme is on the annual plan.", from: [episode!.id] }], retire: [] } },
      { text: { subjects: [{ slug: "acme", title: "Acme", entries: [episode!.id] }] } },
      { text: { body: "On the annual plan." } },
    );
    await made.reflect("keeper");
    const before = model.requests.length;

    model.push({ text: { notes: [], retire: [] } });
    const again = await made.reflect("keeper");

    expect(again.filed).toMatchObject({ read: 0, pages: [] });
    expect(model.requests.length - before).toBe(1);
    expect((await made.pending("keeper"))?.notes).toHaveLength(1);
  });

  it("reads the record back when the time an agent names for it comes, and stops when the app closes", async () => {
    const model = scriptedModel([], { fallback: { text: { notes: [], retire: [], subjects: [] } } });
    root = await makeProject({});
    app = await createApp({
      root,
      config: { models: model.models, preference: "quality" },
      agents: { keeper: agent({ role: "You keep notes.", memory: { reflect: { every: 0.05 } } }) },
    });
    await app.ask("keeper", "hello");

    const seen = await new Promise<string>((resolve) => {
      app!.tend({ onReflect: (name, outcome) => resolve(outcome instanceof Error ? outcome.message : name) });
    });
    expect(seen).toBe("keeper");

    await app.close();
    const after = model.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(model.requests.length).toBe(after);
  });

  it("says at load when the time named for reading back is not a schedule", async () => {
    root = await makeProject({});
    await expect(
      createApp({
        root,
        config: { models: scriptedModel().models },
        agents: { keeper: agent({ role: "You keep notes.", memory: { reflect: { cron: "whenever" } } }) },
      }),
    ).rejects.toThrow(/memory\.reflect is not a schedule/);
  });

  it("says at load when an agent's own tool takes the name of a memory tool", async () => {
    root = await makeProject({});
    app = await createApp({
      root,
      config: { models: scriptedModel().models },
      agents: { keeper: agent({ role: "You keep notes.", memory: true, tools: ["write_note"] }) },
    });
    expect(app.problems.join(" ")).toContain("`write_note` is a tool an agent with memory is given");
  });

  it("keeps all of it in the store an agent names, and nothing of it in files", async () => {
    const model = scriptedModel([], { fallback: "Acme is on the annual plan." });
    root = await makeProject({});
    app = await createApp({
      root,
      config: { models: model.models, preference: "quality", store: "history" },
      stores: { history: store({ of: "document", url: "memory:" }) },
      // Names no store of its own: the app's default is where it remembers.
      agents: { keeper: agent({ role: "You keep notes.", memory: true }) },
    });
    await app.ask("keeper", "which plan is Acme on?");
    await app.jot("keeper", "Acme", "Renewal is in March.");
    const [episode] = await app.recorded("keeper");

    model.push(
      { text: { notes: [{ kind: "fact", text: "Acme is on the annual plan.", from: [episode!.id] }], retire: [] } },
      { text: { subjects: [{ slug: "acme", title: "Acme", entries: [episode!.id] }] } },
      { text: { body: `On the annual plan [${episode!.id}].` } },
    );
    const { filed } = await app.reflect("keeper");
    expect(filed.pages.map((page) => page.slug)).toEqual(["acme"]);
    await app.accept("keeper");

    expect((await app.learned("keeper")).map((note) => note.text)).toEqual(["Acme is on the annual plan."]);
    expect((await app.page("keeper", "acme"))?.revision).toBe(1);
    expect((await app.jotted("keeper")).map((note) => note.subject)).toEqual(["Acme"]);
    await app.ask("keeper", "hello again");
    expect(model.requests.at(-1)!.system).toContain("- Acme is on the annual plan.");
    // Nothing of an agent's memory is on this machine's disk.
    expect(await readdir(join(root, ".praecise", "memory")).catch(() => [])).toEqual([]);

    await app.clearMemory("keeper");
    expect(await app.recorded("keeper")).toEqual([]);
    expect(await app.learned("keeper")).toEqual([]);
    expect(await app.filed("keeper")).toEqual([]);
  });

  it("refuses a second reading of a record while one is going", async () => {
    const model = scriptedModel([], { fallback: { text: { notes: [], retire: [], subjects: [] } } });
    const made = await build(model);
    await made.ask("keeper", "hello");

    const outcomes = await Promise.allSettled([made.reflect("keeper"), made.reflect("keeper")]);
    const refused = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyReflecting);
    // And once it is done, the next one goes ahead.
    await expect(made.reflect("keeper")).resolves.toBeDefined();
  });

  it("says at load when the store an agent remembers into declares a schema of its own", async () => {
    root = await makeProject({});
    const schema = { "~standard": { version: 1 as const, vendor: "test", validate: (value: unknown) => ({ value: value as object }) } };
    await expect(
      createApp({
        root,
        config: { models: scriptedModel().models },
        stores: { history: store({ of: "document", url: "memory:", schema }) },
        agents: { keeper: agent({ role: "You keep notes.", memory: { store: "history" } }) },
      }),
    ).rejects.toThrow(/declares a `schema`/);
  });

  it("refuses to read back the record of an agent that keeps none", async () => {
    const made = await build(scriptedModel([], { fallback: "ok" }));
    await expect(made.reflect("plain")).rejects.toThrow(/keeps no memory/);
  });

  it("removes everything kept for an agent when asked", async () => {
    const made = await build(scriptedModel([], { fallback: "ok" }));
    await made.ask("keeper", "hello");
    await made.jot("keeper", "s", "t");
    await made.clearMemory("keeper");
    expect(await made.recorded("keeper")).toEqual([]);
    expect(await made.jotted("keeper")).toEqual([]);
  });

  it("measures a suite without memory and with it, and leaves the agent's own memory alone", async () => {
    const model = scriptedModel([], { fallback: "The vault code is 4417." });
    const made = await build(model, {
      evals: {
        vault: evaluation({
          agent: "keeper",
          cases: [
            { name: "told", input: "the vault code is 4417, what is the vault code", expect: [{ contains: "4417" }] },
            { name: "asked later", input: "tell me the vault code again", expect: [{ contains: "4417" }] },
          ],
        }),
      },
    });

    const compared = await made.evaluateMemory("vault");

    expect(compared.stateless.passed).toBe(2);
    expect(compared.remembering.passed).toBe(2);
    expect(compared.gain).toBe(0);
    const remembering = model.requests.filter((request) => request.system.includes("You keep a memory"));
    expect(remembering).toHaveLength(2);
    // The second case could use what the first left.
    expect(remembering[1]!.system).toContain("Earlier, asked");
    expect(model.requests.filter((request) => !request.system.includes("You keep a memory"))).toHaveLength(2);
    // Nothing of the run is left, and the agent's own record was never written.
    expect(await made.recorded("keeper")).toEqual([]);
    const left = await readdir(join(root!, ".praecise", "memory")).catch(() => []);
    for (const name of left) expect(await readdir(join(root!, ".praecise", "memory", name))).toEqual([]);
  });
});
