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

  it("gives fast a single rung, so there is nowhere to climb", () => {
    const rungs = plan("fast");
    expect(rungs).toHaveLength(1);
    expect(rungs[0]?.model).toBe("small");
    expect(rungs[0]?.tier).toBe("fast");
  });

  it("gives more quality more room to work in", () => {
    expect(plan("balanced")).toHaveLength(2);
    const best = plan("best");
    expect(best.map((rung) => rung.model)).toEqual(["small", "mid", "large"]);
    expect(best.map((rung) => rung.tier)).toEqual(["fast", "balanced", "best"]);
  });

  it("does not offer the same model twice as somewhere to climb to", () => {
    const single = {
      house: { url: "https://x/v1", credential: "HOUSE_KEY", best: "only", thinking: "none" },
    } as const;
    expect(plan("best", { ...single }).map((rung) => rung.model)).toEqual(["only"]);
  });

  it("counts more depth on the same model as somewhere to climb to", () => {
    const single = {
      house: { url: "https://x/v1", credential: "HOUSE_KEY", best: "only", thinking: "effort" },
    } as const;
    const rungs = plan("best", { ...single });
    expect(rungs.map((rung) => rung.effort)).toEqual([0, 1]);
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

/**
 * An endpoint you host yourself may need no credential — a llama.cpp server on the
 * local network is the ordinary case. Before this, `chooseProvider` required a
 * non-empty key from the environment for EVERY declared endpoint, so the only way to
 * reach a keyless one was to invent a dummy value. That reads in a config file like a
 * secret that matters, and is a lie about the endpoint.
 *
 * The declaration has to be explicit, because "needs no credential" and "somebody
 * forgot to set the key" must not look alike: omitting `credential` still defaults to
 * NAME_API_KEY and still refuses.
 */
describe("an endpoint that needs no credential", () => {
  const LOCAL: Record<string, ModelProvider> = {
    local: { url: "http://100.103.203.6:8081/v1", credential: "", speaks: "chat", fast: "qwen3.5-4b" },
  };

  it("resolves with no key in the environment", () => {
    expect(chooseProvider(LOCAL, {})).toMatchObject({
      name: "local",
      baseUrl: "http://100.103.203.6:8081/v1",
      apiKey: "",
      viaCloud: false,
    });
  });

  it("still refuses when the credential is merely absent rather than declared empty", () => {
    const forgot: Record<string, ModelProvider> = { local: { url: "http://127.0.0.1:8081/v1", speaks: "chat" } };
    expect(chooseProvider(forgot, {})).toBeUndefined();
  });

  it("still needs a url — a credential-free provider is not a reachable one", () => {
    const noUrl: Record<string, ModelProvider> = { local: { credential: "", speaks: "chat" } };
    expect(chooseProvider(noUrl, {})).toBeUndefined();
  });

  it("is preferred over the cloud, like any declared endpoint", () => {
    expect(chooseProvider(LOCAL, { PRAECISE_API_KEY: "cloud" })?.name).toBe("local");
  });
});
