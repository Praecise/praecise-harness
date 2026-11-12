/**
 * The two grants that need nobody at a keyboard: client credentials, and enterprise-
 * managed authorization (an identity assertion exchanged for a grant, the grant for a
 * token).
 *
 * Both hold long-lived secrets, which is what makes the quiet failures here expensive: a
 * secret sent to whichever authorization server a resource happened to name, a secret
 * echoed in an error that ends up in a log, a token minted with no audience, an identity
 * provider's ordinary token passed on as a grant.
 */
import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";

import { describe, expect, test } from "vitest";

import type { ResolvedService } from "../src/compile/services.js";
import { resolveServices } from "../src/compile/services.js";
import { McpClient, clientCapabilities } from "../src/harness/mcp.js";
import {
  OAuthClient,
  authorizerFor,
  clientAssertion,
  type AuthorizationServerMetadata,
  type MachineGrant,
} from "../src/harness/oauth.js";

const ISSUER = "https://as.test";
const RESOURCE = "https://mcp.test/mcp";
const SECRET = "s3cr3t-do-not-log";

const metadata = (over: Partial<AuthorizationServerMetadata> = {}): AuthorizationServerMetadata =>
  ({ issuer: ISSUER, token_endpoint: `${ISSUER}/token`, ...over }) as AuthorizationServerMetadata;

interface Sent {
  url: string;
  form: Record<string, string>;
  headers: Record<string, string>;
}

/**
 * A resource, its authorization server and an identity provider, behind one fetch.
 * `token` and `idp` answer the two token endpoints; everything sent to either is kept.
 */
function world(
  opts: {
    server?: Partial<AuthorizationServerMetadata>;
    servers?: string[];
    token?: (form: Record<string, string>) => { status?: number; body: unknown };
    idp?: (form: Record<string, string>) => { status?: number; body: unknown };
  } = {},
) {
  const sent: Sent[] = [];
  const rpc: { method: string; authorization?: string; capabilities: unknown }[] = [];
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    if (url === "https://mcp.test/.well-known/oauth-protected-resource") {
      return json({ resource: RESOURCE, authorization_servers: opts.servers ?? [ISSUER] });
    }
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) return json(metadata(opts.server));
    if (url === "https://evil.test/.well-known/oauth-authorization-server") {
      return json({ issuer: "https://evil.test", token_endpoint: "https://evil.test/token" });
    }
    if (url === `${ISSUER}/token` || url === "https://idp.test/token" || url === "https://evil.test/token") {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      sent.push({ url, form, headers });
      const answer: { status?: number; body: unknown } =
        url === "https://idp.test/token"
          ? (opts.idp ?? (() => ({ body: { issued_token_type: "urn:ietf:params:oauth:token-type:id-jag", access_token: "the-id-jag", token_type: "N_A", expires_in: 300 } })))(form)
          : (opts.token ?? (() => ({ body: { access_token: "good-token", token_type: "Bearer", expires_in: 3600 } })))(form);
      return json(answer.body, answer.status ?? 200);
    }
    if (url === RESOURCE) {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: { _meta: Record<string, unknown> } };
      rpc.push({ method: body.method, authorization: headers.authorization, capabilities: body.params._meta["io.modelcontextprotocol/clientCapabilities"] });
      if (headers.authorization !== "Bearer good-token") {
        return new Response("", {
          status: 401,
          headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource", scope="mcp:read"' },
        });
      }
      return json({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", tools: [] } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, sent, rpc, oauth: new OAuthClient({ fetch: fetchImpl, redirectUri: "http://127.0.0.1/unused" }) };
}

const client = (secret?: string) => ({ client_id: "my-service", ...(secret ? { client_secret: secret } : {}), issuer: ISSUER });

/** A JWT taken apart, with its signature checked against a public key. */
function read(jwt: string, key: KeyObject, es256 = false) {
  const [head, body, signature] = jwt.split(".") as [string, string, string];
  const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, any>;
  const data = Buffer.from(`${head}.${body}`, "utf8");
  const sig = Buffer.from(signature, "base64url");
  const header = decode(head);
  const valid =
    header.alg === "EdDSA"
      ? verify(null, data, key, sig)
      : verify("sha256", data, es256 ? { key, dsaEncoding: "ieee-p1363" } : key, sig);
  return { header, claims: decode(body), valid };
}

describe("the client credentials grant", () => {
  test("a secret goes in the body, with the resource the token is for and the scope asked", async () => {
    const { oauth, sent } = world();
    const tokens = await oauth.clientCredentials({ server: metadata(), client: client(SECRET), resource: `${RESOURCE}#frag`, scope: ["mcp:read", "mcp:write"] });

    expect(tokens.access_token).toBe("good-token");
    expect(sent[0]!.form).toEqual({
      grant_type: "client_credentials",
      resource: RESOURCE,
      scope: "mcp:read mcp:write",
      client_id: "my-service",
      client_secret: SECRET,
    });
    expect(sent[0]!.headers.authorization).toBeUndefined();
  });

  test("a server that takes HTTP Basic and not the body form is sent Basic", async () => {
    const { oauth, sent } = world();
    await oauth.clientCredentials({
      server: metadata({ token_endpoint_auth_methods_supported: ["client_secret_basic", "private_key_jwt"] }),
      client: { client_id: "my service", client_secret: "p@ss:word", issuer: ISSUER },
      resource: RESOURCE,
    });
    // Each half form-encoded, then the pair base64-encoded.
    expect(Buffer.from(sent[0]!.headers.authorization!.slice("Basic ".length), "base64").toString()).toBe("my%20service:p%40ss%3Aword");
    expect(sent[0]!.form.client_secret).toBeUndefined();
    expect(sent[0]!.form.client_id).toBeUndefined();
  });

  test("an assertion stands in for the secret, and the client id is left to its subject", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const { oauth, sent } = world();
    const assertion = clientAssertion({ clientId: "my-service", audience: ISSUER, key: privateKey });
    await oauth.clientCredentials({ server: metadata(), client: client(SECRET), assertion, resource: RESOURCE });

    expect(sent[0]!.form).toEqual({
      grant_type: "client_credentials",
      resource: RESOURCE,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    });
  });

  test("with nothing to prove itself by, nothing is sent", async () => {
    const { oauth, sent } = world();
    await expect(oauth.clientCredentials({ server: metadata(), client: client(), resource: RESOURCE })).rejects.toThrow(
      /needs something to prove "my-service" with/,
    );
    expect(sent).toEqual([]);
  });

  test("credentials issued by one authorization server are not presented to another", async () => {
    const { oauth, sent } = world();
    await expect(
      oauth.clientCredentials({ server: metadata({ issuer: "https://other.test" }), client: client(SECRET), resource: RESOURCE }),
    ).rejects.toThrow(/must not be presented to "https:\/\/other.test"/);
    expect(sent).toEqual([]);
  });

  test("a refusal is reported in the server's words, and never with what was sent", async () => {
    const { oauth } = world({ token: () => ({ status: 401, body: { error: "invalid_client", error_description: "unknown client" } }) });
    const failure = (await oauth.clientCredentials({ server: metadata(), client: client(SECRET), resource: RESOURCE }).catch((err: unknown) => err)) as Error;
    expect(failure.message).toContain("invalid_client — unknown client");
    expect(failure.message).not.toContain(SECRET);
  });
});

describe("a client assertion", () => {
  test.each([
    ["RS256", () => generateKeyPairSync("rsa", { modulusLength: 2048 }), false],
    ["ES256", () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }), true],
    ["EdDSA", () => generateKeyPairSync("ed25519"), false],
  ] as const)("is signed %s by the key it was given, and says who, to whom, for how long", (alg, make, es256) => {
    const { privateKey, publicKey } = make();
    const now = 1_800_000_000_000;
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const jwt = clientAssertion({ clientId: "my-service", audience: ISSUER, key: pem, kid: "k1", now });
    const { header, claims, valid } = read(jwt, publicKey, es256);

    expect(valid).toBe(true);
    expect(header).toEqual({ alg, typ: "JWT", kid: "k1" });
    expect(claims).toMatchObject({ iss: "my-service", sub: "my-service", aud: ISSUER, iat: now / 1000, exp: now / 1000 + 300 });
    expect(typeof claims.jti).toBe("string");
    // A different id every time, so one that is overheard cannot be presented again.
    expect(read(clientAssertion({ clientId: "my-service", audience: ISSUER, key: pem, now }), publicKey, es256).claims.jti).not.toBe(claims.jti);
  });

  test("a key of a kind no assertion is signed with is refused by name", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    expect(() => clientAssertion({ clientId: "c", audience: ISSUER, key: privateKey })).toThrow(/RSA, P-256 or Ed25519.*secp384r1/);
  });

  test("something that is not a key is refused without being repeated", () => {
    expect(() => clientAssertion({ clientId: "c", audience: ISSUER, key: "hunter2-not-a-pem" })).toThrow(
      "the key for a client assertion is not a private key in PEM form",
    );
    try {
      clientAssertion({ clientId: "c", audience: ISSUER, key: "hunter2-not-a-pem" });
    } catch (err) {
      expect((err as Error).message).not.toContain("hunter2");
    }
  });
});

describe("enterprise-managed authorization", () => {
  test("the sign-in is exchanged for a grant addressed to the MCP server's authorization server", async () => {
    const { oauth, sent } = world();
    const exchanged = await oauth.exchangeIdentity({
      tokenEndpoint: "https://idp.test/token",
      assertion: "the-id-token",
      audience: ISSUER,
      resource: RESOURCE,
      scope: ["chat.read"],
      clientId: "idp-client",
      clientSecret: SECRET,
    });

    expect(exchanged).toEqual({ grant: "the-id-jag", expiresIn: 300 });
    expect(sent[0]!.url).toBe("https://idp.test/token");
    expect(sent[0]!.form).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
      audience: ISSUER,
      resource: RESOURCE,
      scope: "chat.read",
      subject_token: "the-id-token",
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      client_id: "idp-client",
      client_secret: SECRET,
    });
  });

  test("an identity provider that answers with an ordinary token has not issued a grant", async () => {
    const { oauth } = world({ idp: () => ({ body: { access_token: "just-a-token", token_type: "Bearer", issued_token_type: "urn:ietf:params:oauth:token-type:access_token" } }) });
    const failure = (await oauth
      .exchangeIdentity({ tokenEndpoint: "https://idp.test/token", assertion: "the-id-token", audience: ISSUER })
      .catch((err: unknown) => err)) as Error;
    expect(failure.message).toContain("did not issue an identity assertion grant");
    expect(failure.message).toContain("idp.test");
    expect(failure.message).not.toContain("the-id-token");
  });

  test("policy saying no is the identity provider's reason, passed on", async () => {
    const { oauth } = world({ idp: () => ({ status: 400, body: { error: "access_denied", error_description: "not assigned to this app" } }) });
    await expect(
      oauth.exchangeIdentity({ tokenEndpoint: "https://idp.test/token", assertion: "the-id-token", audience: ISSUER }),
    ).rejects.toThrow(/identity provider at idp.test failed \(400\): access_denied — not assigned to this app/);
  });

  test("the grant is redeemed as a JWT bearer grant, with no resource of its own to disagree with it", async () => {
    const { oauth, sent } = world();
    const tokens = await oauth.redeemGrant({ server: metadata(), client: client(SECRET), grant: "the-id-jag" });
    expect(tokens.access_token).toBe("good-token");
    expect(sent[0]!.form).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: "the-id-jag",
      client_id: "my-service",
      client_secret: SECRET,
    });
  });

  test("an authorization server says whether it takes one", () => {
    expect(OAuthClient.acceptsIdJag(metadata())).toBe(false);
    expect(OAuthClient.acceptsIdJag(metadata({ authorization_grant_profiles_supported: ["urn:ietf:params:oauth:grant-profile:id-jag"] }))).toBe(true);
  });
});

describe("discovery for a grant with no redirect", () => {
  test("a token endpoint is enough, where the interactive flow needs an authorization endpoint too", async () => {
    const { oauth } = world();
    const found = await oauth.discover(RESOURCE, undefined, { machine: true });
    expect(found.server.token_endpoint).toBe(`${ISSUER}/token`);
    await expect(oauth.discover(RESOURCE)).rejects.toThrow(/missing an authorization or token endpoint/);
  });

  test("only the pinned issuer is asked, and a resource that does not name it is refused", async () => {
    const elsewhere = world({ servers: ["https://evil.test"] });
    await expect(elsewhere.oauth.discover(RESOURCE, undefined, { issuer: ISSUER, machine: true })).rejects.toThrow(
      /does not name "https:\/\/as.test" as an authorization server \(it names: https:\/\/evil.test\)/,
    );
    const both = world({ servers: ["https://evil.test", ISSUER] });
    expect((await both.oauth.discover(RESOURCE, undefined, { issuer: ISSUER, machine: true })).server.issuer).toBe(ISSUER);
  });
});

describe("a service configured with a grant finds its own way to a token", () => {
  const service = (oauth: MachineGrant): ResolvedService =>
    ({ name: "svc", url: RESOURCE, credential: "SVC_API_KEY", auth: "bearer", oauth }) as ResolvedService;
  const CREDENTIALS: MachineGrant = { grant: "client_credentials", issuer: ISSUER, clientId: "my-service", clientSecret: SECRET, scope: ["mcp:tools"] };

  test("a refusal starts the grant, and the request is made again with the token", async () => {
    const { fetchImpl, sent, rpc } = world();
    const mcp = new McpClient(service(CREDENTIALS), fetchImpl);

    expect(await mcp.listTools()).toEqual([]);

    expect(rpc.map((call) => call.authorization)).toEqual([undefined, "Bearer good-token"]);
    expect(sent).toHaveLength(1);
    // What the service always asks for, joined with what the server asked for this time.
    expect(sent[0]!.form).toMatchObject({ grant_type: "client_credentials", resource: RESOURCE, scope: "mcp:tools mcp:read" });

    // The token is kept: the next request needs no grant.
    await mcp.listTools();
    expect(sent).toHaveLength(1);
    expect(rpc.at(-1)!.authorization).toBe("Bearer good-token");
  });

  test("the extension is declared by a client that is using it, and by no other", async () => {
    const { fetchImpl, rpc } = world();
    await new McpClient(service(CREDENTIALS), fetchImpl).listTools();
    expect(rpc[0]!.capabilities).toEqual({
      extensions: { "io.modelcontextprotocol/tasks": {}, "io.modelcontextprotocol/oauth-client-credentials": {} },
    });
    expect(clientCapabilities({}, "id-jag").extensions).toEqual({
      "io.modelcontextprotocol/tasks": {},
      "io.modelcontextprotocol/enterprise-managed-authorization": {},
    });
    expect(clientCapabilities().extensions).toEqual({ "io.modelcontextprotocol/tasks": {} });
  });

  test("a resource that points at another authorization server is not sent the secret", async () => {
    const { fetchImpl, sent } = world({ servers: ["https://evil.test"] });
    const failure = (await new McpClient(service(CREDENTIALS), fetchImpl).listTools().catch((err: unknown) => err)) as Error;
    expect(failure.message).toContain('does not name "https://as.test"');
    expect(failure.message).not.toContain(SECRET);
    expect(sent).toEqual([]);
  });

  test("with a key, an assertion addressed to the issuer is signed and no secret is sent", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const { fetchImpl, sent } = world();
    const authorize = authorizerFor(
      { grant: "client_credentials", issuer: ISSUER, clientId: "my-service", key: privateKey.export({ type: "pkcs8", format: "pem" }) as string, kid: "k1" },
      fetchImpl,
    );
    expect(await authorize({ resource: RESOURCE })).toBe("good-token");
    const { claims, valid, header } = read(sent[0]!.form.client_assertion!, publicKey, true);
    expect(valid).toBe(true);
    expect(header.kid).toBe("k1");
    expect(claims).toMatchObject({ iss: "my-service", sub: "my-service", aud: ISSUER });
    expect(sent[0]!.form.client_secret).toBeUndefined();
  });

  const ID_JAG: MachineGrant = {
    grant: "id-jag",
    issuer: ISSUER,
    clientId: "my-service",
    clientSecret: SECRET,
    idp: "https://idp.test/token",
    assertion: "the-id-token",
    idpClientId: "idp-client",
    idpClientSecret: "idp-secret",
  };

  test("an identity grant is two exchanges and no redirect", async () => {
    const { fetchImpl, sent, rpc } = world({ server: { authorization_grant_profiles_supported: ["urn:ietf:params:oauth:grant-profile:id-jag"] } });
    await new McpClient(service(ID_JAG), fetchImpl).listTools();

    expect(sent.map((request) => request.url)).toEqual(["https://idp.test/token", `${ISSUER}/token`]);
    expect(sent[0]!.form).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: ISSUER,
      resource: RESOURCE,
      subject_token: "the-id-token",
      client_id: "idp-client",
      client_secret: "idp-secret",
    });
    expect(sent[1]!.form).toMatchObject({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: "the-id-jag", client_id: "my-service" });
    expect(rpc.at(-1)!.authorization).toBe("Bearer good-token");
  });

  test("an authorization server that does not say it takes such a grant is not asked for one", async () => {
    const { fetchImpl, sent } = world();
    await expect(new McpClient(service(ID_JAG), fetchImpl).listTools()).rejects.toThrow(/does not say it accepts identity assertion grants/);
    // The identity provider was never contacted: no grant is minted that nothing will take.
    expect(sent).toEqual([]);
  });
});

describe("secrets are named in the tools file and read from the environment", () => {
  const tool = (oauth: Record<string, unknown>) => ({ svc: { kind: "tool" as const, url: RESOURCE, oauth: oauth as never } });

  test("each name is looked up, and the service is not asked for an API key it has no use for", () => {
    const { services, problems } = resolveServices(
      ["svc"],
      tool({ grant: "client_credentials", issuer: ISSUER, clientId: "my-service", secret: "SVC_CLIENT_SECRET", scope: ["mcp:read"] }),
      { SVC_CLIENT_SECRET: SECRET },
    );
    expect(problems).toEqual([]);
    expect(services[0]!.apiKey).toBeUndefined();
    expect(services[0]!.oauth).toEqual({ grant: "client_credentials", issuer: ISSUER, clientId: "my-service", clientSecret: SECRET, scope: ["mcp:read"] });
  });

  test("a secret that is not set is a problem naming the variable, and no grant is attempted", () => {
    const { services, problems } = resolveServices(
      ["svc"],
      tool({ grant: "client_credentials", issuer: ISSUER, clientId: "my-service", secret: "SVC_CLIENT_SECRET" }),
      {},
    );
    expect(problems).toEqual(['service "svc" needs SVC_CLIENT_SECRET in the environment (its client secret)']);
    expect(services[0]!.oauth).toBeUndefined();
  });

  test("an identity grant reads the sign-in and both secrets", () => {
    const { services, problems } = resolveServices(
      ["svc"],
      tool({ grant: "id-jag", issuer: ISSUER, clientId: "my-service", idp: "https://idp.test/token", assertion: "ID_TOKEN", idpSecret: "IDP_SECRET" }),
      { ID_TOKEN: "the-id-token", IDP_SECRET: "idp-secret" },
    );
    expect(problems).toEqual([]);
    expect(services[0]!.oauth).toEqual({
      grant: "id-jag",
      issuer: ISSUER,
      clientId: "my-service",
      idp: "https://idp.test/token",
      assertion: "the-id-token",
      idpClientSecret: "idp-secret",
    });
  });

  test.each([
    [{ grant: "client_credentials", clientId: "c", secret: "S" }, "needs `issuer`"],
    [{ grant: "client_credentials", issuer: ISSUER, clientId: "c" }, "exactly one of `secret` and `key`"],
    [{ grant: "client_credentials", issuer: ISSUER, clientId: "c", secret: "S", key: "K" }, "exactly one of `secret` and `key`"],
    [{ grant: "id-jag", issuer: ISSUER, clientId: "c" }, "needs `idp`"],
    [{ grant: "password", issuer: ISSUER, clientId: "c" }, 'the grants made without a person are "client_credentials" and "id-jag"'],
  ])("%j is refused with what is missing", (oauth, why) => {
    const { services, problems } = resolveServices(["svc"], tool(oauth), { S: "x", K: "y" });
    expect(problems.join("\n")).toContain(why);
    expect(services[0]!.oauth).toBeUndefined();
  });

  test("a grant on a launched program is a mistake worth naming", () => {
    const { problems } = resolveServices(
      ["svc"],
      { svc: { kind: "tool", command: ["node", "server.js"], oauth: { grant: "client_credentials", issuer: ISSUER, clientId: "c", secret: "S" } } },
      { S: "x" },
    );
    expect(problems).toEqual(['service "svc" declares `oauth`, which is for an MCP server reached by url']);
  });
});
