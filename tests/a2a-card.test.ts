/**
 * Signed agent cards.
 *
 * The property that matters is that a signature made here verifies anywhere, and that
 * comes down to both sides writing the card down the same way before signing it. So the
 * canonical form is tested against the specification's own worked example and against
 * RFC 8785's rules, and the signature against node's verifier used directly, with
 * nothing of this framework's in between.
 */

import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { KEY_DIRECTORY_PATH, keyDirectory, thumbprint } from "../src/botauth.js";
import { agentCard } from "../src/server/a2a.js";
import { cardPayload, cardSignerFor, fetchAgentCard, jcs, signAgentCard, verifyAgentCard } from "../src/server/a2a-card.js";
import { serve, type DevServer } from "../src/server/index.js";
import { MODEL_ENV, TEST_ENDPOINT, TEST_TOKEN, cleanup, FRAMEWORK, makeProject, stubModel } from "./helpers.js";

const roots: string[] = [];
const servers: DevServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map(cleanup));
});

async function project() {
  const root = await makeProject({
    "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
      export default defineConfig({ name: "acme", version: "2.1.0", ${TEST_ENDPOINT} });`,
    "agents/support.ts": `import { agent } from "${FRAMEWORK}";
      export default agent({ role: "Help.", description: "Answers questions.", effect: "read" });`,
  });
  roots.push(root);
  return root;
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwks = keyDirectory([privateKey]);

describe("the canonical form", () => {
  it("is RFC 8785: members sorted, no whitespace, numbers and strings as ECMAScript writes them", () => {
    expect(jcs({ b: 1, a: [true, null, "x"], "": 0 })).toBe('{"":0,"a":[true,null,"x"],"b":1}');
    // Sorted by UTF-16 code unit, which is not alphabetical once case and accents are involved.
    expect(jcs({ "\u20ac": 1, "\r": 2, a: 3, A: 4, "\u00f6": 5 })).toBe('{"\\r":2,"A":4,"a":3,"\u00f6":5,"\u20ac":1}');
    expect(jcs({ n: [1e21, 0.000001, 1.5, -0, 100] })).toBe('{"n":[1e+21,0.000001,1.5,0,100]}');
    expect(jcs("\u000f\n\"\\/")).toBe('"\\u000f\\n\\"\\\\/"');
    expect(() => jcs({ n: Number.NaN })).toThrow();
  });

  it("matches the specification's worked example of dropping defaults", () => {
    // Section 8.4.1: the required fields stay though empty, the optional ones stay
    // because they were set, and the empty list that is neither goes.
    const fragment = {
      name: "Example Agent",
      description: "",
      capabilities: { streaming: false, pushNotifications: false, extensions: [] },
      skills: [],
    };
    expect(cardPayload(fragment)).toBe(
      '{"capabilities":{"pushNotifications":false,"streaming":false},"description":"","name":"Example Agent","skills":[]}',
    );
  });

  it("does not depend on the signatures, on member order, or on defaults written out", () => {
    const card = {
      name: "A",
      description: "d",
      version: "1",
      supportedInterfaces: [{ url: "https://a.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" }],
      capabilities: { streaming: true },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [{ id: "s", name: "s", description: "d", tags: [], examples: [] }],
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    };
    const reordered = {
      skills: [{ tags: [], description: "d", name: "s", id: "s" }],
      signatures: [{ protected: "x", signature: "y" }],
      securityRequirements: [{ schemes: { bearer: {} } }],
      defaultOutputModes: ["text/plain"],
      defaultInputModes: ["text/plain"],
      capabilities: { streaming: true, extensions: [] },
      supportedInterfaces: [{ protocolVersion: "1.0", protocolBinding: "JSONRPC", url: "https://a.example/a2a" }],
      version: "1",
      description: "d",
      name: "A",
      provider: null,
    };
    expect(cardPayload(reordered)).toBe(cardPayload(card));
    // A field the table does not know is part of what is signed, not quietly dropped.
    expect(cardPayload({ ...card, somethingNew: "" })).not.toBe(cardPayload(card));
  });
});

describe("signing a card", () => {
  it("makes a JWS that node's own verifier accepts over the canonical card", async () => {
    const root = await project();
    const app = await App.load({ root, env: MODEL_ENV, fetch: stubModel([]).fetch });
    const card = agentCard(app, {}, "https://agents.example");
    const signed = signAgentCard(card, { privateKey, jku: "https://agents.example/keys.json" });
    await app.close();

    const [entry] = signed.signatures as { protected: string; signature: string }[];
    expect(JSON.parse(Buffer.from(entry!.protected, "base64url").toString())).toEqual({
      alg: "EdDSA",
      typ: "JOSE",
      kid: thumbprint(privateKey),
      jku: "https://agents.example/keys.json",
    });
    // RFC 7515: the signing input is the protected header, a dot, and the payload, each base64url.
    const input = `${entry!.protected}.${Buffer.from(cardPayload(signed)).toString("base64url")}`;
    expect(verify(null, Buffer.from(input), publicKey, Buffer.from(entry!.signature, "base64url"))).toBe(true);
    // And the card is otherwise as it was.
    const { signatures: _signatures, ...rest } = signed;
    expect(rest).toEqual(card);
  });

  it("verifies its own signature, and not a card that was changed after it was signed", () => {
    const card = { name: "A", description: "d", version: "1", capabilities: {}, skills: [], supportedInterfaces: [], defaultInputModes: [], defaultOutputModes: [] };
    const signed = signAgentCard(card, { privateKey });
    expect(verifyAgentCard(signed, jwks)).toMatchObject({ ok: true, kid: thumbprint(privateKey), alg: "EdDSA" });
    // Survives a round trip through another serialiser's member order.
    expect(verifyAgentCard(JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(signed).reverse()))), jwks).ok).toBe(true);

    expect(verifyAgentCard({ ...signed, description: "something else" }, jwks)).toMatchObject({ ok: false });
    expect(verifyAgentCard(card, jwks)).toEqual({ ok: false, reason: "the card carries no signatures" });
    // Somebody else's key set.
    const other = keyDirectory([generateKeyPairSync("ed25519").privateKey]);
    expect(verifyAgentCard(signed, other).ok).toBe(false);
  });

  it("keeps an earlier signature when a second key signs, so a key can be rotated", () => {
    const next = generateKeyPairSync("ed25519").privateKey;
    const card = { name: "A", description: "d", version: "1", capabilities: {}, skills: [], supportedInterfaces: [], defaultInputModes: [], defaultOutputModes: [] };
    const twice = signAgentCard(signAgentCard(card, { privateKey }), { privateKey: next });
    expect(twice.signatures).toHaveLength(2);
    expect(verifyAgentCard(twice, jwks).ok).toBe(true);
    expect(verifyAgentCard(twice, keyDirectory([next])).ok).toBe(true);
  });

  it("verifies ES256 and RS256 from other signers, and refuses alg none", () => {
    const card = { name: "A", description: "d", version: "1", capabilities: {}, skills: [], supportedInterfaces: [], defaultInputModes: [], defaultOutputModes: [] };
    const payload = Buffer.from(cardPayload(card)).toString("base64url");
    const by = (alg: string, kid: string, signature: Buffer) => ({
      ...card,
      signatures: [{ protected: Buffer.from(JSON.stringify({ alg, typ: "JOSE", kid })).toString("base64url"), signature: signature.toString("base64url") }],
    });
    const header = (alg: string, kid: string) => Buffer.from(JSON.stringify({ alg, typ: "JOSE", kid })).toString("base64url");

    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const ecJwk = { ...ec.publicKey.export({ format: "jwk" }), kid: "ec-1" };
    const ecSig = sign("sha256", Buffer.from(`${header("ES256", "ec-1")}.${payload}`), { key: ec.privateKey, dsaEncoding: "ieee-p1363" });
    expect(verifyAgentCard(by("ES256", "ec-1", ecSig), { keys: [ecJwk] })).toMatchObject({ ok: true, alg: "ES256" });

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaJwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "rsa-1" };
    const rsaSig = sign("sha256", Buffer.from(`${header("RS256", "rsa-1")}.${payload}`), rsa.privateKey);
    expect(verifyAgentCard(by("RS256", "rsa-1", rsaSig), { keys: [rsaJwk] })).toMatchObject({ ok: true, alg: "RS256" });

    // An algorithm that does not belong to the key it names is not tried with it.
    expect(verifyAgentCard(by("RS256", "ec-1", rsaSig), { keys: [ecJwk] }).ok).toBe(false);
    expect(verifyAgentCard(by("none", "ec-1", Buffer.alloc(0)), { keys: [ecJwk] }).ok).toBe(false);
  });
});

describe("a peer's card", () => {
  const card = { name: "Peer", description: "d", version: "1", capabilities: {}, skills: [], supportedInterfaces: [], defaultInputModes: [], defaultOutputModes: [] };

  /** A peer that serves a card, and key sets at the addresses given. */
  function peer(served: unknown, keySets: Record<string, unknown> = {}) {
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      if (url.endsWith("/.well-known/agent-card.json")) return Response.json(served);
      return url in keySets ? Response.json(keySets[url]) : new Response("", { status: 404 });
    }) as typeof fetch;
    return { asked, fetchImpl };
  }
  const publicNames = { resolve: async () => ["93.184.216.34"] };

  it("is verified against keys already held, without fetching any", async () => {
    const signed = signAgentCard(card, { privateKey, jku: "https://elsewhere.example/keys" });
    const { asked, fetchImpl } = peer(signed);
    const fetched = await fetchAgentCard("https://peer.example/a2a", { fetch: fetchImpl, keys: jwks });
    expect(fetched.verified).toMatchObject({ from: "held", kid: thumbprint(privateKey) });
    expect(asked).toEqual(["https://peer.example/.well-known/agent-card.json"]);
  });

  it("is verified against the key set it names, when that is somewhere the caller trusts", async () => {
    const signed = signAgentCard(card, { privateKey, jku: "https://keys.example/set.json" });
    const { fetchImpl } = peer(signed, { "https://keys.example/set.json": jwks });

    const untrusted = await fetchAgentCard("https://peer.example", { fetch: fetchImpl, ...publicNames });
    expect(untrusted.verified).toBeUndefined();
    expect(untrusted.unverified).toContain("not an origin this caller trusts");

    const trusted = await fetchAgentCard("https://peer.example", { fetch: fetchImpl, trust: ["https://keys.example"], ...publicNames });
    expect(trusted.verified).toMatchObject({ from: "jku", jku: "https://keys.example/set.json" });
  });

  it("does not follow a key set address into a private network", async () => {
    const signed = signAgentCard(card, { privateKey, jku: "https://peer.example/keys" });
    const { asked, fetchImpl } = peer(signed, { "https://peer.example/keys": jwks });
    const fetched = await fetchAgentCard("https://peer.example", { fetch: fetchImpl, resolve: async () => ["10.0.0.5"] });
    expect(fetched.verified).toBeUndefined();
    expect(fetched.unverified).toContain("private");
    expect(asked).toHaveLength(1);
  });

  it("returns an unsigned card marked as such, or refuses it where the caller requires a signature", async () => {
    const { fetchImpl } = peer(card);
    const fetched = await fetchAgentCard("https://peer.example", { fetch: fetchImpl });
    expect(fetched.card.name).toBe("Peer");
    expect(fetched.unverified).toBe("the card carries no signatures");
    await expect(fetchAgentCard("https://peer.example", { fetch: fetchImpl, unsigned: "refuse" })).rejects.toThrow(/no signatures/);

    // Signed, and then altered on the way.
    const altered = { ...signAgentCard(card, { privateKey }), name: "Impostor" };
    await expect(fetchAgentCard("https://peer.example", { fetch: peer(altered).fetchImpl, keys: jwks, unsigned: "refuse" })).rejects.toThrow();
  });
});

describe("the dev server", () => {
  it("serves its card signed with the key it signs requests with, findable in its own key directory", async () => {
    const root = await project();
    const botAuth = { privateKey, agent: "https://agents.example" };
    const server = await serve({ root, port: 0, watch: false, token: TEST_TOKEN, env: MODEL_ENV, fetch: stubModel([]).fetch, botAuth });
    servers.push(server);
    const at = `http://localhost:${server.port}`;

    const card = (await (await fetch(`${at}/.well-known/agent-card.json`)).json()) as Record<string, unknown>;
    const directory = (await (await fetch(`${at}${KEY_DIRECTORY_PATH}`)).json()) as { keys: JsonWebKey[] };
    expect(verifyAgentCard(card, directory)).toMatchObject({ ok: true, jku: `https://agents.example${KEY_DIRECTORY_PATH}` });
    expect(cardSignerFor(botAuth).jku).toBe(`https://agents.example${KEY_DIRECTORY_PATH}`);
    // The public half only.
    expect(createPublicKey({ key: directory.keys[0]!, format: "jwk" }).type).toBe("public");

    // A 0.3 client is given the card it can read, which is not the shape a signature is defined over.
    const legacy = (await (await fetch(`${at}/.well-known/agent-card.json`, { headers: { "a2a-version": "0.3" } })).json()) as Record<string, unknown>;
    expect(legacy.signatures).toBeUndefined();
  });

  it("serves an unsigned card when the app has no key", async () => {
    const root = await project();
    const server = await serve({ root, port: 0, watch: false, token: TEST_TOKEN, env: MODEL_ENV, fetch: stubModel([]).fetch });
    servers.push(server);
    const card = (await (await fetch(`http://localhost:${server.port}/.well-known/agent-card.json`)).json()) as Record<string, unknown>;
    expect(card.signatures).toBeUndefined();
  });
});
