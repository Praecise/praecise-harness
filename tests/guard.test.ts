/**
 * Saying no to a tool call in a way the model can do something with.
 *
 * The refusal goes back as that tool's own result, so the agent reads it the
 * way it reads any other answer and can say it out loud, ask for something
 * smaller, or stop. That is the whole reason it is a returned sentence rather
 * than a thrown error: an exception ends the run somewhere nobody chose, and
 * the customer waiting on the other end is told nothing at all.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { MODEL_ENV, TEST_ENDPOINT, cleanup, FRAMEWORK, makeProject, stubModel } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(cleanup)));

const BASE = {
  "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
    export default defineConfig({ name: "acme", quality: "fast", ${TEST_ENDPOINT} });`,
  "agents/support.ts": `import { agent } from "${FRAMEWORK}";
    export default agent({
      role: "Support for Acme.",
      description: "Answers customer questions.",
      tools: ["refund", "lookup", "broken"],
    });`,
  "functions/refund.ts": `import { fn } from "${FRAMEWORK}";
    export default fn({
      description: "Refund an order.",
      input: { order: "the order id", amount: "how much, in whole units" },
      effect: "write",
      run: ({ order }) => ({ refunded: order }),
    });`,
  "functions/lookup.ts": `import { fn } from "${FRAMEWORK}";
    export default fn({
      description: "Look up an order.",
      input: { order: "the order id" },
      effect: "read",
      run: ({ order }) => ({ order, status: "delivered" }),
    });`,
  "functions/broken.ts": `import { fn } from "${FRAMEWORK}";
    export default fn({
      description: "Whatever this was meant to do, it does not.",
      input: { order: "the order id" },
      run: () => { throw new Error("no such order"); },
    });`,
};

/** What the router wrote down about the last request this agent handled. */
async function lastDecision(root: string): Promise<{ after?: { toolErrors: number } }> {
  const lines = await readFile(join(root, ".praecise", "routing", "support.jsonl"), "utf8");
  return JSON.parse(lines.trim().split("\n").at(-1)!) as { after?: { toolErrors: number } };
}

/** A project with the given `guard.ts` body, and the two functions above. */
async function projectGuarded(body: string): Promise<string> {
  const root = await makeProject({
    ...BASE,
    "guard.ts": `import { guard } from "${FRAMEWORK}";\nexport default guard(${body});`,
  });
  roots.push(root);
  return root;
}

interface Block {
  type?: string;
  content?: string;
}

/** What went back to the model as tool results on this request, in order. */
function results(body: Record<string, unknown> | undefined): string[] {
  const messages = ((body ?? {}).messages ?? []) as { content?: Block[] | string }[];
  const out: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_result") out.push(block.content ?? "");
    }
  }
  return out;
}

/** All of them run together, for a test that only cares that something is there. */
const said = (body: Record<string, unknown> | undefined): string => results(body).join("\n");

describe("a guard on the way to a tool", () => {
  it("lets a call through when it says nothing", async () => {
    const root = await projectGuarded(`() => undefined`);
    const stub = stubModel([
      { text: "", tool: { name: "refund", args: { order: "A-1", amount: "20" } } },
      { text: "Refunded." },
    ]);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    const answer = await app.ask("support", "refund order A-1");

    expect(answer.text).toBe("Refunded.");
    expect(said(stub.calls[1]?.body)).toContain("A-1");
    await app.close();
  });

  it("hands its sentence back as the tool's own result", async () => {
    const root = await projectGuarded(
      `({ tool }) => tool === "refund" ? "A refund over ten needs a person to approve it." : undefined`,
    );
    const stub = stubModel([
      { text: "", tool: { name: "refund", args: { order: "A-1", amount: "20" } } },
      { text: "I can't do that myself — someone will need to approve it." },
    ]);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    const answer = await app.ask("support", "refund order A-1");

    const back = said(stub.calls[1]?.body);
    expect(back).toContain("needs a person to approve it");
    // The function never ran, so nothing it would have said is in there.
    expect(back).not.toContain("refunded");
    expect(answer.text).toContain("approve");
    await app.close();
  });

  it("still records that the model asked", async () => {
    const root = await projectGuarded(`() => "no"`);
    const stub = stubModel([
      { text: "", tool: { name: "refund", args: { order: "A-1", amount: "20" } } },
      { text: "Sorry." },
    ]);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    const answer = await app.ask("support", "refund order A-1");

    expect(answer.toolCalls).toMatchObject([{ name: "refund" }]);
    await app.close();
  });

  it("refuses one call and allows the next in the same turn", async () => {
    const root = await projectGuarded(
      `({ effect }) => effect === "write" ? "Only reads, for now." : undefined`,
    );
    const stub = stubModel([
      { text: "", tool: { name: "refund", args: { order: "A-1", amount: "20" } } },
      { text: "", tool: { name: "lookup", args: { order: "A-1" } } },
      { text: "It was delivered, so I can't refund it." },
    ]);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    await app.ask("support", "refund order A-1");

    expect(said(stub.calls[1]?.body)).toContain("Only reads");
    expect(said(stub.calls[2]?.body)).toContain("delivered");
    await app.close();
  });

  it("sees what the agent, the tool and the arguments actually were", async () => {
    const root = await projectGuarded(
      `({ agent, tool, origin, effect, args }) =>
        JSON.stringify({ agent, tool, origin, effect, order: args.order })`,
    );
    const stub = stubModel([
      { text: "", tool: { name: "refund", args: { order: "A-1", amount: "20" } } },
      { text: "Sorry." },
    ]);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    await app.ask("support", "refund order A-1");

    expect(JSON.parse(results(stub.calls[1]?.body)[0] ?? "{}")).toEqual({
      agent: "support",
      tool: "refund",
      origin: "local",
      effect: "write",
      order: "A-1",
    });
    await app.close();
  });

  it("treats a guard that throws as a refusal rather than the end of the run", async () => {
    const root = await projectGuarded(`() => { throw new Error("the ledger is down"); }`);
    const stub = stubModel([
      { text: "", tool: { name: "refund", args: { order: "A-1", amount: "20" } } },
      { text: "I can't check that right now." },
    ]);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    const answer = await app.ask("support", "refund order A-1");

    expect(said(stub.calls[1]?.body)).toContain("the ledger is down");
    expect(answer.text).toContain("can't check");
    await app.close();
  });

  it("does nothing when a guard answers with blank space", async () => {
    const root = await projectGuarded(`() => "   "`);
    const stub = stubModel([
      { text: "", tool: { name: "lookup", args: { order: "A-1" } } },
      { text: "Delivered." },
    ]);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    await app.ask("support", "look up A-1");

    expect(said(stub.calls[1]?.body)).toContain("delivered");
    await app.close();
  });

  it("is reported as it happens, and once", async () => {
    const root = await projectGuarded(`() => "Not that one."`);
    const stub = stubModel([
      { text: "", tool: { name: "refund", args: { order: "A-1", amount: "20" } } },
      { text: "Sorry." },
    ]);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    const events: { kind: string }[] = [];
    await app.ask("support", "refund order A-1", { onProgress: (event) => events.push(event) });

    const refused = events.filter((event) => event.kind === "refused");
    expect(refused).toEqual([{ kind: "refused", name: "refund", why: "Not that one." }]);
    // A refusal is not an answer from the tool, so there is no result to report.
    expect(events.some((event) => event.kind === "tool result")).toBe(false);
    await app.close();
  });

  /**
   * A refusal is not the model failing.
   *
   * It says nothing about whether the model was good enough — a stronger one
   * would have been refused in the same place — so counting it would send the
   * router climbing for something climbing cannot fix.
   */
  it("is not counted against the model that asked, where a real failure is", async () => {
    const script = [
      { text: "", tool: { name: "broken", args: { order: "A-1" } } },
      { text: "Sorry." },
    ];

    const guarded = await projectGuarded(`() => "No."`);
    const one = await App.load({ root: guarded, env: MODEL_ENV, fetch: stubModel(script).fetch });
    await one.ask("support", "refund order A-1");
    await one.close();

    const open = await makeProject(BASE);
    roots.push(open);
    const two = await App.load({ root: open, env: MODEL_ENV, fetch: stubModel(script).fetch });
    await two.ask("support", "refund order A-1");
    await two.close();

    // Same request, same tool: refused it counts for nothing, run it counts.
    expect((await lastDecision(guarded)).after?.toolErrors).toBe(0);
    expect((await lastDecision(open)).after?.toolErrors).toBe(1);
  });
});

describe("an app that wrote no guard", () => {
  it("calls its tools", async () => {
    const root = await makeProject(BASE);
    roots.push(root);
    const stub = stubModel([
      { text: "", tool: { name: "lookup", args: { order: "A-1" } } },
      { text: "Delivered." },
    ]);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    await app.ask("support", "look up A-1");

    expect(said(stub.calls[1]?.body)).toContain("delivered");
    await app.close();
  });

  it("says so when guard.ts exports the wrong thing", async () => {
    const root = await makeProject({ ...BASE, "guard.ts": `export default 4;` });
    roots.push(root);
    const app = await App.load({ root, env: MODEL_ENV });
    expect(app.problems.join(" ")).toContain("guard.ts");
    await app.close();
  });
});
