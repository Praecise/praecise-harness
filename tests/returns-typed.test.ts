import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import {
  ShapeError,
  agent,
  createApp,
  fn,
  uncheckedIn,
  validateJson,
  workflow,
  type App,
  type AppDefinition,
  type StandardSchemaV1,
} from "../src/index.js";
import { schemaFromReturns } from "../src/compile/plan.js";
import { scriptedModel, type Scripted } from "../src/testing/index.js";
import { cleanup, makeProject } from "./helpers.js";

const TRIAGE = {
  type: "object",
  additionalProperties: false,
  required: ["label", "priority"],
  properties: {
    label: { enum: ["refund", "shipping", "other"] },
    priority: { type: "integer", minimum: 1, maximum: 5 },
    tags: { type: "array", items: { type: "string" }, maxItems: 3 },
    note: { type: "string", nullable: true },
  },
};

interface Triage {
  label: "refund" | "shipping" | "other";
  priority: number;
  at: Date;
}

/** A Standard Schema v1 validator written by hand, as a library's would behave. */
function triageSchema(withJsonSchema: boolean): StandardSchemaV1<unknown, Triage> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => {
        const given = value as Record<string, unknown> | null;
        const issues: { message: string; path?: PropertyKey[] }[] = [];
        if (typeof given !== "object" || given === null) return { issues: [{ message: "expected an object" }] };
        if (!["refund", "shipping", "other"].includes(String(given.label))) issues.push({ message: "not a known label", path: ["label"] });
        if (typeof given.priority !== "number") issues.push({ message: "expected a number", path: ["priority"] });
        if (issues.length) return { issues };
        // A validator may produce something the JSON did not hold.
        return { value: { label: given.label as Triage["label"], priority: given.priority as number, at: new Date(0) } };
      },
      ...(withJsonSchema ? { jsonSchema: { output: () => TRIAGE } } : {}),
    },
  } as StandardSchemaV1<unknown, Triage>;
}

describe("the JSON Schema check", () => {
  it("accepts a value that matches", () => {
    expect(validateJson(TRIAGE, { label: "refund", priority: 2, tags: ["a"], note: null })).toEqual([]);
  });

  it("names each thing that is wrong, and where", () => {
    expect(validateJson(TRIAGE, { label: "billing", priority: 2.5, tags: ["a", 3, "c", "d"], extra: 1 })).toEqual([
      '$.label: expected one of ["refund","shipping","other"], got "billing"',
      "$.priority: expected integer, got number",
      "$.tags: more than 3 items",
      "$.tags[1]: expected string, got integer",
      "$.extra: not a field of the declared shape",
    ]);
    expect(validateJson(TRIAGE, { label: "refund" })).toEqual(["$.priority: missing"]);
    expect(validateJson(TRIAGE, "refund")).toEqual(["$: expected object, got string"]);
    expect(validateJson(TRIAGE, { label: "refund", priority: 9 })).toEqual(["$.priority: 9 is more than 5"]);
  });

  it("checks const, anyOf, oneOf, type lists and lengths", () => {
    expect(validateJson({ const: { a: [1] } }, { a: [1] })).toEqual([]);
    expect(validateJson({ const: 1 }, 2)).toHaveLength(1);
    expect(validateJson({ anyOf: [{ type: "string" }, { type: "number" }] }, true)).toEqual(["$: matched none of the 2 shapes under anyOf"]);
    expect(validateJson({ oneOf: [{ type: "number" }, { type: "integer" }] }, 3)).toEqual([
      "$: matched 2 shapes under oneOf, and exactly one is allowed",
    ]);
    expect(validateJson({ type: ["string", "null"] }, null)).toEqual([]);
    expect(validateJson({ type: "string", minLength: 2, maxLength: 3 }, "abcd")).toEqual(["$: longer than 3 characters"]);
    expect(validateJson({ type: "object", additionalProperties: { type: "number" } }, { a: "x" })).toEqual([
      "$.a: expected number, got string",
    ]);
  });

  it("says which keywords it does not check, without mistaking a field's name for one", () => {
    expect(
      uncheckedIn({
        type: "object",
        properties: { format: { type: "string", pattern: "^a" }, when: { type: "string", format: "date" } },
        allOf: [{ required: ["when"] }],
      }).sort(),
    ).toEqual(["allOf", "format", "pattern"]);
    expect(uncheckedIn(TRIAGE)).toEqual([]);
  });
});

describe("returns describes typed data", () => {
  let root: string | undefined;
  let app: App | undefined;

  afterEach(async () => {
    await app?.close();
    if (root) await cleanup(root);
    app = undefined;
    root = undefined;
  });

  async function build(replies: Scripted[], definition: AppDefinition) {
    root = await makeProject({});
    const model = scriptedModel(replies);
    app = await createApp({ root, ...definition, config: { ...definition.config, models: model.models } });
    return model;
  }

  it("sends a JSON Schema for constrained decoding untouched, and returns data that matches it", async () => {
    const model = await build([{ text: { label: "refund", priority: 2 } }], {
      agents: { triage: agent({ role: "You triage tickets.", returns: TRIAGE }) },
    });

    const answer = await app!.ask("triage", "my parcel never came");

    expect(model.requests[0]!.schema).toBe(TRIAGE);
    expect(model.requests[0]!.json).toBe(true);
    expect(model.requests[0]!.system).toContain("Reply with JSON that matches this JSON Schema");
    expect(model.requests[0]!.system).toContain('"priority"');
    expect(answer.data).toEqual({ label: "refund", priority: 2 });
    expect(app!.plans.triage!.problems).toEqual([]);
  });

  it("counts an answer outside the schema as failed: deeper first, then a stronger model", async () => {
    const model = await build(
      [{ text: { label: "billing", priority: 2 } }, { text: { label: "refund", priority: "high" } }, { text: { label: "refund", priority: 1 } }],
      { agents: { triage: agent({ role: "You triage tickets.", returns: TRIAGE, quality: "best" }) } },
    );

    const answer = await app!.ask("triage", "my parcel never came");

    expect(answer.data).toEqual({ label: "refund", priority: 1 });
    expect(model.requests.length).toBe(3);
    // It moved up the ladder, and never back down it.
    const order = ["fast", "balanced", "best"];
    const asked = model.requests.map((request) => order.indexOf(request.model));
    expect(asked).toEqual([...asked].sort((a, b) => a - b));
    expect(asked.at(-1)).toBeGreaterThan(asked[0]!);
    expect(answer.notes?.join("\n")).toContain("not in the declared shape");
    expect(answer.notes?.join("\n")).toContain("$.label");
  });

  it("ends in an error carrying the issues when the strongest model is outside it too", async () => {
    const model = scriptedModel([], { fallback: { text: { label: "refund" } } });
    root = await makeProject({});
    app = await createApp({ root, config: { models: model.models }, agents: { triage: agent({ role: "You triage tickets.", returns: TRIAGE }) } });

    const failure = await app.ask("triage", "my parcel never came").then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(ShapeError);
    expect((failure as ShapeError).issues).toEqual(["$.priority: missing"]);
    expect((failure as ShapeError).text).toBe('{"label":"refund"}');
    expect((failure as ShapeError).agent).toBe("triage");
    expect(model.requests.at(-1)!.model).toBe("balanced");
  });

  it("treats a reply that is not JSON the same way under a schema", async () => {
    const model = scriptedModel([], { fallback: "I think it is a refund." });
    root = await makeProject({});
    app = await createApp({ root, config: { models: model.models, preference: "quality" }, agents: { triage: agent({ role: "You triage.", returns: TRIAGE }) } });
    await expect(app.ask("triage", "x")).rejects.toThrow(/expected JSON but the reply was not valid JSON/);
  });

  it("leaves fields and hints as they were: structure sent, values unchecked, a bad reply noted", async () => {
    const model = await build([{ text: { label: 7 } }, "not json at all"], {
      config: { preference: "quality" },
      agents: { triage: agent({ role: "You triage tickets.", returns: { label: "one of: refund, shipping" } }) },
    });

    const first = await app!.ask("triage", "x");
    expect(first.data).toEqual({ label: 7 });
    expect(model.requests[0]!.schema).toEqual(schemaFromReturns({ label: "one of: refund, shipping" }));
    expect(model.requests[0]!.system).toContain("Reply with JSON in exactly this shape");

    const second = await app!.ask("triage", "x");
    expect(second.data).toBeUndefined();
    expect(second.text).toBe("not json at all");
    expect(second.notes?.join("\n")).toContain("expected JSON");
  });

  it("checks with a Standard Schema, returns what it produces, and types the data", async () => {
    const triage = agent({ name: "triage", role: "You triage tickets.", returns: triageSchema(true) });
    const model = await build([{ text: { label: "nope", priority: 1 } }, { text: { label: "shipping", priority: 3 } }], {
      agents: { triage },
    });

    const answer = await app!.ask(triage, "where is it");

    expectTypeOf(answer.data).toEqualTypeOf<Triage | undefined>();
    expectTypeOf((await Promise.resolve(app!.ask("triage", "x").catch(() => undefined)))?.data).toEqualTypeOf<unknown>();
    expect(answer.data).toEqual({ label: "shipping", priority: 3, at: new Date(0) });
    // The validator described itself as JSON Schema, so the endpoint was sent that.
    expect(model.requests[0]!.schema).toBe(TRIAGE);
    expect(answer.notes?.join("\n")).toContain("$.label: not a known label");
  });

  it("asks for JSON and checks afterwards when a Standard Schema cannot describe itself", async () => {
    const model = await build([{ text: { label: "other", priority: 4 } }], {
      config: { preference: "quality" },
      agents: { triage: agent({ role: "You triage tickets.", returns: triageSchema(false) }) },
    });
    const answer = await app!.ask("triage", "x");
    expect(model.requests[0]!.schema).toBeUndefined();
    expect(model.requests[0]!.json).toBe(true);
    expect(answer.data).toMatchObject({ label: "other", priority: 4 });
    expect(app!.plans.triage!.problems.join("\n")).toContain("cannot describe itself as JSON Schema");
  });

  it("lets the agent's own read refuse an answer that is in the shape", async () => {
    const seen: unknown[] = [];
    const model = await build([{ text: { label: "refund", priority: 5 } }, { text: { label: "refund", priority: 2 } }], {
      agents: {
        triage: agent({
          role: "You triage tickets.",
          returns: TRIAGE,
          read: (data) => {
            seen.push(data);
            return (data as { priority: number }).priority > 3 ? "priority above 3 needs a person" : undefined;
          },
        }),
      },
    });

    const answer = await app!.ask("triage", "x");
    expect(answer.data).toEqual({ label: "refund", priority: 2 });
    expect(seen).toHaveLength(2);
    expect(model.requests).toHaveLength(2);
    expect(answer.notes?.join("\n")).toContain("priority above 3 needs a person");
  });

  it("holds fields and hints to a read where the agent brings one", async () => {
    const model = scriptedModel([], { fallback: { text: { total: "12" } } });
    root = await makeProject({});
    app = await createApp({
      root,
      config: { models: model.models, preference: "quality" },
      agents: { sum: agent({ role: "You add.", returns: { total: "the sum" }, read: () => "the total does not add up" }) },
    });
    const failure = await app.ask("sum", "1+1").then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(ShapeError);
    expect((failure as ShapeError).issues).toEqual(["the total does not add up"]);
  });

  it("is checked for an agent that used tools, and for a workflow step's own shape", async () => {
    const model = await build(
      [
        { tool: { name: "lookup", args: { order: "9" } } },
        "It is a refund.",
        { text: { label: "refund", priority: 2 } },
        { text: { count: 3 } },
      ],
      {
        config: { preference: "quality" },
        agents: { triage: agent({ role: "You triage tickets.", returns: TRIAGE, tools: ["lookup"] }), plain: agent({ role: "You count." }) },
        functions: { lookup: fn({ description: "Look an order up.", input: { order: "the id" }, run: () => "refunded" }) },
        workflows: {
          flow: workflow({
            steps: [
              {
                id: "count",
                ask: "how many?",
                agent: "plain",
                returns: { type: "object", required: ["count"], properties: { count: { type: "integer" } } },
              },
            ],
          }),
        },
      },
    );

    const answer = await app!.ask("triage", "order 9");
    expect(answer.data).toEqual({ label: "refund", priority: 2 });
    // The concluding answer was asked for once more with the schema and no tools.
    expect(model.requests[2]!.schema).toBe(TRIAGE);

    const run = await app!.startWorkflow("flow", {});
    expect(run.status).toBe("done");
    expect(run.outputs.count).toEqual({ count: 3 });
    expect(model.requests[3]!.system).toContain("Reply with JSON that matches this JSON Schema");
  });
});
