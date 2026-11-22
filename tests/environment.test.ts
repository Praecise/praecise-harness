/**
 * An environment: one sign-in, the accounts it reaches by name, and a guard on what may
 * be done to each.
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { serve } from "../src/server/index.js";
import { StepUpRequired } from "../src/authority.js";
import type { Attempt } from "../src/define.js";
import { environment, fileVault, memoryVault, secretCipher, type Environment, type EnvironmentSpec } from "../src/environment/index.js";
import { FRAMEWORK, MODEL_ENV, TEST_ENDPOINT, cleanup, makeProject } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const folder = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "praecise-environment-"));
  roots.push(root);
  return root;
};

/** A platform: a token endpoint, and an API that says who is asking. */
const platform = (): { fetch: typeof fetch; seen: { url: string; authorization: string | null; body: string }[] } => {
  const seen: { url: string; authorization: string | null; body: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    seen.push({ url, authorization: headers.get("authorization"), body: String(init?.body ?? "") });
    if (url === "https://platform.example/token") {
      const nth = seen.filter((each) => each.url === url).length;
      return Response.json({ access_token: nth === 1 ? "secret-token-value" : `secret-token-${nth}`, expires_in: 5_184_000, scope: "reports.read ads.write" });
    }
    if (url === "https://mcp.platform.example/ads") {
      // The platform's own MCP server: it lists two tools, and a call answers with what it was given.
      const body = JSON.parse(String(init?.body ?? "{}")) as { id?: unknown; method?: string; params?: { arguments?: unknown } };
      const result =
        body.method === "tools/list"
          ? { tools: [{ name: "get_report", description: "Read.", inputSchema: { type: "object" } }, { name: "activate", description: "Go live.", inputSchema: { type: "object" } }, { name: "peek", description: "Look.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }, { name: "wipe", description: "Remove.", inputSchema: { type: "object" }, annotations: { destructiveHint: true } }] }
          : { content: [{ type: "text", text: JSON.stringify({ got: body.params?.arguments, owner: "act_900100" }) }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { fetch: fetchImpl, seen };
};

/** A person who signs in at once: follow the page's way back with a code. */
const person = (code = "the-code") => async (address: string): Promise<void> => {
  const url = new URL(address);
  const back = new URL(url.searchParams.get("redirect_uri")!);
  back.searchParams.set("code", code);
  back.searchParams.set("state", url.searchParams.get("state")!);
  await fetch(back);
};

const spec = (extra: Partial<EnvironmentSpec> = {}): EnvironmentSpec => ({
  name: "shop-marketing",
  signIn: {
    kind: "authorization_code",
    clientId: "client-123",
    authorize: "https://platform.example/authorize",
    token: "https://platform.example/token",
  },
  scopes: { read: ["reports.read"], draft: ["ads.write"] },
  profile: "draft",
  resources: { api: { api: "https://api.platform.example/v1" } },
  vault: memoryVault(),
  discover: async () => [
    { kind: "business", id: "b1", name: "Acme" },
    { kind: "ad_account", id: "act_900100", name: "EU Store", parent: "business:b1", facts: { currency: "EUR" } },
    { kind: "page", id: "p7", name: "Acme Page", parent: "business:b1" },
  ],
  actions: {
    report: {
      description: "Read a report.",
      input: { account: "an ad account" },
      accounts: { account: "ad_account" },
      class: "read",
      run: async (_args, { accounts, connection }) => {
        const response = await connection.request("api", `reports/${accounts.account!.id}`);
        return { account: accounts.account!.alias, status: response.status };
      },
    },
    budget: {
      description: "Set a daily budget.",
      input: { account: "an ad account", amount: "the daily budget" },
      accounts: { account: "ad_account" },
      class: "spend",
      amount: (args) => Number(args.amount),
      run: async () => "set",
    },
    post: {
      description: "Publish a post.",
      input: { page: "a page", text: "what to say" },
      accounts: { page: "page" },
      class: "publish",
      run: async () => "posted",
    },
  },
  ...extra,
});

const connected = async (extra: Partial<EnvironmentSpec> = {}): Promise<{ env: Environment; root: string; seen: ReturnType<typeof platform>["seen"] }> => {
  const root = await folder();
  const there = platform();
  const env = environment(spec(extra));
  env.use({ root, fetch: there.fetch, env: {} });
  await env.connect({ open: person() });
  await env.sync();
  return { env, root, seen: there.seen };
};

const attempt = (env: Environment, tool: string, args: Record<string, unknown>, more: Partial<Attempt> = {}): Attempt => {
  const action = env.app!.functions![tool]!.action?.(args);
  return { agent: "app", tool, origin: "local", args, ...(action ? { action } : {}), ...more };
};

describe("an environment's sign-in", () => {
  it("asks the platform for what the install is for and keeps the answer in the vault only", async () => {
    const root = await folder();
    const there = platform();
    const vault = memoryVault();
    const env = environment(spec({ vault }));
    env.use({ root, fetch: there.fetch, env: {} });
    let page = "";
    const record = await env.connect({ open: async (address) => ((page = address), person()(address)) });

    const asked = new URL(page);
    expect(asked.searchParams.get("client_id")).toBe("client-123");
    expect(asked.searchParams.get("scope")).toBe("reports.read ads.write");
    expect(asked.searchParams.get("code_challenge_method")).toBe("S256");
    expect(there.seen[0]!.body).toContain("code=the-code");
    expect(there.seen[0]!.body).toContain("code_verifier=");
    expect(record.scopes).toEqual(["reports.read", "ads.write"]);
    expect(record.expiresAt).toBeGreaterThan(Date.now());
    expect(await vault.get("default")).toContain("secret-token-value");

    const dir = join(root, ".praecise", "environments", "shop-marketing");
    for (const name of await readdir(dir)) expect(await readFile(join(dir, name), "utf8")).not.toContain("secret-token-value");
  });

  it("refuses an answer that does not belong to the sign-in it started", async () => {
    const root = await folder();
    const env = environment(spec());
    env.use({ root, fetch: platform().fetch, env: {} });
    const forged = async (address: string): Promise<void> => {
      const back = new URL(new URL(address).searchParams.get("redirect_uri")!);
      back.searchParams.set("code", "x");
      back.searchParams.set("state", "not-the-state");
      await fetch(back);
    };
    await expect(env.connect({ open: forged })).rejects.toThrow(/does not belong/);
    expect(await env.connections()).toEqual([]);
  });

  it("says a sign-in has nowhere safe to go, off a Mac with no key", async () => {
    const sealed = fileVault(await folder(), secretCipher("a-long-enough-vault-key"));
    await sealed.put("one", "kept");
    expect(await sealed.get("one")).toBe("kept");
    await sealed.delete("one");
    expect(await sealed.get("one")).toBeUndefined();
    expect(() => secretCipher("short")).toThrow(/at least 16/);
  });
});

describe("an environment's accounts", () => {
  it("names what a sign-in reaches, children after their parent, all in read mode", async () => {
    const { env } = await connected();
    const all = await env.accounts();
    expect(all.map((each) => [each.alias, each.kind, each.mode])).toEqual([
      ["acme", "business", "read"],
      ["acme/eu-store", "ad_account", "read"],
      ["acme/acme-page", "page", "read"],
    ]);
    const listed = (await env.app!.functions!.shop_marketing_accounts!.run({}, {})) as Record<string, unknown>[];
    expect(JSON.stringify(listed)).not.toContain("act_900100");
    expect(listed[1]).toMatchObject({ name: "acme/eu-store", facts: { currency: "EUR" } });
  });

  it("keeps a name, a mode and limits across a sync", async () => {
    const { env } = await connected();
    await env.rename("acme/eu-store", "acme/ads-eu");
    await env.setMode("acme/ads-eu", "act");
    await env.setLimits("acme/ads-eu", { perDay: 500 });
    expect(await env.sync()).toMatchObject({ added: [], gone: [], total: 3 });
    expect((await env.accounts({ kind: "ad_account" }))[0]).toMatchObject({ alias: "acme/ads-eu", mode: "act", limits: { perDay: 500 } });
  });

  it("tells the platform when an account's mode changes, where the platform can hold it", async () => {
    const told: string[] = [];
    const { env } = await connected({ enforce: async (account) => void told.push(`${account.alias}:${account.mode}`) });
    await env.setMode("acme/eu-store", "draft");
    expect(told).toEqual(["acme/eu-store:draft"]);
  });
});

describe("an environment's actions", () => {
  it("find the account by its name and call the platform with the connection that reaches it", async () => {
    const { env, seen } = await connected();
    const said = await env.app!.functions!.report!.run({ account: "acme/eu-store" }, {});
    expect(said).toEqual({ account: "acme/eu-store", status: 200 });
    const call = seen.at(-1)!;
    expect(call.url).toBe("https://api.platform.example/v1/reports/act_900100");
    expect(call.authorization).toBe("Bearer secret-token-value");
  });

  it("refuse a name that is not an account, and a path that leaves the platform's API", async () => {
    const { env } = await connected({
      actions: {
        escape: { description: "x", class: "read", run: (_args, { connection }) => connection.request("api", "../../elsewhere") },
      },
    });
    await expect(env.app!.functions!.escape!.run({}, {})).rejects.toThrow(/is not under/);
    const whole = await connected();
    await expect(whole.env.app!.functions!.report!.run({ account: "act_900100" }, {})).rejects.toThrow(/is not the name of a ad_account/);
  });

  it("are handed the environment's own fetch when no app is calling", async () => {
    const { env, seen } = await connected({
      actions: { direct: { description: "x", class: "read", run: async (_args, { fetch: given }) => (await given!("https://api.platform.example/v1/direct")).status } },
    });
    expect(await env.app!.functions!.direct!.run({}, {})).toBe(200);
    expect(seen.at(-1)!.url).toBe("https://api.platform.example/v1/direct");
  });

  it("use only the connections of whoever the call is for", async () => {
    const { env } = await connected();
    await expect(env.app!.functions!.report!.run({ account: "acme/eu-store" }, { caller: { person: "someone-else" } })).rejects.toThrow(/Not connected/);
  });
});

describe("an environment's guard", () => {
  it("lets nothing but reading happen to an account in read mode", async () => {
    const { env } = await connected();
    const verdict = await env.authority!.check(attempt(env, "budget", { account: "acme/eu-store", amount: 20 }));
    expect(verdict).toMatchObject({ refuse: expect.stringMatching(/read mode and this needs act/) });
    await expect(env.app!.functions!.budget!.run({ account: "acme/eu-store", amount: 20 }, {})).rejects.toThrow(/read mode/);
    expect(await env.authority!.check(attempt(env, "report", { account: "acme/eu-store" }))).toEqual({ allow: true });
  });

  it("holds spending to the account's limits and asks a person above its threshold", async () => {
    const { env } = await connected();
    await env.setMode("acme/eu-store", "act");
    await env.setLimits("acme/eu-store", { perAction: 100, perDay: 150, approveAbove: 50 });

    expect(await env.authority!.check(attempt(env, "budget", { account: "acme/eu-store", amount: 500 }))).toMatchObject({
      refuse: expect.stringMatching(/over the limit of 100/),
    });
    expect(await env.authority!.check(attempt(env, "budget", { account: "acme/eu-store", amount: 40 }))).toEqual({ allow: true });

    const asked = await env.authority!.check(attempt(env, "budget", { account: "acme/eu-store", amount: 80 }));
    expect(asked).toMatchObject({ stepUp: expect.stringContaining("spend on acme/eu-store of 80") });
    const digest = (asked as { digest: string }).digest;
    const approved = attempt(env, "budget", { account: "acme/eu-store", amount: 80 }, {
      approvals: [{ digest, approver: "owner" } as never],
    });
    expect(await env.authority!.check(approved)).toEqual({ allow: true });

    await env.app!.functions!.budget!.run({ account: "acme/eu-store", amount: 80 }, {});
    expect(await env.authority!.check(attempt(env, "budget", { account: "acme/eu-store", amount: 80 }))).toMatchObject({
      refuse: expect.stringMatching(/150 a day/),
    });
  });

  it("asks a person before publishing, and after anything read from outside", async () => {
    const { env } = await connected();
    await env.setMode("acme/acme-page", "act");
    await env.setMode("acme/eu-store", "act");
    await env.setLimits("acme/eu-store", { approveAbove: 50 });
    expect(await env.authority!.check(attempt(env, "post", { page: "acme/acme-page", text: "hello" }))).toHaveProperty("stepUp");
    expect(await env.authority!.check(attempt(env, "budget", { account: "acme/eu-store", amount: 10 }, { tainted: true }))).toHaveProperty("stepUp");
  });

  it("is asked by the app with the app's own authority, the strictest answer standing", async () => {
    const root = await makeProject({
      "shop.ts": `import { environment, memoryVault } from "${FRAMEWORK}";
        export const shop = environment({
          name: "shop-marketing",
          signIn: { kind: "token", variable: "SHOP_TOKEN" },
          vault: memoryVault(),
          discover: async () => [{ kind: "page", id: "p7", name: "Acme Page" }],
          actions: { post: { description: "Publish.", input: { page: "a page" }, accounts: { page: "page" }, class: "publish", run: async () => "posted" } },
        });`,
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        import { shop } from "./shop.ts";
        export default defineConfig({ name: "acme", quality: "fast", ${TEST_ENDPOINT}, plugins: [shop] });`,
    });
    const env = { ...MODEL_ENV, SHOP_TOKEN: "service-token" };
    const app = await App.load({ root, env, authority: { check: () => ({ allow: true }) } });
    const shop = app.config.plugins![0] as Environment;
    await shop.connect();
    await shop.sync();

    await expect(app.callTool("post", { page: "acme-page" })).rejects.toThrow(/read mode/);
    await shop.setMode("acme-page", "act");
    await expect(app.callTool("post", { page: "acme-page" })).rejects.toBeInstanceOf(StepUpRequired);
    await app.close();
    await cleanup(root);
  });
});

describe("a platform's own tools, through an environment", () => {
  const server = { resources: { api: { api: "https://api.platform.example/v1" }, ads: { mcp: "https://mcp.platform.example/ads", classes: { get_report: "read" as const } } } };
  const calling = (env: Environment, tool: string, given: Record<string, unknown>): Promise<unknown> =>
    Promise.resolve(env.app!.functions!.shop_marketing_call!.run({ server: "ads", tool, arguments: JSON.stringify(given) }, {}));

  it("are listed with what each does: as the environment says, else as the server says, else publishing", async () => {
    const { env } = await connected(server);
    const tools = (await env.app!.functions!.shop_marketing_tools!.run({ server: "ads" }, {})) as { name: string; does: string }[];
    expect(tools.map((tool) => [tool.name, tool.does])).toEqual([["get_report", "read"], ["activate", "publish"], ["peek", "read"], ["wipe", "destroy"]]);
    // A tool the server calls read-only needs no account; one it calls destructive always needs a person.
    expect(await calling(env, "peek", {})).toContain("got");
    await env.setMode("acme/eu-store", "act");
    const wiping = attempt(env, "shop_marketing_call", { server: "ads", tool: "wipe", arguments: JSON.stringify({ account: "acme/eu-store" }) });
    expect(await env.authority!.check(wiping)).toHaveProperty("stepUp");
    await expect(calling(env, "nothing-here", {})).rejects.toThrow(/has no tool named/);
    // A tool that takes only something inside an account is told the account beside its arguments.
    const inside = { server: "ads", tool: "activate", arguments: JSON.stringify({ campaign: "c1" }), account: "acme/eu-store" };
    expect(await env.authority!.check(attempt(env, "shop_marketing_call", inside))).toHaveProperty("stepUp");
    expect(await env.app!.functions!.shop_marketing_call!.run(inside, {})).toContain('"campaign":"c1"');
  });

  it("can have a sign-in of their own, with the platform's own way of trading and renewing a token", async () => {
    const root = await folder();
    const there = platform();
    const traded: string[] = [];
    const env = environment(spec({
      resources: {
        api: { api: "https://api.platform.example/v1" },
        other: {
          api: "https://other.platform.example/v1",
          scopes: ["other.read"],
          signIn: {
            kind: "authorization_code",
            clientId: "other-client",
            authorize: "https://other.platform.example/authorize",
            token: "https://platform.example/token",
            after: async (grant) => (traded.push("after"), { access_token: `${grant.access_token}-lasting`, expiresAt: Date.now() + 30_000 }),
            renew: async (grant) => (traded.push("renew"), { access_token: `${grant.access_token}-renewed`, expiresAt: Date.now() + 86_400_000 }),
          },
        },
      },
      actions: { elsewhere: { description: "x", class: "read", run: async (_args, { connection }) => (await connection.request("other", "me")).status } },
    }));
    env.use({ root, fetch: there.fetch, env: {} });
    const pages: string[] = [];
    await env.connect({ open: async (address) => (pages.push(new URL(address).origin + new URL(address).pathname), person()(address)) });
    expect(pages).toEqual(["https://platform.example/authorize", "https://other.platform.example/authorize"]);
    // It expires within the minute, so the first use renews it the platform's way.
    await env.app!.functions!.elsewhere!.run({}, {});
    expect(traded).toEqual(["after", "renew"]);
    expect(there.seen.at(-1)!.authorization).toBe("Bearer secret-token-2-lasting-renewed");
  });

  it("are given the platform's id for a name, and answer with the name for an id", async () => {
    const { env, seen } = await connected(server);
    const said = (await calling(env, "get_report", { account: "acme/eu-store", nested: { of: ["acme/eu-store"] } })) as string;
    const sent = JSON.parse(seen.at(-1)!.body) as { params: { arguments: unknown } };
    expect(sent.params.arguments).toEqual({ account: "act_900100", nested: { of: ["act_900100"] } });
    expect(seen.at(-1)!.authorization).toBe("Bearer secret-token-value");
    expect(said).not.toContain("act_900100");
    expect(said).toContain("acme/eu-store");
  });

  it("refuse an id in place of a name, and a change that names no account or one not ready for it", async () => {
    const { env } = await connected(server);
    await expect(calling(env, "get_report", { account: "act_900100" })).rejects.toThrow(/name the account as "acme\/eu-store"/);
    await expect(calling(env, "activate", { campaign: "c1" })).rejects.toThrow(/names no account/);
    await expect(calling(env, "activate", { account: "acme/eu-store" })).rejects.toThrow(/read mode and activate needs act/);

    const args = { server: "ads", tool: "activate", arguments: JSON.stringify({ account: "acme/eu-store" }) };
    const asking = (): Attempt => attempt(env, "shop_marketing_call", args);
    expect(await env.authority!.check(asking())).toMatchObject({ refuse: expect.stringMatching(/read mode/) });
    await env.setMode("acme/eu-store", "act");
    expect(await env.authority!.check(asking())).toHaveProperty("stepUp");
    expect(await env.authority!.check(attempt(env, "shop_marketing_call", { server: "ads", tool: "activate", arguments: "{}" }))).toMatchObject({
      refuse: expect.stringMatching(/names no account/),
    });
  });

  it("are signed in to by themselves where the platform will not take the one sign-in", async () => {
    const { env, seen } = await connected({
      resources: { api: { api: "https://api.platform.example/v1" }, ads: { mcp: "https://mcp.platform.example/ads", separate: true, scopes: ["ads.tools"], classes: { get_report: "read" } } },
    });
    expect(seen.filter((each) => each.url === "https://platform.example/token")).toHaveLength(2);
    await calling(env, "get_report", {});
    expect(seen.at(-1)!.authorization).toBe("Bearer secret-token-2");
    await env.app!.functions!.report!.run({ account: "acme/eu-store" }, {});
    expect(seen.at(-1)!.authorization).toBe("Bearer secret-token-value");
  });
});

describe("an environment's intake", () => {
  const taking = (verified: boolean): Partial<EnvironmentSpec> => ({
    intake: {
      verify: () => verified,
      read: (payload) => [{ type: "comment", account: "p7", id: "d1", data: payload }],
      handshake: (url) => new Response(url.searchParams.get("challenge") ?? ""),
    },
  });
  const delivery = (): Request => new Request("https://app.example/in", { method: "POST", body: JSON.stringify({ text: "hello" }) });

  it("publishes what a verified delivery carried, under the account's name", async () => {
    const { env } = await connected(taking(true));
    const published: unknown[] = [];
    const response = await env.receive(delivery(), async (type, data, rest) => (published.push({ type, data, rest }), []));
    expect(response.status).toBe(200);
    expect(published).toEqual([{ type: "shop-marketing.comment", data: { text: "hello" }, rest: { subject: "acme/acme-page", id: "shop-marketing:d1" } }]);
    expect(await (await env.receive(new Request("https://app.example/in?challenge=42"), async () => [])).text()).toBe("42");
  });

  it("is served by the app at its own address, with no credential of the server's asked for", async () => {
    const root = await makeProject({
      "shop.ts": `import { environment, memoryVault } from "${FRAMEWORK}";
        export const shop = environment({
          name: "shop-marketing",
          signIn: { kind: "token", variable: "SHOP_TOKEN" },
          vault: memoryVault(),
          intake: { verify: (request) => request.headers.get("x-sign") === "good", read: (payload) => [{ type: "comment", data: payload }] },
        });`,
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        import { shop } from "./shop.ts";
        export default defineConfig({ name: "acme", quality: "fast", ${TEST_ENDPOINT}, plugins: [shop] });`,
    });
    const server = await serve({ root, port: 0, watch: false, token: "server-token", env: MODEL_ENV });
    const at = `http://localhost:${server.port}/environments/shop-marketing/intake`;
    const post = (sign: string): Promise<Response> => fetch(at, { method: "POST", headers: { "x-sign": sign, "content-type": "application/json" }, body: "{}" });
    expect((await post("bad")).status).toBe(401);
    expect((await post("good")).status).toBe(200);
    await server.close();
    await cleanup(root);
  });

  it("refuses a delivery it cannot verify and publishes nothing", async () => {
    const { env } = await connected(taking(false));
    let published = 0;
    const response = await env.receive(delivery(), async () => ((published += 1), []));
    expect(response.status).toBe(401);
    expect(published).toBe(0);
  });
});

describe("an environment's doctor", () => {
  it("says what is missing before a sign-in and nothing after one", async () => {
    const root = await folder();
    const env = environment(spec());
    env.use({ root, fetch: platform().fetch, env: {} });
    expect((await env.doctor()).filter((line) => !line.ok).map((line) => line.fix)).toContain("praecise shop-marketing connect");
    await env.connect({ open: person() });
    await env.sync();
    expect((await env.doctor()).filter((line) => !line.ok)).toEqual([]);
  });
});
