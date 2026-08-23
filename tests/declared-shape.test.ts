/**
 * A declared shape has to survive an agent that holds tools.
 *
 * A tool list and a response schema cannot constrain the same reply, so a turn
 * that offers tools decodes free-form. That is right for a turn that might call
 * one, and wrong for the turn that ends the conversation — which was returned
 * exactly as written. `returns` therefore became advice, silently, for every
 * agent that happened to hold a tool. A self asked for a probability answered
 * `/><v 2, 0.95,` and a downstream guard caught it, which is the guard doing its
 * job and the endpoint not doing the one it was already capable of.
 */

import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { MODEL_ENV, TEST_ENDPOINT, cleanup, FRAMEWORK, makeProject, stubModel } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(cleanup)));

const BASE = {
  "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
    export default defineConfig({ name: "acme", quality: "fast", ${TEST_ENDPOINT} });`,
  "agents/clerk.ts": `import { agent } from "${FRAMEWORK}";
    export default agent({
      role: "Reads an order and reports on it.",
      description: "Answers about orders.",
      tools: ["lookup"],
      returns: { status: "one word", confident: "a number between 0 and 1" },
    });`,
  "agents/plain.ts": `import { agent } from "${FRAMEWORK}";
    export default agent({
      role: "Reads an order and reports on it.",
      description: "Answers about orders.",
      tools: ["lookup"],
    });`,
  "functions/lookup.ts": `import { fn } from "${FRAMEWORK}";
    export default fn({
      description: "Look up an order.",
      input: { order: "the order id" },
      effect: "read",
      run: ({ order }) => ({ order, status: "delivered" }),
    });`,
};

async function project() {
  const root = await makeProject(BASE);
  roots.push(root);
  return root;
}

/** Whether this request asked the endpoint to constrain decoding. */
const constrained = (body: Record<string, unknown> | undefined): boolean => {
  // The two wires spell the same request differently: `response_format` on the chat
  // shape, `output_config.format` on the messages shape. Either one is the endpoint
  // being told to constrain decoding, which is the thing under test.
  if (!body) return false;
  if ("response_format" in body) return true;
  const config = body["output_config"] as { format?: unknown } | undefined;
  return Boolean(config?.format);
};

const offeredTools = (body: Record<string, unknown> | undefined): boolean =>
  Array.isArray((body ?? {})["tools"]) && ((body ?? {})["tools"] as unknown[]).length > 0;

describe("the answer that ends a tool-using turn", () => {
  it("is asked for again against the declared shape", async () => {
    const stub = stubModel([
      { text: "", tool: { name: "lookup", args: { order: "A-1" } } },
      { text: "It is delivered, I am fairly sure." },
      { text: `{"status":"delivered","confident":0.9}` },
    ]);
    const app = await App.load({ root: await project(), env: MODEL_ENV, fetch: stub.fetch });

    await app.ask("clerk", "look up A-1");

    const last = stub.calls.at(-1)?.body;
    expect(constrained(last)).toBe(true);
    // Withheld on that turn, exactly as the out-of-turns path already does: the
    // conversation is over, and a tool offered now could only restart it.
    expect(offeredTools(last)).toBe(false);
    await app.close();
  });

  it("does not spend a turn when there is no shape to hold it to", async () => {
    const stub = stubModel([
      { text: "", tool: { name: "lookup", args: { order: "A-1" } } },
      { text: "It is delivered." },
    ]);
    const app = await App.load({ root: await project(), env: MODEL_ENV, fetch: stub.fetch });

    // `plain` holds the same tool and declares no shape.
    await app.ask("plain", "look up A-1");

    // One turn that called the tool, one that concluded. Nothing further.
    expect(stub.calls).toHaveLength(2);
    await app.close();
  });
});
