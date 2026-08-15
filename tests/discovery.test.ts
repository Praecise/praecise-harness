/**
 * Being found, and being asked.
 *
 * Two halves of the same problem: a machine arrives knowing nothing, and has to work out
 * what this system is and how to use it in about one request. Discovery documents answer
 * the first part; `/ask` answers the second by generating what was wanted rather than
 * serving what somebody wrote in advance.
 *
 * The tests that matter here are the refusals and the filters. A discovery document that
 * lists a capability the reader will then be refused is a disclosure; an `/ask` endpoint
 * that honours a caller's request for the most expensive model is a way to spend the
 * operator's money without their consent.
 */
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { agent, fn } from "../src/define.js";
import { createApp } from "../src/sdk.js";
import { jsonLd, jsonLdScript, llmsTxt, robotsTxt } from "../src/server/discovery.js";
import { ask, compact, edgeFirst, modeFor, qualityFor, rank, termsOf, type AskResult } from "../src/server/ask.js";
import { ceilingFor } from "../src/harness/builtin.js";
import { MODEL_ENV, cleanup, stubModel } from "./helpers.js";

const roots: string[] = [];
const stub = stubModel(Array.from({ length: 40 }, () => ({ text: "a generated answer" })));

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

const build = (over: Record<string, unknown> = {}): Promise<App> =>
  createApp(
    {
      name: "acme",
      version: "2.1.0",
      config: CONFIG,
      agents: {
        support: agent({ role: "Help.", description: "Answers billing questions.", effect: "read" }),
        auditor: agent({ role: "Audit.", description: "Audits refunds.", access: "gated", effect: "read" }),
      },
      functions: {
        refund: fn({
          description: "Refund an order.",
          input: { order: "the order id" },
          effect: "write",
          run: ({ order }) => ({ refunded: order }),
        }),
      },
      ...over,
    },
    { env: MODEL_ENV, fetch: stub.fetch },
  );

describe("llms.txt", () => {
  it("names the app and points a model at what it can do", async () => {
    const app = await build();
    const text = llmsTxt(app, { identified: true }, "https://acme.example");

    // The format is specified: one H1, a blockquote summary, then H2 lists of links.
    expect(text.startsWith("# acme\n")).toBe(true);
    expect(text).toContain("> acme is an agentic application");
    expect(text).toContain("## Capabilities");
    expect(text).toContain("- [support](https://acme.example/api/agents/support): Answers billing questions.");
  });

  it("points at the protocol endpoints, because reading is not the point", async () => {
    const app = await build();
    const text = llmsTxt(app, {}, "https://acme.example");
    expect(text).toContain("https://acme.example/mcp");
    expect(text).toContain("https://acme.example/.well-known/agent-card.json");
    expect(text).toContain("https://acme.example/ask");
  });

  it("lists only what this reader could actually reach", async () => {
    // The disclosure this avoids: telling an anonymous reader that a gated capability
    // exists. It is the same filter the tool list applies, deliberately.
    const app = await build();
    const anonymous = llmsTxt(app, {});
    const identified = llmsTxt(app, { identified: true });

    expect(anonymous).not.toContain("auditor");
    expect(identified).toContain("auditor");
  });
});

describe("JSON-LD", () => {
  it("describes the app as software with actions, not as a page", async () => {
    const app = await build();
    const data = jsonLd(app, { identified: true }, "https://acme.example") as {
      "@type": string;
      potentialAction: { name: string; target: { urlTemplate: string; httpMethod: string } }[];
      subjectOf: { name: string }[];
    };

    expect(data["@type"]).toBe("SoftwareApplication");
    expect(data.potentialAction.map((a) => a.name)).toContain("refund");
    expect(data.potentialAction[0]?.target.httpMethod).toBe("POST");
    expect(data.subjectOf.map((s) => s.name)).toEqual(["MCP", "A2A", "Ask"]);
  });

  it("cannot be used to close its own script tag", async () => {
    // A description containing `</script>` would otherwise end the block early and
    // everything after it becomes markup. Old bug, no excuse in new code.
    const app = await createApp(
      {
        name: "acme",
        config: CONFIG,
        agents: { support: agent({ role: "Help.", description: "Handles </script><img> tickets." }) },
      },
      { env: MODEL_ENV, fetch: stub.fetch },
    );
    const html = jsonLdScript(app, { identified: true });
    expect(html).not.toContain("</script><img>");
    expect(html).toContain("\\u003c/script");
  });
});

describe("robots.txt", () => {
  it("keeps crawlers away from the endpoints that cost money", async () => {
    // An agentic app inverts the usual advice: there is little to index and a great deal
    // that spends a model call per request.
    const text = robotsTxt("https://acme.example");
    expect(text).toContain("Disallow: /api/");
    expect(text).toContain("Disallow: /ask");
    expect(text).toContain("Allow: /llms.txt");
  });
});

describe("ranking a question against what the app publishes", () => {
  it("drops the words that carry nothing", () => {
    expect([...termsOf("what can you do for a refund?")]).toEqual(["refund"]);
  });

  it("scores by how much of the question was matched", () => {
    const items = [
      { name: "refund", description: "Refund an order." },
      { name: "support", description: "Answers billing questions." },
    ];
    const found = rank("refund an order", items);
    expect(found[0]?.name).toBe("refund");
    expect(found[0]?.score).toBeGreaterThan(found[1]?.score ?? 0);
  });

  it("returns nothing rather than everything when nothing matches", () => {
    // A ranked list of irrelevant results is worse than an empty one: a model will use it.
    expect(rank("photosynthesis", [{ name: "refund", description: "Refund an order." }])).toEqual([]);
  });
});

describe("what the caller may ask for, and what the operator allows", () => {
  it("lets a caller economise", () => {
    expect(qualityFor("fast", { quality: "best" })).toBe("fast");
    expect(modeFor("list", { mode: "generate" })).toBe("list");
  });

  it("never lets a caller escalate", () => {
    // The whole point. Otherwise `/ask?mode=generate&quality=best` is an unauthenticated
    // request that spends the operator's most expensive model.
    expect(qualityFor("best", { quality: "fast" })).toBe("fast");
    expect(modeFor("generate", { mode: "list" })).toBe("list");
  });

  it("costs nothing by default", () => {
    // No mode asked for means `list`, which never reaches a model.
    expect(modeFor(undefined, {})).toBe("list");
    expect(qualityFor(undefined, {})).toBe("fast");
  });
});

describe("/ask", () => {
  it("answers a list without reaching a model at all", async () => {
    const app = await build();
    const before = stub.calls.length;
    const answer = await ask(app, { query: "refund an order" }, { identified: true }, {});

    expect(answer.mode).toBe("list");
    expect(answer.results.map((r) => r.name)).toContain("refund");
    expect(answer.answer).toBeUndefined();
    // The claim: `list` retrieves and ranks and returns, and never spends anything.
    expect(stub.calls.length).toBe(before);
  });

  it("generates an answer when the operator allowed it, and says who did", async () => {
    const app = await build();
    const answer = await ask(
      app,
      { query: "refund an order", mode: "generate" },
      { identified: true },
      { mode: "generate", quality: "balanced", agent: "support" },
    );

    expect(answer.mode).toBe("generate");
    expect(answer.answer).toBeTruthy();
    expect(answer.generated_by).toEqual({ quality: "balanced", agent: "support" });
  });

  it("caps an over-reaching request and says it did", async () => {
    const app = await build();
    const answer = await ask(
      app,
      { query: "refund an order", mode: "generate", quality: "best" },
      { identified: true },
      { mode: "summarize", quality: "fast" },
    );

    expect(answer.mode).toBe("summarize");
    expect(answer.notes?.join(" ")).toContain("above what this deployment allows");
  });

  it("retrieves only what this caller could reach", async () => {
    // An answer must not mention a capability the same caller would be refused.
    const app = await build();
    const anonymous = await ask(app, { query: "audit refunds" }, {}, {});
    const identified = await ask(app, { query: "audit refunds" }, { identified: true }, {});

    expect(anonymous.results.map((r) => r.name)).not.toContain("auditor");
    expect(identified.results.map((r) => r.name)).toContain("auditor");
  });

  it("refuses an empty question instead of answering one nobody asked", async () => {
    const app = await build();
    const answer = await ask(app, {}, {}, {});
    expect(answer.results).toEqual([]);
    expect(answer.notes?.join(" ")).toContain("`query` is required");
  });

  it("keeps the retrieved list when generation fails", async () => {
    // A model that would not answer must not turn into a silent empty page: what was
    // retrieved is still real, and the reason is attached rather than swallowed.
    const app = await createApp(
      {
        name: "acme",
        config: CONFIG,
        agents: { support: agent({ role: "Help.", description: "Answers billing questions." }) },
      },
      {
        env: MODEL_ENV,
        fetch: (async () => new Response("upstream is down", { status: 500 })) as unknown as typeof fetch,
      },
    );

    const answer = await ask(
      app,
      { query: "billing questions", mode: "generate" },
      { identified: true },
      { mode: "generate" },
    );
    expect(answer.results.length).toBeGreaterThan(0);
    expect(answer.answer).toBeUndefined();
    expect(answer.notes?.join(" ")).toContain("could not generate");
  });
});

describe("the ladder ceiling this rests on", () => {
  const ladder = (tiers: string[]) =>
    ({ rungs: tiers.map((tier) => ({ tier })) }) as never;

  it("leaves a plan alone when nothing was asked for", () => {
    const plan = ladder(["fast", "balanced", "best"]);
    expect(ceilingFor(plan, undefined)).toHaveLength(3);
  });

  it("trims rather than selects, so every cheaper rung survives", () => {
    // Selecting one rung would disable escalation entirely; trimming keeps the router's
    // behaviour and only removes what is above the ceiling.
    const kept = ceilingFor(ladder(["fast", "balanced", "best"]), "balanced");
    expect(kept.map((r) => r.tier)).toEqual(["fast", "balanced"]);
  });

  it("keeps the cheapest rung rather than leaving nothing", () => {
    // An agent whose cheapest rung is already above the ceiling still has to answer:
    // "you asked for cheap, so you get nothing" serves nobody.
    const kept = ceilingFor(ladder(["best"]), "fast");
    expect(kept.map((r) => r.tier)).toEqual(["best"]);
  });
});

describe("the layer between the database and the prompt", () => {
  const row = (over: Partial<AskResult> & { at?: number; sku?: string }): AskResult => ({
    url: `/x/${over.name ?? "r"}`,
    name: over.name ?? "row",
    site: "catalogue",
    score: over.score ?? 0.5,
    description: over.description ?? "a description",
    schema_object: { "@type": "Product", sku: over.sku, at: over.at },
  });

  it("keeps the newer of two rows that cannot both be current", () => {
    // A price that changed. Handing a model both is handing it a contradiction and
    // letting it pick.
    const packed = compact([
      row({ name: "old", sku: "A-1", at: 1_000, description: "Widget, £10" }),
      row({ name: "new", sku: "A-1", at: 2_000, description: "Widget, £12" }),
    ]);

    expect(packed.kept).toHaveLength(1);
    expect(packed.kept[0]?.description).toContain("£12");
    // The loser is not deleted — the archive is still the archive, closed off at the
    // moment the newer row was written.
    expect(packed.superseded).toHaveLength(1);
    expect(packed.superseded[0]?.schema_object.supersededAt).toBe(2_000);
  });

  it("keeps two products that share a description but differ by SKU", () => {
    // A size, a colour, a region. Collapsing these makes half an inventory invisible.
    const packed = compact([
      row({ name: "small", sku: "A-1", description: "Widget, blue" }),
      row({ name: "large", sku: "A-2", description: "Widget, blue" }),
    ]);
    expect(packed.kept).toHaveLength(2);
    expect(packed.duplicates).toBe(0);
  });

  it("drops a near-duplicate that carries nothing new", () => {
    // No business key on either: nothing tells them apart but their text.
    const packed = compact([
      row({ name: "a", description: "Widget, blue" }),
      row({ name: "b", description: "Widget, blue" }),
    ]);
    expect(packed.kept).toHaveLength(1);
    expect(packed.duplicates).toBe(1);
  });

  it("reports what did not fit rather than pretending it was everything", () => {
    // The failure this prevents: a model handed 8 of 340 rows says "the catalogue
    // contains" about 2% of it, fluently and wrongly.
    const many = Array.from({ length: 60 }, (_, i) =>
      row({ name: `item-${i}`, sku: `S-${i}`, description: "x".repeat(300), score: 1 - i / 100 }),
    );
    const packed = compact(many, 200);

    expect(packed.kept.length).toBeLessThan(many.length);
    expect(packed.omitted).toBe(many.length - packed.kept.length);
  });

  it("never returns nothing just because one row was oversized", () => {
    // A single row larger than the whole budget must still be answered with, or a
    // narrow question about a long document returns an empty page.
    const packed = compact([row({ description: "x".repeat(50_000) })], 10);
    expect(packed.kept).toHaveLength(1);
  });

  it("deals the ranked list to both ends, not down the middle", () => {
    // Attention is strongest at the edges and weakest in the middle, so the weakest
    // matches belong in the middle — which is what LongLLMLingua reorders for.
    expect(edgeFirst([1, 2, 3, 4, 5])).toEqual([1, 3, 5, 4, 2]);
    // Best first and second-best last: both edges carry a strong match.
    const order = edgeFirst(["best", "second", "third"]);
    expect(order[0]).toBe("best");
    expect(order.at(-1)).toBe("second");
  });

  it("leaves a list that already fits completely alone", () => {
    const packed = compact([row({ name: "a", sku: "A", description: "one" }), row({ name: "b", sku: "B", description: "two" })], 1_000);
    expect(packed.kept).toHaveLength(2);
    expect(packed.omitted).toBe(0);
    expect(packed.duplicates).toBe(0);
  });
});
