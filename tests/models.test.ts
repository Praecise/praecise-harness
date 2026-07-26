/**
 * Choosing what an agent runs on.
 *
 * The framework knows one endpoint, Praecise Cloud, and nothing else by name.
 * Everything else is described by the app, so these tests are mostly about a
 * declared endpoint winning, and about a partly-described one still working.
 */

import { describe, expect, it } from "vitest";

import type { ModelProvider } from "../src/define.js";
import { chooseProvider, planModels } from "../src/compile/models.js";

const OWN: Record<string, ModelProvider> = {
  house: {
    url: "https://models.internal/v1",
    credential: "HOUSE_KEY",
    speaks: "chat",
    fast: "small",
    balanced: "mid",
    best: "large",
  },
};

describe("chooseProvider", () => {
  it("uses an endpoint the app declared", () => {
    const found = chooseProvider(OWN, { HOUSE_KEY: "k" });
    expect(found).toMatchObject({
      name: "house",
      baseUrl: "https://models.internal/v1",
      credentialEnv: "HOUSE_KEY",
      viaCloud: false,
    });
  });

  it("names the credential after the provider when it did not say", () => {
    const found = chooseProvider(
      { house: { url: "https://models.internal/v1" } },
      { HOUSE_API_KEY: "k" },
    );
    expect(found?.credentialEnv).toBe("HOUSE_API_KEY");
  });

  it("prefers a declared endpoint over the cloud", () => {
    const found = chooseProvider(OWN, { HOUSE_KEY: "k", PRAECISE_API_KEY: "cloud" });
    expect(found?.viaCloud).toBe(false);
  });

  it("skips a declared endpoint whose key is missing", () => {
    const found = chooseProvider(OWN, { PRAECISE_API_KEY: "cloud" });
    expect(found).toMatchObject({ viaCloud: true, credentialEnv: "PRAECISE_API_KEY" });
  });

  it("honours an explicit preference between two declared endpoints", () => {
    const both = { ...OWN, other: { url: "https://other/v1", credential: "OTHER_KEY" } };
    const env = { HOUSE_KEY: "a", OTHER_KEY: "b" };
    expect(chooseProvider(both, env)?.name).toBe("house");
    expect(chooseProvider(both, env, "other")?.name).toBe("other");
  });

  it("takes the cloud gateway from the environment when it is overridden", () => {
    const found = chooseProvider({}, { PRAECISE_API_KEY: "c", PRAECISE_GATEWAY_URL: "http://x/" });
    expect(found?.baseUrl).toBe("http://x");
  });

  it("returns nothing when there is no key at all", () => {
    expect(chooseProvider(OWN, {})).toBeUndefined();
  });
});

describe("planModels", () => {
  const env = { HOUSE_KEY: "k" };
  const plan = (quality: "fast" | "balanced" | "best", providers = OWN) =>
    planModels({ env, quality, providers });

  it("gives fast a single rung that never hands off", () => {
    const rungs = plan("fast");
    expect(rungs).toHaveLength(1);
    expect(rungs[0]?.model).toBe("small");
    expect(rungs[0]?.handOffBelow).toBeUndefined();
  });

  it("climbs for balanced and best, ending with an unconditional rung", () => {
    expect(plan("balanced")).toHaveLength(2);
    const best = plan("best");
    expect(best.map((rung) => rung.model)).toEqual(["small", "mid", "large"]);
    expect(best.at(-1)?.handOffBelow).toBeUndefined();
    expect(best[0]?.handOffBelow).toBeLessThan(best[1]!.handOffBelow!);
  });

  it("runs every rung on the one model a provider named", () => {
    const single = { house: { url: "https://x/v1", credential: "HOUSE_KEY", best: "only" } };
    const rungs = plan("best", single);
    expect(rungs.map((rung) => rung.model)).toEqual(["only", "only", "only"]);
    // Still nowhere to climb to at the end, so the last answer stands.
    expect(rungs.at(-1)?.handOffBelow).toBeUndefined();
  });

  it("asks the cloud for a rung by name rather than for a model id", () => {
    const rungs = planModels({ env: { PRAECISE_API_KEY: "c" }, quality: "best" });
    expect(rungs.map((rung) => rung.model)).toEqual(["fast", "balanced", "best"]);
    expect(rungs[0]?.baseUrl).toBe("https://gateway.praecise.ai");
  });

  it("takes the depth style from the provider, not from the model name", () => {
    expect(plan("fast")[0]?.depth).toBe("none");
    const messages = { house: { ...OWN.house!, speaks: "messages" as const } };
    expect(plan("fast", messages)[0]?.depth).toBe("budget");
    const effort = { house: { ...OWN.house!, thinking: "effort" as const } };
    expect(plan("fast", effort)[0]?.depth).toBe("effort");
  });

  it("returns no rungs when nothing is configured, rather than throwing", () => {
    expect(planModels({ env: {}, quality: "best", providers: OWN })).toEqual([]);
  });
});
