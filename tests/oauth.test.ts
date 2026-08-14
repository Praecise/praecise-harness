/**
 * OAuth 2.1 against a protected MCP server.
 *
 * Most of these tests are about an attack rather than a feature. The OAuth requirements
 * the MCP spec singles out — resource indicators, issuer validation, PKCE, registrations
 * keyed by issuer — each exist because leaving them out produces a client that works
 * perfectly against an honest server and hands a token to a dishonest one. None of them
 * fail in a way that testing the happy path would reveal, so each is tested by the thing
 * it is supposed to prevent.
 */
import { describe, expect, test } from "vitest";

import { McpClient, Unauthorized } from "../src/harness/mcp.js";
import {
  OAuthClient,
  canonicalResource,
  challengeFor,
  expired,
  expiryOf,
  metadataUrls,
  parseChallenge,
  stepUpScopes,
  type AuthorizationServerMetadata,
  type ClientRegistration,
} from "../src/harness/oauth.js";

const SERVER: AuthorizationServerMetadata = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  registration_endpoint: "https://auth.example.com/register",
  authorization_response_iss_parameter_supported: true,
};

const CLIENT: ClientRegistration = { client_id: "c-1", issuer: "https://auth.example.com" };

const client = (fetchImpl?: typeof fetch) =>
  new OAuthClient({ redirectUri: "http://127.0.0.1:9999/callback", fetch: fetchImpl });

/** A fake network keyed by URL, so a route nobody registered is simply absent. */
function routes(map: Record<string, unknown>, onPost?: (url: string, init: RequestInit) => Response) {
  const posted: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push({ url: String(url), body: String(init.body) });
      return onPost?.(String(url), init) ?? new Response("{}", { status: 200 });
    }
    const found = map[String(url)];
    if (found === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(found), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, posted };
}

describe("reading the challenge a protected resource sends back", () => {
  test("a 401 points at the metadata that says where to get a token", () => {
    const challenge = parseChallenge(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read"',
    );
    expect(challenge?.scheme).toBe("Bearer");
    expect(challenge?.resourceMetadata).toBe("https://mcp.example.com/.well-known/oauth-protected-resource");
    expect(challenge?.scope).toEqual(["files:read"]);
  });

  test("a comma inside a quoted description does not split the header", () => {
    // The bug a comma-split parser has: this produces a scope list with a fragment of an
    // English sentence in it, and the client then asks the authorization server for a
    // permission called "ask".
    const challenge = parseChallenge(
      'Bearer error="insufficient_scope", scope="files:write files:read", error_description="Not allowed, ask an admin"',
    );
    expect(challenge?.error).toBe("insufficient_scope");
    expect(challenge?.scope).toEqual(["files:write", "files:read"]);
    expect(challenge?.errorDescription).toBe("Not allowed, ask an admin");
  });

  test("nothing at all is not a challenge", () => {
    expect(parseChallenge(undefined)).toBeUndefined();
    expect(parseChallenge(null)).toBeUndefined();
  });
});

describe("the resource parameter, which is what stops a token being spent elsewhere", () => {
  test("it rides on the authorization request", async () => {
    const { url } = await client().begin({
      server: SERVER,
      client: CLIENT,
      resource: "https://mcp.example.com/mcp",
      scope: ["files:read"],
    });
    expect(new URL(url).searchParams.get("resource")).toBe("https://mcp.example.com/mcp");
  });

  test("it rides on the token request too, which is the one that binds the audience", async () => {
    const { fetchImpl, posted } = routes({}, () =>
      new Response(JSON.stringify({ access_token: "at-1", token_type: "Bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const oauth = client(fetchImpl);
    const { pending } = await oauth.begin({
      server: SERVER,
      client: CLIENT,
      resource: "https://mcp.example.com/mcp",
    });

    await oauth.complete({
      server: SERVER,
      client: CLIENT,
      pending,
      params: { code: "code-1", state: pending.state, iss: SERVER.issuer },
    });

    const body = new URLSearchParams(posted[0]?.body ?? "");
    expect(body.get("resource")).toBe("https://mcp.example.com/mcp");
    expect(body.get("code_verifier")).toBe(pending.verifier);
    expect(body.get("grant_type")).toBe("authorization_code");
  });

  test("a fragment is stripped and a bare-host trailing slash is dropped", () => {
    // Two spellings of one server are two resources as far as the audience comparison
    // in the token is concerned.
    expect(canonicalResource("https://mcp.example.com/mcp#frag")).toBe("https://mcp.example.com/mcp");
    expect(canonicalResource("https://mcp.example.com/")).toBe("https://mcp.example.com");
    expect(canonicalResource("https://mcp.example.com:8443/mcp")).toBe("https://mcp.example.com:8443/mcp");
  });
});

describe("issuer validation, which is what stops a code being redeemed at the wrong server", () => {
  const pending = {
    verifier: "v",
    state: "s",
    issuer: "https://auth.example.com",
    resource: "https://mcp.example.com",
    scope: [],
    redirectUri: "http://127.0.0.1:9999/callback",
    clientId: "c-1",
  };

  test("a response from a different issuer is refused", () => {
    expect(() =>
      OAuthClient.validateIssuer(pending, { iss: "https://evil.example.com", state: "s" }, SERVER),
    ).toThrow("evil.example.com");
  });

  test("a server that promised iss and omitted it is refused", () => {
    expect(() => OAuthClient.validateIssuer(pending, { state: "s" }, SERVER)).toThrow("advertises");
  });

  test("a server that never promised iss and omitted it is allowed through", () => {
    // The revision keeps rejection keyed on the advertisement until a future one makes
    // `iss` mandatory; rejecting here would break conforming servers.
    expect(() =>
      OAuthClient.validateIssuer(pending, { state: "s" }, { authorization_response_iss_parameter_supported: false }),
    ).not.toThrow();
  });

  test("a present iss is checked even from a server that never advertised it", () => {
    expect(() =>
      OAuthClient.validateIssuer(
        pending,
        { iss: "https://evil.example.com", state: "s" },
        { authorization_response_iss_parameter_supported: false },
      ),
    ).toThrow();
  });

  test("the comparison is exact — no case folding, no trailing slash, no port elision", () => {
    // Each of these is a normalisation that would make a genuine mismatch disappear, and
    // the spec forbids each by name.
    for (const spoofed of [
      "https://AUTH.example.com",
      "https://auth.example.com/",
      "https://auth.example.com:443",
    ]) {
      expect(() => OAuthClient.validateIssuer(pending, { iss: spoofed, state: "s" }, SERVER)).toThrow();
    }
  });

  test("a mismatched state is refused before anything else is looked at", () => {
    expect(() =>
      OAuthClient.validateIssuer(pending, { iss: "https://auth.example.com", state: "other" }, SERVER),
    ).toThrow("does not match the request");
  });

  test("an error response is validated too, so a spoofed message is never shown", async () => {
    // An attacker who can produce the response chooses what the error says. Acting on it
    // — or displaying it — before checking where it came from is the whole problem.
    const oauth = client();
    await expect(
      oauth.complete({
        server: SERVER,
        client: CLIENT,
        pending,
        params: { error: "access_denied", error_description: "Call this number", state: "s", iss: "https://evil.example.com" },
      }),
    ).rejects.toThrow("evil.example.com");
  });
});

describe("PKCE", () => {
  test("the challenge is S256 of the verifier, and the verifier never leaves", async () => {
    const { url, pending } = await client().begin({
      server: SERVER,
      client: CLIENT,
      resource: "https://mcp.example.com",
    });
    const params = new URL(url).searchParams;
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBe(await challengeFor(pending.verifier));
    expect(url).not.toContain(pending.verifier);
  });

  test("two flows never share a verifier or a state", async () => {
    const oauth = client();
    const a = await oauth.begin({ server: SERVER, client: CLIENT, resource: "https://mcp.example.com" });
    const b = await oauth.begin({ server: SERVER, client: CLIENT, resource: "https://mcp.example.com" });
    expect(a.pending.verifier).not.toBe(b.pending.verifier);
    expect(a.pending.state).not.toBe(b.pending.state);
  });
});

describe("a registration belongs to the server that issued it", () => {
  test("presenting it to a different authorization server is refused", async () => {
    // Reusing a registration across servers is presenting someone else's identity, and
    // the spec requires re-registering when the authorization server changes.
    const elsewhere: AuthorizationServerMetadata = { ...SERVER, issuer: "https://other.example.com" };
    await expect(
      client().begin({ server: elsewhere, client: CLIENT, resource: "https://mcp.example.com" }),
    ).rejects.toThrow("register again");
  });

  test("a registration is stamped with the issuer that minted it", async () => {
    const { fetchImpl } = routes({}, () =>
      new Response(JSON.stringify({ client_id: "dyn-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const registration = await client(fetchImpl).register(SERVER);
    expect(registration.client_id).toBe("dyn-1");
    expect(registration.issuer).toBe(SERVER.issuer);
  });

  test("a loopback redirect registers as a native client, not a web one", async () => {
    // An OpenID Connect server defaults `application_type` to `web`, which forbids the
    // loopback redirect a local client must use — a rejection whose message rarely says so.
    const { fetchImpl, posted } = routes({}, () =>
      new Response(JSON.stringify({ client_id: "dyn-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await client(fetchImpl).register(SERVER);
    expect(JSON.parse(posted[0]?.body ?? "{}").application_type).toBe("native");
  });

  test("a client id already held is used instead of registering", async () => {
    const oauth = new OAuthClient({ redirectUri: "https://app.example/cb", clientId: "https://app.example/client.json" });
    const registration = await oauth.register(SERVER);
    // A Client ID Metadata Document — an HTTPS URL — is the mechanism this revision
    // prefers over dynamic registration.
    expect(registration.client_id).toBe("https://app.example/client.json");
  });

  test("a server with neither option says what to pass", async () => {
    const bare: AuthorizationServerMetadata = { ...SERVER, registration_endpoint: undefined };
    await expect(client().register(bare)).rejects.toThrow("clientId");
  });
});

describe("discovery", () => {
  test("the resource points at its authorization server, and the metadata is fetched", async () => {
    const { fetchImpl } = routes({
      "https://mcp.example.com/.well-known/oauth-protected-resource": {
        resource: "https://mcp.example.com",
        authorization_servers: ["https://auth.example.com"],
        scopes_supported: ["files:read"],
      },
      "https://auth.example.com/.well-known/oauth-authorization-server": SERVER,
    });

    const found = await client(fetchImpl).discover("https://mcp.example.com/mcp");
    expect(found.server.issuer).toBe("https://auth.example.com");
    expect(found.resource.scopes_supported).toEqual(["files:read"]);
  });

  test("OpenID Connect discovery is tried when RFC 8414 is absent", async () => {
    const { fetchImpl } = routes({
      "https://mcp.example.com/.well-known/oauth-protected-resource": {
        authorization_servers: ["https://auth.example.com"],
      },
      "https://auth.example.com/.well-known/openid-configuration": SERVER,
    });
    const found = await client(fetchImpl).discover("https://mcp.example.com/mcp");
    expect(found.server.token_endpoint).toBe("https://auth.example.com/token");
  });

  test("a metadata document naming a different issuer is not trusted", async () => {
    // Trusting it would defeat the `iss` check before it started: the recorded issuer
    // would be one an attacker supplied.
    const { fetchImpl } = routes({
      "https://mcp.example.com/.well-known/oauth-protected-resource": {
        authorization_servers: ["https://auth.example.com"],
      },
      "https://auth.example.com/.well-known/oauth-authorization-server": {
        ...SERVER,
        issuer: "https://evil.example.com",
      },
    });
    await expect(client(fetchImpl).discover("https://mcp.example.com/mcp")).rejects.toThrow("claims issuer");
  });

  test("a resource naming no authorization server says so plainly", async () => {
    const { fetchImpl } = routes({
      "https://mcp.example.com/.well-known/oauth-protected-resource": { resource: "https://mcp.example.com" },
    });
    await expect(client(fetchImpl).discover("https://mcp.example.com/mcp")).rejects.toThrow("names no authorization server");
  });

  test("RFC 8414 inserts the well-known segment before the path, not after", () => {
    // The detail hand-rolled clients get wrong, and it only fails against multi-tenant
    // servers — which are exactly the ones worth supporting.
    const urls = metadataUrls("https://auth.example.com/tenant1");
    expect(urls[0]).toBe("https://auth.example.com/.well-known/oauth-authorization-server/tenant1");
    // OIDC appends instead, and both spellings are tried.
    expect(urls).toContain("https://auth.example.com/tenant1/.well-known/openid-configuration");
  });
});

describe("keeping a token usable", () => {
  test("a refresh keeps the same audience binding", async () => {
    const { fetchImpl, posted } = routes({}, () =>
      new Response(JSON.stringify({ access_token: "at-2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await client(fetchImpl).refresh({
      server: SERVER,
      client: CLIENT,
      refreshToken: "rt-1",
      resource: "https://mcp.example.com/mcp",
    });
    const body = new URLSearchParams(posted[0]?.body ?? "");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("resource")).toBe("https://mcp.example.com/mcp");
  });

  test("a token about to expire counts as expired", () => {
    // A token with two seconds left is not usable: it will have expired by the time the
    // request it is attached to arrives.
    const now = 1_000_000;
    expect(expired(now + 2_000, now)).toBe(true);
    expect(expired(now + 120_000, now)).toBe(false);
    expect(expired(undefined, now)).toBe(false);
  });

  test("expires_in becomes an instant", () => {
    expect(expiryOf({ access_token: "a", expires_in: 60 }, 1_000)).toBe(61_000);
    expect(expiryOf({ access_token: "a" }, 1_000)).toBeUndefined();
  });

  test("a refused token request explains itself from the structured error", async () => {
    const { fetchImpl } = routes({}, () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "code already used" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      client(fetchImpl).refresh({
        server: SERVER,
        client: CLIENT,
        refreshToken: "rt-1",
        resource: "https://mcp.example.com",
      }),
    ).rejects.toThrow("code already used");
  });
});

describe("stepping up when a scope was missing", () => {
  test("the new request is the union, so a held permission is not traded away", () => {
    // A server challenging for `files:write` says nothing about `files:read`.
    // Re-authorizing for the challenge alone loops forever between two operations.
    expect(stepUpScopes(["files:read"], ["files:write"]).sort()).toEqual(["files:read", "files:write"]);
    expect(stepUpScopes(["a"], ["a"])).toEqual(["a"]);
    expect(stepUpScopes(undefined, ["a"])).toEqual(["a"]);
  });

  test("begin() asks for the union of granted and challenged", async () => {
    const { url } = await client().begin({
      server: SERVER,
      client: CLIENT,
      resource: "https://mcp.example.com",
      granted: ["files:read"],
      scope: ["files:write"],
    });
    const asked = (new URL(url).searchParams.get("scope") ?? "").split(" ").sort();
    expect(asked).toEqual(["files:read", "files:write"]);
  });
});

describe("the client recognises a challenge and retries, which is the framework's half", () => {
  const service = {
    name: "svc",
    url: "https://mcp.example.com/mcp",
    credential: "SVC_KEY",
    auth: "bearer" as const,
  };

  /** A server that refuses once and serves whoever comes back with a token. */
  function guarded(status: number, header: string) {
    const seen: { authorization?: string }[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      seen.push({ authorization: headers.authorization });
      if (!headers.authorization?.includes("granted")) {
        return new Response("", { status, headers: { "www-authenticate": header } });
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", tools: [] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }

  test("a 401 surfaces the challenge instead of a dead end", async () => {
    const { fetchImpl } = guarded(
      401,
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
    );
    // With nowhere to get a token, the error still carries the way forward.
    const client = new McpClient(service as never, fetchImpl);
    await expect(client.listTools()).rejects.toBeInstanceOf(Unauthorized);
    await expect(client.listTools()).rejects.toThrow("oauth-protected-resource");
  });

  test("a supplied token is used, and the request goes again", async () => {
    const { seen, fetchImpl } = guarded(401, 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"');
    const client = new McpClient(service as never, fetchImpl, async () => "granted-token");

    await expect(client.listTools()).resolves.toEqual([]);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.authorization).toBe("Bearer granted-token");
  });

  test("the token is kept, so the next call does not challenge again", async () => {
    const { seen, fetchImpl } = guarded(401, "Bearer");
    let asked = 0;
    const client = new McpClient(service as never, fetchImpl, async () => {
      asked += 1;
      return "granted-token";
    });

    await client.listTools();
    await client.listTools();
    expect(asked).toBe(1);
    // Three requests: the refused one, its retry, and the second call going straight through.
    expect(seen).toHaveLength(3);
  });

  test("a 403 for insufficient scope starts the flow; another 403 does not", async () => {
    // Scope is recoverable — the client can ask for more. A plain 403 is a decision, and
    // treating it as a challenge would loop against a server that simply said no.
    const scoped = guarded(403, 'Bearer error="insufficient_scope", scope="files:write"');
    const client = new McpClient(service as never, scoped.fetchImpl, async () => "granted-token");
    await expect(client.listTools()).resolves.toEqual([]);

    const forbidden = (async () =>
      new Response("", { status: 403, headers: { "www-authenticate": "Bearer" } })) as unknown as typeof fetch;
    let asked = 0;
    const denied = new McpClient(service as never, forbidden, async () => {
      asked += 1;
      return "granted-token";
    });
    await expect(denied.listTools()).rejects.toThrow();
    expect(asked).toBe(0);
  });

  test("a server that refuses the token it just helped us get is not retried forever", async () => {
    let calls = 0;
    const stubborn = (async () => {
      calls += 1;
      return new Response("", { status: 401, headers: { "www-authenticate": "Bearer" } });
    }) as unknown as typeof fetch;

    const client = new McpClient(service as never, stubborn, async () => "granted-token");
    await expect(client.listTools()).rejects.toBeInstanceOf(Unauthorized);
    expect(calls).toBe(2);
  });
});
