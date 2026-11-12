/**
 * Web Bot Auth: a request that says who sent it in a way the receiver can check, and a
 * check that refuses everything it should.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  KEY_DIRECTORY_PATH,
  KEY_DIRECTORY_TYPE,
  keyDirectory,
  signatureBase,
  signingFetch,
  thumbprint,
  verifySignature,
} from "../src/botauth.js";
import type { Payer } from "../src/payments.js";
import { serve } from "../src/server/index.js";
import { FRAMEWORK, MODEL_ENV, TEST_ENDPOINT, TEST_TOKEN, cleanup, makeProject } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(cleanup)));

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const directory = keyDirectory([publicKey]);
const AGENT = "https://agent.example";
/** A fixed instant, so `created` and `expires` are known. */
const T = 1_700_000_000;
const clock = () => T * 1000;

interface Sent {
  url: string;
  headers: Headers;
}

/** A server that answers everything and keeps what it was sent. */
function recorder(): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (input, init) => {
      sent.push({ url: input instanceof Request ? input.url : String(input), headers: new Headers(init?.headers) });
      return new Response("{}", { status: 200 });
    },
  };
}

async function signedRequest(url = "https://api.example/v1/things"): Promise<Sent> {
  const { fetch: base, sent } = recorder();
  await signingFetch(base, { privateKey, agent: AGENT, now: clock })(url, { headers: { accept: "application/json" } });
  return sent[0]!;
}

describe("the key an agent is known by", () => {
  it("has the RFC 7638 thumbprint of its public half", () => {
    // The key and thumbprint of RFC 8037, appendix A.
    const jwk = { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" };
    expect(thumbprint(jwk)).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
    expect(thumbprint({ ...jwk, d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A" })).toBe(thumbprint(jwk));
  });

  it("is published as a JWKS that never carries the private half", () => {
    const body = keyDirectory([privateKey, privateKey.export({ format: "jwk" })]);
    expect(body.keys).toHaveLength(2);
    for (const key of body.keys) {
      expect(Object.keys(key).sort()).toEqual(["crv", "kty", "x"]);
      expect(key).toEqual(directory.keys[0]);
    }
  });

  it("must be Ed25519, and the agent an https URL", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(() => signingFetch(fetch, { privateKey: rsa, agent: AGENT })).toThrow(/Ed25519/);
    expect(() => signingFetch(fetch, { privateKey: publicKey, agent: AGENT })).toThrow(/private half/);
    expect(() => signingFetch(fetch, { privateKey, agent: "http://agent.example" })).toThrow(/https URL/);
    expect(() => signingFetch(fetch, { privateKey, agent: "agent.example" })).toThrow(/https URL/);
  });
});

describe("the signature base", () => {
  it("is one line per covered component and then the parameters, exactly", () => {
    const { base, input } = signatureBase("api.example", AGENT, {
      created: 1700000000,
      expires: 1700000060,
      keyid: "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k",
      nonce: "bm9uY2U=",
    });
    expect(base).toBe(
      '"@authority": api.example\n' +
        '"signature-agent";key="sig1": "https://agent.example"\n' +
        '"@signature-params": ("@authority" "signature-agent";key="sig1");created=1700000000;expires=1700000060' +
        ';keyid="kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k";alg="ed25519";tag="web-bot-auth";nonce="bm9uY2U="',
    );
    expect(base.endsWith(input)).toBe(true);
  });
});

describe("a signing fetch", () => {
  it("adds the three headers and keeps the caller's own", async () => {
    const { headers } = await signedRequest();
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("signature-agent")).toBe('sig1="https://agent.example"');
    expect(headers.get("signature")).toMatch(/^sig1=:[A-Za-z0-9+/]{86}==:$/);

    const input = headers.get("signature-input")!;
    expect(input.startsWith('sig1=("@authority" "signature-agent";key="sig1");')).toBe(true);
    expect(input).toContain(`;created=${T};expires=${T + 60};keyid="${thumbprint(publicKey)}";alg="ed25519";tag="web-bot-auth";nonce="`);
  });

  it("honours the ttl and gives every request its own nonce", async () => {
    const { fetch: base, sent } = recorder();
    const signing = signingFetch(base, { privateKey: privateKey.export({ format: "jwk" }), agent: AGENT, ttlSeconds: 10, now: clock });
    await signing("https://api.example/a");
    await signing(new Request("https://api.example/b", { headers: { "x-own": "kept" } }));

    const results = sent.map((request) => verifySignature(request, directory, { now: clock }));
    expect(results).toMatchObject([
      { ok: true, expires: T + 10 },
      { ok: true, expires: T + 10 },
    ]);
    expect(sent[1]!.headers.get("x-own")).toBe("kept");
    const nonces = results.map((result) => (result.ok ? result.nonce : undefined));
    expect(nonces[0]).toBeTruthy();
    expect(nonces[0]).not.toBe(nonces[1]);
  });
});

describe("verifying", () => {
  it("accepts what the signing fetch sent", async () => {
    const request = await signedRequest("https://API.example:443/v1/things");
    expect(verifySignature(request, directory, { now: clock })).toEqual({
      ok: true,
      keyid: thumbprint(publicKey),
      agent: AGENT,
      created: T,
      expires: T + 60,
      nonce: expect.any(String),
    });
    // The way a Node server holds a request: a relative path, and headers as a plain object.
    const headers = { ...Object.fromEntries(request.headers), host: "api.example" };
    expect(verifySignature({ headers }, directory, { now: clock })).toMatchObject({ ok: true });
  });

  it("refuses a request replayed at another host", async () => {
    const { headers } = await signedRequest();
    const result = verifySignature({ url: "https://other.example/v1/things", headers }, directory, { now: clock });
    expect(result).toEqual({ ok: false, reason: "the signature does not match the request" });
  });

  it("refuses a Signature-Agent swapped after signing", async () => {
    const { url, headers } = await signedRequest();
    headers.set("signature-agent", 'sig1="https://impostor.example"');
    expect(verifySignature({ url, headers }, directory, { now: clock })).toMatchObject({ ok: false });
  });

  it("refuses an expired signature", async () => {
    const request = await signedRequest();
    expect(verifySignature(request, directory, { now: () => (T + 59) * 1000 })).toMatchObject({ ok: true });
    const result = verifySignature(request, directory, { now: () => (T + 60) * 1000 });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
  });

  it("refuses a signature made for another purpose", () => {
    // Correctly signed by the right key, under a different tag.
    const { base, input } = signatureBase("api.example", AGENT, {
      created: T,
      expires: T + 60,
      keyid: thumbprint(publicKey),
      nonce: "bm9uY2U=",
      tag: "something-else",
    });
    const headers = {
      "signature-agent": `sig1="${AGENT}"`,
      "signature-input": `sig1=${input}`,
      signature: `sig1=:${sign(null, Buffer.from(base), privateKey).toString("base64")}:`,
    };
    const result = verifySignature({ url: "https://api.example/", headers }, directory, { now: clock });
    expect(result).toEqual({ ok: false, reason: 'no signature on the request is tagged "web-bot-auth"' });
  });

  it("refuses a key the directory does not hold", async () => {
    const request = await signedRequest();
    const other = keyDirectory([generateKeyPairSync("ed25519").publicKey]);
    const result = verifySignature(request, other, { now: clock });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/no key in the directory/) });
  });

  it("refuses an unsigned request", () => {
    const result = verifySignature({ url: "https://api.example/", headers: new Headers() }, directory);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/no Signature-Input/) });
  });
});

describe("an app with botAuth", () => {
  async function project(): Promise<string> {
    const root = await makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({ name: "acme", ${TEST_ENDPOINT} });`,
      "functions/report.ts": `import { fn } from "${FRAMEWORK}";
        export default fn({
          description: "Fetch the report.",
          effect: "read",
          run: async (_args, opts) => (await opts.fetch("https://api.example/report")).json(),
        });`,
      "workflows/report.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({ description: "Report.", steps: [{ id: "report", use: "report" }] });`,
    });
    roots.push(root);
    return root;
  }

  it("signs a tool's outbound request, the paid retry included, and serves the key directory", async () => {
    const sent: Sent[] = [];
    // Wants payment first, so the request goes out twice through the same seam.
    const upstream: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      sent.push({ url: String(input), headers });
      return headers.has("x-payment")
        ? new Response(JSON.stringify({ data: "ok" }), { status: 200 })
        : new Response("pay me", { status: 402 });
    };
    const payer: Payer = {
      pay: async () => ({ headers: { "x-payment": "receipt" } }),
      status: async () => ({ state: "absent" }),
    };

    const server = await serve({
      root: await project(),
      port: 0,
      watch: false,
      env: MODEL_ENV,
      token: TEST_TOKEN,
      fetch: upstream,
      payer,
      botAuth: { privateKey, agent: AGENT },
    });
    try {
      const run = await server.app().startWorkflow("report", {});
      expect(run.status).toBe("done");
      expect(run.outputs.report).toEqual({ data: "ok" });

      const res = await fetch(`http://127.0.0.1:${server.port}${KEY_DIRECTORY_PATH}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(KEY_DIRECTORY_TYPE);
      expect(res.headers.get("etag")).toBeTruthy();
      const served = (await res.json()) as typeof directory;
      expect(served).toEqual(directory);

      // Checked against the directory as served, which is what a receiver would hold.
      expect(sent.map((request) => request.url)).toEqual(["https://api.example/report", "https://api.example/report"]);
      const results = sent.map((request) => verifySignature(request, served));
      expect(results).toMatchObject([
        { ok: true, agent: AGENT },
        { ok: true, agent: AGENT },
      ]);
      expect(sent[1]!.headers.get("x-payment")).toBe("receipt");
      expect(sent[0]!.headers.get("signature")).not.toBe(sent[1]!.headers.get("signature"));
    } finally {
      await server.close();
    }
  });

  it("signs nothing and serves no directory unless botAuth is passed", async () => {
    const { fetch: upstream, sent } = recorder();
    const server = await serve({ root: await project(), port: 0, watch: false, env: MODEL_ENV, token: TEST_TOKEN, fetch: upstream });
    try {
      expect((await server.app().startWorkflow("report", {})).status).toBe("done");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.headers.has("signature")).toBe(false);
      const res = await fetch(`http://127.0.0.1:${server.port}${KEY_DIRECTORY_PATH}`);
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
