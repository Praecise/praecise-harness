import { afterEach, describe, expect, it } from "vitest";

import { META_KEY, agent, createApp, fn, listingOf, type App } from "../src/index.js";
import { agentCard } from "../src/server/a2a.js";
import { jsonLd, llmsTxt } from "../src/server/discovery.js";
import { toolsOf } from "../src/server/mcp.js";
import { scriptedModel } from "../src/testing/index.js";
import { cleanup, makeProject } from "./helpers.js";

interface Skill {
  id: string;
  tags: string[];
  examples?: string[];
  inputModes: string[];
  outputModes: string[];
}

describe("catalogue metadata on an agent", () => {
  let root: string | undefined;
  let app: App | undefined;

  afterEach(async () => {
    await app?.close();
    if (root) await cleanup(root);
    app = undefined;
    root = undefined;
  });

  const META = {
    version: "2.1.0",
    tags: ["billing", "refunds"],
    languages: ["en", "pt-BR"],
    inputModes: ["text/plain", "application/pdf"],
    outputModes: ["application/json"],
    examples: ["Refund order 4021", "Why was I charged twice?"],
    owner: "payments-team",
  };

  async function build() {
    root = await makeProject({});
    const model = scriptedModel([], { endpoint: { takes: ["image", "document"] } });
    app = await createApp({
      root,
      config: { models: model.models },
      agents: {
        billing: agent({ role: "You answer billing questions.", meta: META, returns: { verdict: "what was decided" } }),
        plain: agent({ role: "You answer anything.", group: "general" }),
      },
      functions: { ping: fn({ description: "Answer pong, to show the app is up.", run: () => "pong" }) },
    });
    return model;
  }

  const skillsOf = (card: Record<string, unknown>) => card.skills as Skill[];

  it("puts an agent's own tags, examples and stated modes on its A2A skill", async () => {
    await build();
    const skills = skillsOf(agentCard(app!));
    const billing = skills.find((skill) => skill.id === "billing")!;
    expect(billing.tags).toEqual(["billing", "refunds"]);
    expect(billing.examples).toEqual(META.examples);
    expect(billing.inputModes).toEqual(["text/plain", "application/pdf"]);
    expect(billing.outputModes).toEqual(["application/json"]);
  });

  it("tags a skill with its own group where it says nothing, and not with every group of the app", async () => {
    await build();
    const skills = skillsOf(agentCard(app!));
    expect(skills.find((skill) => skill.id === "plain")!.tags).toEqual(["general"]);
    expect(skills.find((skill) => skill.id === "ping")!.tags).toEqual(["functions"]);
    const plain = skills.find((skill) => skill.id === "plain")!;
    expect(plain.inputModes).toEqual(["text/plain"]);
    expect(plain.outputModes).toEqual(["text/plain"]);
    expect("examples" in plain).toBe(false);
    // The 0.3 card carries the same skills.
    expect(skillsOf(agentCard(app!, {}, "", "0.3")).find((skill) => skill.id === "billing")!.tags).toEqual(["billing", "refunds"]);
  });

  it("carries meta whole in the MCP tool's _meta, and adds none where there is none", async () => {
    await build();
    const tools = toolsOf(app!);
    expect(tools.find((entry) => entry.name === "billing")!._meta).toEqual({ [META_KEY]: META });
    expect("_meta" in tools.find((entry) => entry.name === "plain")!).toBe(false);
    expect("_meta" in tools.find((entry) => entry.name === "ping")!).toBe(false);
  });

  it("says in the discovery documents what the agent is about and what its endpoints take", async () => {
    await build();
    const text = llmsTxt(app!, {}, "https://app.test");
    const line = text.split("\n").find((entry) => entry.startsWith("- [billing]"))!;
    expect(line).toContain("Tags: billing, refunds.");
    expect(line).toContain("Languages: en, pt-BR.");
    expect(line).toContain("Takes attachments: image/*, application/pdf.");
    expect(line).toContain("Version 2.1.0.");
    // A function has no model behind it and no meta.
    expect(text.split("\n").find((entry) => entry.startsWith("- [ping]"))).toMatch(/to show the app is up\.$/);

    const actions = jsonLd(app!).potentialAction as Record<string, unknown>[];
    expect(actions.find((action) => action.name === "billing")).toMatchObject({ keywords: "billing, refunds", inLanguage: ["en", "pt-BR"] });
    expect("keywords" in actions.find((action) => action.name === "plain")!).toBe(false);
  });

  it("works a listing out from what the agent declares and what its endpoints take", async () => {
    await build();
    expect(listingOf(app!, "billing")).toEqual({
      group: "agents",
      tags: ["billing", "refunds"],
      meta: META,
      takes: ["text/plain", "image/*", "application/pdf"],
      gives: ["application/json", "text/plain"],
    });
    expect(listingOf(app!, "ping")).toEqual({ group: "functions", tags: ["functions"], takes: ["text/plain"], gives: ["text/plain"] });
  });

  it("keeps meta out of what a model is sent", async () => {
    const model = await build();
    model.push({ text: { verdict: "ok" } });
    await app!.ask("billing", "hello");
    expect(JSON.stringify(model.requests)).not.toContain("payments-team");
    expect(JSON.stringify(model.requests)).not.toContain("Refund order 4021");
  });
});
