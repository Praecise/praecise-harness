/**
 * OAuth 2.1 for MCP servers that are protected resources.
 *
 * Until now a remote MCP service could only be reached with a static credential from the
 * environment, which covers a personal API key and nothing else. A server that acts as an
 * OAuth 2.1 resource server — the shape the spec actually defines for hosted MCP — was
 * simply unreachable, and the failure was a flat 401 with no path forward.
 *
 * ── Why this is more than "do an OAuth flow" ──────────────────────────────────
 *
 * Four of the requirements here exist because of a specific attack, and each is the kind
 * of thing that is easy to leave out and impossible to notice missing:
 *
 * **The `resource` parameter (RFC 8707).** A token minted for one MCP server must not be
 * usable at another. Without a resource indicator, a malicious server can take the token
 * you sent it and spend it at a different server that trusts the same authorization
 * server — the confused deputy, in its most direct form. The spec requires sending it on
 * BOTH the authorization and the token request, and requires sending it even to
 * authorization servers that ignore it, because the client cannot know which ones do.
 *
 * **Issuer validation (RFC 9207).** With more than one authorization server in play, an
 * attacker who can influence which one you were sent to can have an authorization code
 * from THEIR server redeemed at YOUR server. The defence is to record the issuer before
 * redirecting and compare the `iss` that comes back, byte for byte — and the comparison
 * has to be exactly that, because normalising case or a trailing slash before comparing
 * is how a mismatch is made to disappear.
 *
 * **PKCE.** Not optional in OAuth 2.1, and not optional for a public client that cannot
 * keep a secret, which is what this is.
 *
 * **Credentials keyed by issuer.** A client registration belongs to the authorization
 * server that issued it. Reusing one against a different server is presenting someone
 * else's identity, so every `ClientRegistration` carries its issuer, and each request that
 * presents one — authorization, code exchange, refresh — refuses a server with a different
 * issuer. Nothing is stored in this file; an app that keeps registrations keeps them under
 * that field. A changed issuer forces a new `register()` rather than a silent reuse.
 *
 * ── What this deliberately does not do ────────────────────────────────────────
 *
 * It does not open a browser, run a callback server, or persist anything to disk. The flow
 * is split at exactly the point where a human has to act: `begin()` returns the URL to
 * send them to and the state to keep, `complete()` takes what came back. Where the browser
 * comes from and where the tokens are kept are application decisions, and a framework that
 * made them would be unusable in the environments that do not match its guess.
 *
 * Every network call goes through an injected `fetch`. Nothing here reads an environment
 * variable or reaches the network on its own.
 */

import { type KeyObject, createPrivateKey, sign } from "node:crypto";

/** Codes and shapes the flow needs, none of which are ours to choose. */
const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";
const OIDC_METADATA_PATH = "/.well-known/openid-configuration";

/** What a protected resource says about itself (RFC 9728). */
export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
}

/** What an authorization server says about itself (RFC 8414 / OIDC Discovery). */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
  /** RFC 9207. When true, an authorization response without `iss` must be rejected. */
  authorization_response_iss_parameter_supported?: boolean;
  /**
   * When true, this server will fetch a client's metadata from the URL given as its
   * `client_id`, so no registration request is needed. Absent means it will not.
   */
  client_id_metadata_document_supported?: boolean;
  /** How this server takes a client's proof of itself at the token endpoint. */
  token_endpoint_auth_methods_supported?: string[];
  /** The algorithms it takes a client assertion signed with. */
  token_endpoint_auth_signing_alg_values_supported?: string[];
  /** Grant profiles it accepts. Naming the ID-JAG profile is how it says it takes one. */
  authorization_grant_profiles_supported?: string[];
}

/** RFC 7523: the kind of thing a client assertion is. */
const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** RFC 7523: a JWT presented as the grant itself. */
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** RFC 8693: one token exchanged for another. */
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";
/** The token type of an Identity Assertion JWT Authorization Grant. */
const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";
/** What an authorization server lists to say it accepts one. */
const ID_JAG_PROFILE = "urn:ietf:params:oauth:grant-profile:id-jag";

/** The host of an endpoint, for a message that should name who answered and nothing else. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "an address that is not a URL";
  }
}

/** A client identity at one authorization server. Never valid at a different one. */
export interface ClientRegistration {
  client_id: string;
  client_secret?: string;
  /** The issuer this identity belongs to. Presenting it elsewhere is impersonation. */
  issuer: string;
}

export interface Tokens {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  /** Seconds, as the server stated them. Converted to an instant by `expiryOf`. */
  expires_in?: number;
  scope?: string;
}

/** What a challenge from a protected resource actually told us. */
export interface Challenge {
  scheme: string;
  resourceMetadata?: string;
  scope?: string[];
  error?: string;
  errorDescription?: string;
}

/**
 * Parse a `WWW-Authenticate` header.
 *
 * Written out rather than split on commas, because the values are quoted strings that
 * routinely CONTAIN commas — a `scope="files:read files:write"` is fine but a
 * `error_description="Not allowed, ask an admin"` is not, and a naive split turns that
 * into two broken parameters and a scope list with a sentence in it.
 */
export function parseChallenge(header: string | null | undefined): Challenge | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const space = trimmed.indexOf(" ");
  const scheme = space < 0 ? trimmed : trimmed.slice(0, space);
  const rest = space < 0 ? "" : trimmed.slice(space + 1);

  const params = new Map<string, string>();
  let index = 0;
  while (index < rest.length) {
    while (index < rest.length && /[\s,]/.test(rest[index] as string)) index += 1;
    const equals = rest.indexOf("=", index);
    if (equals < 0) break;
    const key = rest.slice(index, equals).trim().toLowerCase();
    index = equals + 1;

    let value: string;
    if (rest[index] === '"') {
      index += 1;
      let out = "";
      while (index < rest.length && rest[index] !== '"') {
        // A backslash escape inside a quoted string, per RFC 9110's quoted-pair.
        if (rest[index] === "\\" && index + 1 < rest.length) index += 1;
        out += rest[index];
        index += 1;
      }
      index += 1;
      value = out;
    } else {
      const end = rest.indexOf(",", index);
      value = (end < 0 ? rest.slice(index) : rest.slice(index, end)).trim();
      index = end < 0 ? rest.length : end;
    }
    if (key) params.set(key, value);
  }

  const scope = params.get("scope");
  return {
    scheme,
    resourceMetadata: params.get("resource_metadata"),
    scope: scope ? scope.split(/\s+/).filter(Boolean) : undefined,
    error: params.get("error"),
    errorDescription: params.get("error_description"),
  };
}

/**
 * The canonical URI of an MCP server, as the `resource` parameter wants it.
 *
 * A fragment is invalid outright. A trailing slash is technically valid and the spec asks
 * for the form without one, which matters more than it looks: the authorization server
 * compares this string to the audience it will stamp into the token, and two spellings of
 * one server are two resources as far as that comparison is concerned.
 */
export function canonicalResource(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  let out = parsed.toString();
  if (out.endsWith("/") && parsed.pathname === "/") out = out.slice(0, -1);
  return out;
}

/**
 * Where to look for a metadata document, in the order to try.
 *
 * RFC 8414 inserts the well-known segment BEFORE the path rather than appending it —
 * `https://as.example/tenant1` becomes `https://as.example/.well-known/oauth-authorization-server/tenant1`
 * — which is the detail most hand-rolled clients get wrong, and it only fails against
 * multi-tenant servers, which are exactly the ones worth supporting. OIDC discovery
 * appends instead. Both spellings of both are tried, in the spec's priority order.
 */
export function metadataUrls(issuer: string): string[] {
  const parsed = new URL(issuer);
  const path = parsed.pathname.replace(/\/$/, "");
  const origin = parsed.origin;
  if (!path) {
    return [`${origin}${AS_METADATA_PATH}`, `${origin}${OIDC_METADATA_PATH}`];
  }
  return [
    `${origin}${AS_METADATA_PATH}${path}`,
    `${origin}${OIDC_METADATA_PATH}${path}`,
    `${origin}${path}${OIDC_METADATA_PATH}`,
  ];
}

/** Base64url without padding, which is what every OAuth parameter here wants. */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A high-entropy random string, for a verifier or a state. */
export function randomString(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  return base64url(buffer);
}

/** The S256 challenge for a verifier. The only method OAuth 2.1 allows. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Everything that must survive between the redirect out and the callback in. */
export interface PendingAuthorization {
  /** Never leaves the client. Proves the callback belongs to this request. */
  verifier: string;
  state: string;
  /** Recorded BEFORE redirecting, which is the whole basis of the `iss` check. */
  issuer: string;
  resource: string;
  scope: string[];
  redirectUri: string;
  clientId: string;
}

export interface DiscoveryResult {
  resource: ProtectedResourceMetadata;
  server: AuthorizationServerMetadata;
}

export interface OAuthOptions {
  fetch?: typeof fetch;
  /**
   * The client's own identity, if it has one already: an id an authorization server
   * issued out of band. It is presented to whichever server is asked, with no check that
   * the server knows it, so it is for a client that talks to one authorization server.
   * A client that hosts a Client ID Metadata Document names it in `clientMetadataUrl`.
   */
  clientId?: string;
  clientSecret?: string;
  /**
   * The HTTPS URL where this client's own metadata document is served.
   *
   * Client ID Metadata Documents are the registration the current revision recommends,
   * and Dynamic Client Registration is deprecated in their favour. When an authorization
   * server's metadata says `client_id_metadata_document_supported: true`, this URL IS the
   * `client_id`: the server fetches the document itself, and no registration request is
   * sent. A server that does not say so is registered with dynamically, as before.
   * `clientMetadataDocument` builds the JSON to host at this URL.
   */
  clientMetadataUrl?: string;
  /** Where the authorization server sends the user back. */
  redirectUri: string;
  /** Sent when falling back to Dynamic Client Registration. */
  clientName?: string;
}

/**
 * The client half of the flow.
 *
 * Stateless between calls by construction: everything that has to persist across the user
 * leaving and coming back is handed to the caller as a `PendingAuthorization` rather than
 * kept in a field. A field would be wrong for the case that actually happens — the process
 * that starts the flow is often not the one that finishes it.
 */
export class OAuthClient {
  private readonly fetchImpl: typeof fetch;

  private readonly options: OAuthOptions;

  constructor(

    options: OAuthOptions

  ) {

    this.options = options;

    // Refused at construction and not at first use: a URL an authorization server would
    // reject is a mistake in the app's configuration, and it should fail where that is set.
    if (options.clientMetadataUrl !== undefined) checkClientMetadataUrl(options.clientMetadataUrl);

    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * Follow a challenge to the authorization server that can answer it.
   *
   * The metadata URL comes from the challenge when the server sent one, and falls back to
   * the well-known path on the resource's own origin when it did not.
   */
  async discover(
    resourceUrl: string,
    challenge?: Challenge,
    /**
     * `issuer` narrows the search to one authorization server: the resource must name it,
     * and no other it names is asked. `machine` is for a grant with no redirect, which
     * needs a token endpoint and has no use for an authorization endpoint.
     */
    only: { issuer?: string; machine?: boolean } = {},
  ): Promise<DiscoveryResult> {
    const metadataUrl =
      challenge?.resourceMetadata ?? `${new URL(resourceUrl).origin}${PROTECTED_RESOURCE_PATH}`;

    const resource = (await this.getJson(metadataUrl)) as ProtectedResourceMetadata | undefined;
    if (!resource) throw new Error(`no protected resource metadata at ${metadataUrl}`);

    const named = resource.authorization_servers ?? [];
    if (!named.length) {
      throw new Error(`${metadataUrl} names no authorization server, so there is nothing to ask for a token`);
    }
    // Credentials that belong to one authorization server are shown to that one. A
    // resource that does not name it is not asked to accept another in its place: the
    // comparison is exact, for the reason every issuer comparison here is.
    const issuers = only.issuer === undefined ? named : named.filter((issuer) => issuer === only.issuer);
    if (!issuers.length) {
      throw new Error(
        `${metadataUrl} does not name "${only.issuer}" as an authorization server (it names: ${named.join(", ")}), ` +
          `and this client's credentials are for that one only`,
      );
    }

    // The first that answers. A resource may list several; the spec leaves the choice to
    // the client and gives it no basis to prefer one, so trying in order is the honest
    // reading rather than a preference invented here.
    const failures: string[] = [];
    for (const issuer of issuers) {
      for (const url of metadataUrls(issuer)) {
        const server = (await this.getJson(url)) as AuthorizationServerMetadata | undefined;
        if (!server?.issuer) continue;
        // A metadata document that names a different issuer than the one we asked about
        // is not this server's document, and trusting it would defeat the `iss` check
        // before it started.
        if (server.issuer !== issuer) {
          failures.push(`${url} claims issuer "${server.issuer}" but was fetched as "${issuer}"`);
          continue;
        }
        if (!server.token_endpoint || (!only.machine && !server.authorization_endpoint)) {
          failures.push(`${url} is missing ${only.machine ? "a token endpoint" : "an authorization or token endpoint"}`);
          continue;
        }
        return { resource, server };
      }
      failures.push(`no metadata document found for issuer "${issuer}"`);
    }
    throw new Error(`could not discover an authorization server: ${failures.join("; ")}`);
  }

  /**
   * The identity to present to one authorization server.
   *
   * In the order the current revision gives: a client id already held; then the client's
   * own metadata document URL, where the server says it reads those; then Dynamic Client
   * Registration, which is deprecated and kept only for servers that support nothing else.
   * Whichever it is, the identity that comes back is stamped with the issuer it is for.
   * That holds for a metadata document URL too: the URL is the same string at every
   * server, but whether a server accepts it was read from THAT server's metadata, so it is
   * decided again for each issuer and never carried from one to the next.
   */
  async register(server: AuthorizationServerMetadata): Promise<ClientRegistration> {
    if (this.options.clientId) {
      return {
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        issuer: server.issuer,
      };
    }
    if (this.options.clientMetadataUrl && server.client_id_metadata_document_supported === true) {
      // A public client: no secret, and nothing sent to the server here. It fetches the
      // document when it first sees this id on an authorization request.
      return { client_id: this.options.clientMetadataUrl, issuer: server.issuer };
    }
    if (!server.registration_endpoint) {
      throw new Error(
        `"${server.issuer}" ` +
          (this.options.clientMetadataUrl
            ? `does not say it reads Client ID Metadata Documents and offers no dynamic registration; ` +
              `pass a \`clientId\` it issued you`
            : `offers no dynamic registration; pass \`clientMetadataUrl\` — the HTTPS URL of a Client ID ` +
              `Metadata Document, the current mechanism — or a \`clientId\` it issued you`),
      );
    }

    const response = await this.fetchImpl(server.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: this.options.clientName ?? "praecise",
        redirect_uris: [this.options.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        // Required by the current revision, and not cosmetic: without it an OpenID
        // Connect server defaults to `web`, which forbids the loopback redirect URI a
        // local client has to use, and the registration is rejected for a reason the
        // error message rarely explains.
        application_type: this.options.redirectUri.startsWith("http://") ? "native" : "web",
      }),
    });

    if (!response.ok) {
      throw new Error(
        `registration with "${server.issuer}" failed (${response.status}): ` +
          `${(await response.text().catch(() => "")).slice(0, 300)}`,
      );
    }
    const registered = (await response.json()) as { client_id?: string; client_secret?: string };
    if (!registered.client_id) throw new Error(`"${server.issuer}" registered us without a client_id`);
    return { client_id: registered.client_id, client_secret: registered.client_secret, issuer: server.issuer };
  }

  /**
   * Build the URL to send the user to, and the state that has to survive until they return.
   *
   * `granted` is the scope set already held. The union with the challenge's scopes is what
   * makes step-up authorization non-destructive: a server challenging for `files:write`
   * says nothing about `files:read`, and re-authorizing for the challenge alone would
   * silently drop a permission the client still needs.
   */
  async begin(input: {
    server: AuthorizationServerMetadata;
    client: ClientRegistration;
    resource: string;
    scope?: string[];
    granted?: string[];
  }): Promise<{ url: string; pending: PendingAuthorization }> {
    sameIssuer(input.client, input.server);

    const verifier = randomString();
    const state = randomString(16);
    const scope = stepUpScopes(input.granted, input.scope);
    const resource = canonicalResource(input.resource);

    const url = new URL(input.server.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", input.client.client_id);
    url.searchParams.set("redirect_uri", this.options.redirectUri);
    url.searchParams.set("code_challenge", await challengeFor(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    // Sent regardless of whether this server advertises support: the client cannot know
    // which servers honour it, and omitting it is what makes a token reusable elsewhere.
    url.searchParams.set("resource", resource);
    if (scope.length) url.searchParams.set("scope", scope.join(" "));

    return {
      url: url.toString(),
      pending: {
        verifier,
        state,
        // Recorded before the redirect. The `iss` check is worth nothing if the expected
        // issuer is read from the response it is meant to be checking.
        issuer: input.server.issuer,
        resource,
        scope,
        redirectUri: this.options.redirectUri,
        clientId: input.client.client_id,
      },
    };
  }

  /**
   * Check an authorization response before any part of it is acted on.
   *
   * Applies RFC 9207 §2.4 exactly, including for ERROR responses — on a mismatch the
   * error must not be acted on or shown, because an attacker who can produce the response
   * can choose what the message says.
   *
   * The comparison is a byte comparison on purpose. Case-folding the host, dropping a
   * default port or a trailing slash, or re-encoding a percent escape are all ways to
   * make a mismatch vanish, and the spec forbids each of them by name.
   */
  static validateIssuer(
    pending: PendingAuthorization,
    params: { iss?: string; state?: string },
    server: Pick<AuthorizationServerMetadata, "authorization_response_iss_parameter_supported">,
  ): void {
    if (params.state !== pending.state) {
      throw new Error("the authorization response does not match the request that was sent");
    }
    const advertised = server.authorization_response_iss_parameter_supported === true;
    if (params.iss === undefined) {
      // Only a server that said it would send `iss` is faulted for omitting it. The
      // revision is explicit that this stays keyed on the advertisement until a future
      // one makes `iss` mandatory.
      if (advertised) {
        throw new Error(
          `"${pending.issuer}" advertises that it sends \`iss\` and did not, so this response cannot be trusted`,
        );
      }
      return;
    }
    if (params.iss !== pending.issuer) {
      throw new Error(
        `the authorization response came from "${params.iss}" but was requested from "${pending.issuer}"`,
      );
    }
  }

  /** Redeem an authorization code, having already checked where it came from. */
  async complete(input: {
    server: AuthorizationServerMetadata;
    client: ClientRegistration;
    pending: PendingAuthorization;
    params: { code?: string; state?: string; iss?: string; error?: string; error_description?: string };
  }): Promise<Tokens> {
    // The token request presents the client identity too, so it is held to the same rule
    // as the authorization request.
    sameIssuer(input.client, input.server);
    OAuthClient.validateIssuer(input.pending, input.params, input.server);

    if (input.params.error) {
      throw new Error(
        `authorization was refused: ${input.params.error}` +
          (input.params.error_description ? ` — ${input.params.error_description}` : ""),
      );
    }
    if (!input.params.code) throw new Error("the authorization response carried no code");

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.params.code,
      redirect_uri: input.pending.redirectUri,
      client_id: input.client.client_id,
      code_verifier: input.pending.verifier,
      // On the token request as well as the authorization request. This is the one that
      // binds the audience of the token that comes back.
      resource: input.pending.resource,
    });
    if (input.client.client_secret) body.set("client_secret", input.client.client_secret);

    return this.token(input.server, body);
  }

  /** Exchange a refresh token, keeping the same audience binding. */
  async refresh(input: {
    server: AuthorizationServerMetadata;
    client: ClientRegistration;
    refreshToken: string;
    resource: string;
    scope?: string[];
  }): Promise<Tokens> {
    sameIssuer(input.client, input.server);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.client.client_id,
      resource: canonicalResource(input.resource),
    });
    if (input.scope?.length) body.set("scope", input.scope.join(" "));
    if (input.client.client_secret) body.set("client_secret", input.client.client_secret);
    return this.token(input.server, body);
  }

  // ── Grants that need nobody at a keyboard ────────────────────────────────
  //
  // Both are extensions of MCP authorization, and both end at the same place the
  // interactive flow does: a bearer token whose audience is one MCP server. What differs
  // is what is presented to get it. Neither redirects anyone, so neither has a `begin`.

  /**
   * The client credentials grant: this app, as itself, with no person involved.
   *
   * Two ways to prove who is asking. A signed assertion (`assertion`, RFC 7523) is the
   * one the extension recommends: it lasts minutes and the key never leaves this
   * process. A client secret is the other, and it is sent in the request body, as the
   * extension's own example sends it, unless the authorization server says it takes
   * HTTP Basic and not a body parameter.
   *
   * With an assertion `client_id` is left out of the body: the assertion's subject IS
   * the client, and a second copy is a second thing to disagree with it.
   */
  async clientCredentials(input: {
    server: AuthorizationServerMetadata;
    client: ClientRegistration;
    /** A signed client assertion, from `clientAssertion`. Used instead of the client's secret. */
    assertion?: string;
    resource: string;
    scope?: string[];
  }): Promise<Tokens> {
    sameIssuer(input.client, input.server);
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      // The audience binding, on this grant as on every other: a token minted for one
      // MCP server must not be spendable at the next.
      resource: canonicalResource(input.resource),
    });
    if (input.scope?.length) body.set("scope", input.scope.join(" "));

    const headers: Record<string, string> = {};
    if (input.assertion) {
      body.set("client_assertion_type", CLIENT_ASSERTION_TYPE);
      body.set("client_assertion", input.assertion);
    } else if (input.client.client_secret) {
      this.authenticate(input.server, input.client, body, headers);
    } else {
      throw new Error(
        `the client credentials grant needs something to prove "${input.client.client_id}" with: a client secret or a signed assertion`,
      );
    }
    return this.token(input.server, body, headers);
  }

  /**
   * Present a client's id and secret the way one authorization server takes them.
   *
   * In the body unless the server's metadata lists HTTP Basic and does not list the body
   * form. A server that lists neither is sent the body form, which is what the client
   * credentials extension shows.
   */
  private authenticate(
    server: AuthorizationServerMetadata,
    client: ClientRegistration,
    body: URLSearchParams,
    headers: Record<string, string>,
  ): void {
    if (!client.client_secret) {
      body.set("client_id", client.client_id);
      return;
    }
    const methods = server.token_endpoint_auth_methods_supported ?? [];
    if (methods.includes("client_secret_basic") && !methods.includes("client_secret_post")) {
      // RFC 6749 §2.3.1: each half is form-encoded before the pair is base64-encoded.
      const pair = `${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`;
      headers.authorization = `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
      return;
    }
    body.set("client_id", client.client_id);
    body.set("client_secret", client.client_secret);
  }

  /**
   * Whether an authorization server says it takes an ID-JAG. The enterprise-managed
   * extension has a client check this before asking an identity provider for one.
   */
  static acceptsIdJag(server: AuthorizationServerMetadata): boolean {
    return (server.authorization_grant_profiles_supported ?? []).includes(ID_JAG_PROFILE);
  }

  /**
   * Step one of enterprise-managed authorization: ask the organisation's identity
   * provider, on the strength of a sign-in that already happened, for a grant addressed
   * to one MCP server's authorization server (RFC 8693 token exchange).
   *
   * What comes back is an ID-JAG, an Identity Assertion JWT Authorization Grant. It is
   * not an access token and is good for one thing: `redeemGrant`. Whether the person may
   * have it is the identity provider's decision, made by policy the organisation set; a
   * refusal here is that policy speaking, and is reported in the provider's own words.
   *
   * The reply is checked for being what was asked for. An identity provider that does
   * not know this exchange answers with an ordinary token, and passing that on as a
   * grant would fail one step later with a message about something else.
   */
  async exchangeIdentity(input: {
    /** The identity provider's token endpoint. */
    tokenEndpoint: string;
    /** The ID token from the person's sign-in. */
    assertion: string;
    /** What kind of token `assertion` is. An ID token unless said. */
    assertionType?: string;
    /** The issuer of the MCP server's authorization server: who the grant is for. */
    audience: string;
    /** The MCP server the eventual token is for. */
    resource?: string;
    scope?: string[];
    /** This client at the identity provider, where it asks clients to identify themselves. */
    clientId?: string;
    clientSecret?: string;
  }): Promise<{ grant: string; expiresIn?: number; scope?: string }> {
    const body = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      requested_token_type: ID_JAG_TOKEN_TYPE,
      audience: input.audience,
      subject_token: input.assertion,
      subject_token_type: input.assertionType ?? ID_TOKEN_TYPE,
    });
    if (input.resource) body.set("resource", canonicalResource(input.resource));
    if (input.scope?.length) body.set("scope", input.scope.join(" "));
    if (input.clientId) body.set("client_id", input.clientId);
    if (input.clientSecret) body.set("client_secret", input.clientSecret);

    const reply = (await this.form(input.tokenEndpoint, `the identity provider at ${hostOf(input.tokenEndpoint)}`, body)) as {
      access_token?: unknown;
      issued_token_type?: unknown;
      expires_in?: unknown;
      scope?: unknown;
    };
    if (reply.issued_token_type !== ID_JAG_TOKEN_TYPE || typeof reply.access_token !== "string" || !reply.access_token) {
      throw new Error(
        `the identity provider at ${hostOf(input.tokenEndpoint)} did not issue an identity assertion grant ` +
          `(issued_token_type ${JSON.stringify(reply.issued_token_type ?? null)}); it may not support this exchange for this client`,
      );
    }
    return {
      grant: reply.access_token,
      ...(typeof reply.expires_in === "number" ? { expiresIn: reply.expires_in } : {}),
      ...(typeof reply.scope === "string" ? { scope: reply.scope } : {}),
    };
  }

  /**
   * Step two: hand the grant to the MCP server's authorization server for an access
   * token (the JWT bearer grant, RFC 7523).
   *
   * The grant already names the MCP server it is for, so no `resource` is sent: the
   * authorization server binds the token's audience from the grant, and a parameter
   * here could only disagree with it.
   */
  async redeemGrant(input: {
    server: AuthorizationServerMetadata;
    client: ClientRegistration;
    /** The ID-JAG from `exchangeIdentity`. */
    grant: string;
    scope?: string[];
  }): Promise<Tokens> {
    sameIssuer(input.client, input.server);
    const body = new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion: input.grant });
    if (input.scope?.length) body.set("scope", input.scope.join(" "));
    const headers: Record<string, string> = {};
    this.authenticate(input.server, input.client, body, headers);
    return this.token(input.server, body, headers);
  }

  private async token(
    server: AuthorizationServerMetadata,
    body: URLSearchParams,
    headers: Record<string, string> = {},
  ): Promise<Tokens> {
    const tokens = (await this.form(server.token_endpoint, `"${server.issuer}"`, body, headers)) as unknown as Tokens;
    if (!tokens.access_token) throw new Error(`"${server.issuer}" answered without an access token`);
    return tokens;
  }

  /**
   * Post a form to a token endpoint and read what it says.
   *
   * Only the endpoint's own words reach an error. Nothing that was SENT does: the body
   * holds secrets, assertions and tokens, and an error message ends up in a log.
   */
  private async form(
    endpoint: string,
    who: string,
    body: URLSearchParams,
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers },
      body: body.toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      // An OAuth error body is structured and worth reading; a token endpoint that
      // refuses says why in a field, not in prose.
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: string; error_description?: string };
        if (parsed.error) {
          detail = parsed.error + (parsed.error_description ? ` — ${parsed.error_description}` : "");
        }
      } catch {
        // Not JSON; the raw text is the best available explanation.
      }
      throw new Error(`the token request to ${who} failed (${response.status}): ${detail}`);
    }

    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`the token request to ${who} was answered with something that is not JSON`);
    }
  }

  private async getJson(url: string): Promise<unknown | undefined> {
    try {
      const response = await this.fetchImpl(url, { headers: { accept: "application/json" } });
      if (!response.ok) return undefined;
      return (await response.json()) as unknown;
    } catch {
      // A metadata endpoint that is absent is an ordinary outcome — several are tried —
      // so a failure here is not an error, it is the next candidate.
      return undefined;
    }
  }
}

/**
 * Refuse to present a client identity to a server other than the one it is for.
 *
 * Every request that carries a `client_id` passes through this — the authorization
 * request, the code exchange and the refresh — because a rule checked on one of three
 * doors is not a rule.
 */
function sameIssuer(client: ClientRegistration, server: AuthorizationServerMetadata): void {
  if (client.issuer !== server.issuer) {
    throw new Error(
      `this client identity was issued by "${client.issuer}" and must not be presented to ` +
        `"${server.issuer}"; register again with the new authorization server`,
    );
  }
}

/**
 * Whether a URL can serve as a `client_id`, as the metadata document rules have it.
 *
 * HTTPS, with a path, and nothing that makes two spellings of one document: no fragment,
 * no credentials, no dot segments. An authorization server compares this string exactly
 * and fetches it, so a URL it would refuse is refused here, with the reason.
 */
function checkClientMetadataUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`a client metadata document URL must be an absolute HTTPS URL, and "${url}" is not a URL`);
  }
  // Read from the string as given, because `URL` resolves dot segments away before
  // anyone can see them.
  const rawPath = url.slice(url.indexOf("://") + 3).split(/[?#]/)[0] ?? "";
  let fault: string | undefined;
  if (parsed.protocol !== "https:") fault = "must use https";
  else if (parsed.pathname === "/" || parsed.pathname === "") fault = "must have a path, such as /oauth/client.json";
  else if (url.includes("#")) fault = "must not have a fragment";
  else if (parsed.username || parsed.password) fault = "must not carry credentials";
  else if (/\/\.\.?(\/|$)/.test(rawPath)) fault = "must not contain . or .. path segments";
  if (fault) throw new Error(`a client metadata document URL ${fault}: "${url}"`);
}

/** The document a client hosts at its `clientMetadataUrl`. */
export interface ClientMetadataDocument {
  /** The URL the document is served from, exactly. A server refuses one that differs. */
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  /** A public client: it holds no secret, and proves itself with PKCE. */
  token_endpoint_auth_method: "none";
}

/**
 * The JSON to host at `clientMetadataUrl`, so an app does not have to guess the shape.
 *
 * Pure: it builds the object and serves nothing. `url` is where the app will host it and
 * becomes `client_id`; `redirectUris` must list every `redirectUri` the app will use,
 * because an authorization server accepts no other. The grant and response types are the
 * ones `OAuthClient` uses, the same that it sends when it registers dynamically.
 */
export function clientMetadataDocument(input: {
  url: string;
  redirectUris: string[];
  clientName?: string;
}): ClientMetadataDocument {
  checkClientMetadataUrl(input.url);
  if (!input.redirectUris.length) {
    throw new Error("a client metadata document needs at least one redirect URI");
  }
  return {
    client_id: input.url,
    client_name: input.clientName ?? "praecise",
    redirect_uris: [...input.redirectUris],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/**
 * A signed statement that this client is who it says: a client assertion (RFC 7523).
 *
 * Issuer and subject are both the client id, which is what makes it a statement by the
 * client about itself. The audience is the authorization server's issuer identifier
 * unless another is given; some servers written to the older reading of the RFC want
 * their token endpoint's URL there instead, and `audience` is how to say so. It is good
 * for `lifetime` seconds and carries an id of its own, so one that is overheard is
 * useless within minutes and cannot be presented twice to a server that remembers.
 *
 * The algorithm follows the key: RS256 for an RSA key, ES256 for a P-256 key, EdDSA for
 * Ed25519. The key is a PEM string or a `KeyObject`, and never leaves this function.
 */
export function clientAssertion(input: {
  clientId: string;
  audience: string;
  key: string | KeyObject;
  /** The key's id, where the server tells a client's keys apart by one. */
  kid?: string;
  /** Seconds it is good for. Default 300. */
  lifetime?: number;
  now?: number;
}): string {
  let key: KeyObject;
  try {
    key = typeof input.key === "string" ? createPrivateKey(input.key) : input.key;
  } catch {
    // The reason node gives may quote the input. The input is a private key.
    throw new Error("the key for a client assertion is not a private key in PEM form");
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  const alg =
    key.asymmetricKeyType === "rsa"
      ? "RS256"
      : key.asymmetricKeyType === "ec" && curve === "prime256v1"
        ? "ES256"
        : key.asymmetricKeyType === "ed25519"
          ? "EdDSA"
          : undefined;
  if (!alg) {
    throw new Error(
      `a client assertion is signed with an RSA, P-256 or Ed25519 key, and this one is ` +
        `${key.asymmetricKeyType ?? key.type}${curve ? ` (${curve})` : ""}`,
    );
  }

  const issued = Math.floor((input.now ?? Date.now()) / 1_000);
  const part = (value: unknown): string => base64url(Buffer.from(JSON.stringify(value), "utf8"));
  const signed =
    `${part({ alg, typ: "JWT", ...(input.kid ? { kid: input.kid } : {}) })}.` +
    part({
      iss: input.clientId,
      sub: input.clientId,
      aud: input.audience,
      iat: issued,
      exp: issued + (input.lifetime ?? 300),
      jti: randomString(16),
    });
  const bytes = Buffer.from(signed, "utf8");
  const signature =
    alg === "RS256"
      ? sign("sha256", bytes, key)
      : alg === "ES256"
        ? // JOSE wants the two integers side by side, not the DER wrapping node defaults to.
          sign("sha256", bytes, { key, dsaEncoding: "ieee-p1363" })
        : sign(null, bytes, key);
  return `${signed}.${base64url(signature)}`;
}

/**
 * A grant a service was configured with, secrets and all.
 *
 * The shape `tool({ oauth })` resolves to once the environment has been read. It is the
 * one place in this file that holds a secret for longer than a call, and it holds it the
 * way a resolved service holds its API key: in memory, for the client that uses it.
 */
export type MachineGrant =
  | {
      grant: "client_credentials";
      issuer: string;
      clientId: string;
      clientSecret?: string;
      /** A PEM private key, to sign an assertion with instead of sending a secret. */
      key?: string;
      kid?: string;
      scope?: string[];
    }
  | {
      grant: "id-jag";
      issuer: string;
      clientId: string;
      clientSecret?: string;
      /** The identity provider's token endpoint. */
      idp: string;
      /** The ID token from the person's sign-in. */
      assertion: string;
      idpClientId?: string;
      idpClientSecret?: string;
      scope?: string[];
    };

/**
 * A way to a token for a service configured with a grant, in the shape an MCP client
 * asks for one: handed the challenge, it answers with a bearer token.
 *
 * This is the whole flow, because for these grants there is no person to wait for:
 * discover the authorization server the resource names, refuse it unless it is the one
 * the credentials belong to, make the grant. No token is kept here. The client that
 * asked keeps what it is given and presents it until the server refuses it, which is
 * when it asks again; these tokens are short-lived and come with no refresh token, so a
 * refusal is the signal there is. The client asks once per request, which is what stops
 * a server that refuses every token from being asked for ever.
 *
 * A failure is thrown with the authorization server's reason. Nothing that was sent is
 * in it.
 */
export function authorizerFor(
  grant: MachineGrant,
  fetchImpl: typeof fetch = fetch,
): (asked: { resource: string; challenge?: Challenge }) => Promise<string | undefined> {
  // No redirect is ever made, so the redirect URI is never sent anywhere.
  const oauth = new OAuthClient({ fetch: fetchImpl, redirectUri: "http://127.0.0.1/unused" });
  let found: Promise<DiscoveryResult> | undefined;

  return async (asked) => {
    found ??= oauth.discover(asked.resource, asked.challenge, { issuer: grant.issuer, machine: true });
    let server: AuthorizationServerMetadata;
    try {
      ({ server } = await found);
    } catch (err) {
      found = undefined;
      throw err;
    }
    const client: ClientRegistration = {
      client_id: grant.clientId,
      ...(grant.clientSecret ? { client_secret: grant.clientSecret } : {}),
      issuer: server.issuer,
    };
    // What the server asked for this time is added to what the service always asks for.
    const scope = stepUpScopes(grant.scope, asked.challenge?.scope);

    let tokens: Tokens;
    if (grant.grant === "client_credentials") {
      tokens = await oauth.clientCredentials({
        server,
        client,
        ...(grant.key
          ? { assertion: clientAssertion({ clientId: grant.clientId, audience: server.issuer, key: grant.key, kid: grant.kid }) }
          : {}),
        resource: asked.resource,
        scope,
      });
    } else {
      if (!OAuthClient.acceptsIdJag(server)) {
        throw new Error(
          `"${server.issuer}" does not say it accepts identity assertion grants ` +
            `(authorization_grant_profiles_supported does not list the id-jag profile), so none was asked for`,
        );
      }
      const exchanged = await oauth.exchangeIdentity({
        tokenEndpoint: grant.idp,
        assertion: grant.assertion,
        audience: server.issuer,
        resource: asked.resource,
        scope,
        clientId: grant.idpClientId ?? grant.clientId,
        clientSecret: grant.idpClientSecret,
      });
      tokens = await oauth.redeemGrant({ server, client, grant: exchanged.grant });
    }
    return tokens.access_token;
  };
}

/** When a token expires, as an instant, given when it was issued. */
export function expiryOf(tokens: Tokens, issuedAt = Date.now()): number | undefined {
  return tokens.expires_in === undefined ? undefined : issuedAt + tokens.expires_in * 1_000;
}

/**
 * Whether a token should be refreshed before being used again.
 *
 * The margin is the point: a token that expires in two seconds is not usable, because it
 * will have expired by the time the request it is attached to arrives.
 */
export function expired(expiresAt: number | undefined, now = Date.now(), marginMs = 30_000): boolean {
  return expiresAt !== undefined && now >= expiresAt - marginMs;
}

/**
 * The scopes to ask for next, given what is held and what was just refused.
 *
 * The union, always. A server challenging for one scope is describing what THIS operation
 * needs, not the full set the client should hold, so re-authorizing for the challenge
 * alone would trade one permission for another and loop forever between two operations.
 */
export function stepUpScopes(granted: string[] | undefined, challenged: string[] | undefined): string[] {
  return [...new Set([...(granted ?? []), ...(challenged ?? [])])];
}
