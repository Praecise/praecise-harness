/**
 * A discovery document is only useful if its links resolve.
 *
 * Agents, workflows and functions are served on three different paths. `llms.txt` used to write
 * every capability under `/api/agents/`, so a model that read the file and called a workflow got
 * `no agent named "x"` — a dead link in the one file whose whole job is to say what to call.
 */

import { describe, expect, it } from "vitest";

import { App, agent, workflow } from "../src/index.js";
import { llmsTxt } from "../src/server/discovery.js";

async function appWith() {
  return App.from(
    {
      root: "/tmp",
      name: "acme",
      config: {},
      agents: {
        support: agent({ name: "support", role: "answers", description: "answers a question" }),
      },
      workflows: {
        onboard: workflow({
          name: "onboard",
          description: "takes a new customer through setup",
          steps: [{ id: "greet", ask: "support" }],
        }),
      },
      functions: {},
      tools: {},
      stores: {},
      prompts: {},
      resources: {},
      blueprints: {},
      templates: {},
      knowledge: [],
      warnings: [],
    } as never,
    { name: "acme", version: "0.0.0" },
  );
}

describe("llms.txt links each capability where it is actually served", () => {
  it("sends an agent to /api/agents", async () => {
    const text = llmsTxt(await appWith(), {}, "https://acme.example");
    expect(text).toContain("(https://acme.example/api/agents/support)");
  });

  it("sends a workflow to /api/workflows, not /api/agents", async () => {
    const text = llmsTxt(await appWith(), {}, "https://acme.example");
    expect(text).toContain("(https://acme.example/api/workflows/onboard)");
    expect(text).not.toContain("/api/agents/onboard");
  });
});
