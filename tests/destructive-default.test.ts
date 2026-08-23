import { describe, expect, it } from "vitest";
import { toolsOf } from "../src/server/mcp.js";
import { App, agent } from "../src/index.js";

function projectWith(effect?: string, access?: string) {
  return {
    root: "/tmp", name: "t", config: {},
    agents: {
      wire: agent({ name: "wire", role: "moves money", description: "sends a payment",
        ...(effect ? { effect } : {}), ...(access ? { access } : {}) } as never),
    },
    workflows: {}, functions: {}, tools: {}, stores: {}, prompts: {},
    resources: {}, blueprints: {}, templates: {}, knowledge: [], warnings: [],
  } as never;
}

describe("what a stranger with an MCP client can reach", () => {
  it("publishes an ordinary agent", async () => {
    const app = await App.from(projectWith(), { name: "t", version: "0" });
    expect(toolsOf(app, {}).map((t) => t.name)).toContain("wire");
  });

  it("REFUSES a destructive one that never named an access tier", async () => {
    const app = await App.from(projectWith("destructive"), { name: "t", version: "0" });
    expect(toolsOf(app, {}).map((t) => t.name)).not.toContain("wire");
  });

  it("publishes it once the author says so on purpose", async () => {
    const app = await App.from(projectWith("destructive", "open"), { name: "t", version: "0" });
    expect(toolsOf(app, {}).map((t) => t.name)).toContain("wire");
  });

  it("withholds it from a read-only caller even then", async () => {
    const app = await App.from(projectWith("destructive", "open"), { name: "t", version: "0" });
    expect(toolsOf(app, { readOnly: true }).map((t) => t.name)).not.toContain("wire");
  });
});
