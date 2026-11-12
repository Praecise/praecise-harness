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
  async discover(resourceUrl: string, challenge?: Challenge): Promise<DiscoveryResult> {
    const metadataUrl =
      challenge?.resourceMetadata ?? `${new URL(resourceUrl).origin}${PROTECTED_RESOURCE_PATH}`;

    const resource = (await this.getJson(metadataUrl)) as ProtectedResourceMetadata | undefined;
    if (!resource) throw new Error(`no protected resource metadata at ${metadataUrl}`);

    const issuers = resource.authorization_servers ?? [];
    if (!issuers.length) {
      throw new Error(`${metadataUrl} names no authorization server, so there is nothing to ask for a token`);
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
        if (!server.authorization_endpoint || !server.token_endpoint) {
          failures.push(`${url} is missing an authorization or token endpoint`);
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

  private async token(server: AuthorizationServerMetadata, body: URLSearchParams): Promise<Tokens> {
    const response = await this.fetchImpl(server.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
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
      throw new Error(`the token request to "${server.issuer}" failed (${response.status}): ${detail}`);
    }

    const tokens = JSON.parse(text) as Tokens;
    if (!tokens.access_token) throw new Error(`"${server.issuer}" answered without an access token`);
    return tokens;
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
