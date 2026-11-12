import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { agent, createApp, fn, type App, type Progress } from "../src/index.js";
import { scriptedEndpoint, scriptedModel } from "../src/testing/index.js";
import { cleanup, makeProject } from "./helpers.js";

describe("a scripted model for an app's own tests", () => {
  let root: string | undefined;
  let app: App | undefined;

  afterEach(async () => {
    await app?.close();
    if (root) await cleanup(root);
    app = undefined;
    root = undefined;
  });

  const lookup = fn({
    description: "Look an order up by its id.",
    input: { order: "the order id" },
    run: ({ order }) => `order ${String(order)} shipped on Tuesday`,
  });

  it("answers from its script, with tool calls, and records what it was asked", async () => {
    root = await makeProject({});
    const model = scriptedModel([{ tool: { name: "lookup", args: { order: "9" } } }, "It shipped on Tuesday."]);
    app = await createApp({
      root,
      config: { models: model.models },
      agents: { support: agent({ role: "You answer questions about orders.", tools: ["lookup"] }) },
      functions: { lookup },
    });

    const answer = await app.ask("support", "where is order 9?");

    expect(answer.text).toBe("It shipped on Tuesday.");
    expect(answer.toolCalls).toEqual([{ name: "lookup", args: { order: "9" } }]);
    expect(answer.placeholder).toBeUndefined();
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]!.system).toContain("You answer questions about orders.");
    expect(model.requests[0]!.tools.map((tool) => tool.name)).toContain("lookup");
    expect(model.requests[0]!.last).toBe("where is order 9?");
    expect(model.requests[1]!.last).toBe("order 9 shipped on Tuesday");
    expect(model.remaining).toBe(0);
  });

  it("reports the usage a reply was scripted with, priced where prices were declared", async () => {
    root = await makeProject({});
    const model = scriptedModel([{ text: "hello", usage: { inputTokens: 1_000, outputTokens: 500 } }], {
      prices: { currency: "USD", fast: { input: 1, output: 2 }, balanced: { input: 1, output: 2 }, best: { input: 1, output: 2 } },
    });
    app = await createApp({ root, config: { models: model.models, preference: "quality" }, agents: { a: agent({ role: "You greet." }) } });

    const answer = await app.ask("a", "hi");
    expect(answer.usage.inputTokens).toBe(1_000);
    expect(answer.usage.outputTokens).toBe(500);
    expect(answer.usage.cost).toEqual({ USD: 0.002 });
  });

  it("fails as an endpoint fails, so the ladder is climbed past it", async () => {
    root = await makeProject({});
    const model = scriptedModel([{ fail: 400 }, "from the next rung"]);
    app = await createApp({ root, config: { models: model.models }, agents: { a: agent({ role: "You answer." }) } });

    const answer = await app.ask("a", "hi");
    expect(answer.text).toBe("from the next rung");
    expect(model.requests.map((request) => request.model)).toEqual(["fast", "balanced"]);
    expect(answer.notes?.join("\n")).toContain("failed");
  });

  it("decides a reply from the request, and streams text a word at a time", async () => {
    root = await makeProject({});
    const model = scriptedModel([(request) => `you said: ${request.last}`]);
    app = await createApp({ root, config: { models: model.models, preference: "quality" }, agents: { a: agent({ role: "You echo." }) } });

    const heard: string[] = [];
    const answer = await app.ask("a", "one two", {
      onProgress: (event: Progress) => {
        if (event.kind === "text") heard.push(event.text);
      },
    });
    expect(answer.text).toBe("you said: one two");
    expect(heard.join("")).toBe("you said: one two");
    expect(heard.length).toBeGreaterThan(1);
  });

  it("says so when the script runs out, and answers from a fallback when given one", async () => {
    root = await makeProject({});
    const bare = scriptedModel([]);
    app = await createApp({ root, config: { models: bare.models }, agents: { a: agent({ role: "You answer." }) } });
    await expect(app.ask("a", "hi")).rejects.toThrow(/script had 0 replies/);
    await app.close();

    const steady = scriptedModel([], { fallback: "always this" });
    app = await createApp({ root, config: { models: steady.models, preference: "quality" }, agents: { a: agent({ role: "You answer." }) } });
    expect((await app.ask("a", "hi")).text).toBe("always this");
    expect((await app.ask("a", "again")).text).toBe("always this");
  });

  it("scripts an endpoint's failures and usage on the messages shape", async () => {
    root = await makeProject({});
    const endpoint = scriptedEndpoint([
      { text: "bad request", status: 400 },
      { text: "fine", usage: { input_tokens: 70, output_tokens: 30 } },
    ]);
    app = await createApp(
      {
        root,
        config: { models: { house: { url: "https://models.test", credential: "", speaks: "messages", fast: "small", balanced: "mid" } } },
        agents: { a: agent({ role: "You answer." }) },
      },
      { fetch: endpoint.fetch },
    );
    const answer = await app.ask("a", "hi");
    expect(answer.text).toBe("fine");
    expect(answer.usage.inputTokens).toBe(70);
    expect(endpoint.calls).toHaveLength(2);
  });

  it("is published from the package as @praecise/harness/testing", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, { types: string; default: string }>;
    };
    expect(manifest.exports["./testing"]).toEqual({ types: "./dist/testing/index.d.ts", default: "./dist/testing/index.js" });
  });
});
