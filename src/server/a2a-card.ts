/**
 * Signed agent cards: saying a card is yours in a way a peer can check.
 *
 * A card is fetched over TLS from a well-known path, which proves which host served it
 * and nothing more. A card that has been through a registry, a cache or a catalogue has
 * lost even that. A2A 1.0 lets a card carry JSON Web Signatures (RFC 7515) over its own
 * canonical form, so whoever holds it can check that the party behind a key wrote it
 * and that nobody has altered it since.
 *
 * What is signed is not the bytes that were served. It is the card with its
 * `signatures` removed and its default-valued fields dropped, serialised by the JSON
 * Canonicalization Scheme (RFC 8785), so that a peer who parsed the card and wrote it
 * out again in another language still arrives at the same bytes. The default-dropping
 * step is where implementations disagree most easily, so it is done here from a table
 * transcribed from `a2a.proto`: a field marked REQUIRED is always kept, a field declared
 * `optional` is kept whenever it is present, and any other field is dropped when it
 * holds its type's default. A field the table does not know is kept as it is.
 *
 * The key is the app's Ed25519 key, the same one its outbound requests are signed with
 * (`botAuth`), and it is named by the same RFC 7638 thumbprint, so one key directory
 * serves both: the `jku` in the signature's header is that directory.
 */

import { KeyObject, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

import { KEY_DIRECTORY_PATH, thumbprint } from "../botauth.js";
import { outboundFault, type OutboundOptions } from "../outbound.js";

/** One signature on a card: a JWS in its flattened JSON form, without the payload. */
export interface AgentCardSignature {
  /** The protected header, base64url-encoded JSON. */
  protected: string;
  /** The signature, base64url. */
  signature: string;
  /** Unprotected header values, where the signer set any. */
  header?: Record<string, unknown>;
}

/** What signs a card. */
export interface CardSigner {
  /** The Ed25519 private key. */
  privateKey: KeyObject | JsonWebKey;
  /** The key's id. Defaults to its RFC 7638 thumbprint, which is how the key directory finds it. */
  kid?: string;
  /** Where a verifier fetches the public key: an https URL of a JWK Set. */
  jku?: string;
}

/**
 * RFC 8785: the one way to write a JSON value down.
 *
 * Members sorted by their names as UTF-16 code units, no whitespace, strings and numbers
 * exactly as ECMAScript serialises them. `JSON.stringify` already does the last two the
 * way the RFC requires; the sort is the part it leaves to the caller. A value JSON has
 * no word for (`undefined`, a function) is left out of an object, as it is by
 * `JSON.stringify`; a number that is not finite is refused, because the RFC forbids it.
 */
export function jcs(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("a number that is not finite has no canonical JSON form");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => (entry === undefined ? "null" : jcs(entry))).join(",")}]`;
  if (typeof value === "object") {
    const members: string[] = [];
    // The default sort compares UTF-16 code units, which is the order the RFC names.
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member === undefined || typeof member === "function" || typeof member === "symbol") continue;
      members.push(`${JSON.stringify(key)}:${jcs(member)}`);
    }
    return `{${members.join(",")}}`;
  }
  throw new Error(`a ${typeof value} has no JSON form`);
}

/**
 * How each field of a card is kept, from `a2a.proto` at v1.0.1.
 *
 *   r  REQUIRED: always kept            o  `optional`: kept when present
 *   d  neither: dropped at its default  *  opaque (`google.protobuf.Struct`): kept verbatim
 *
 * A type after the colon is what the field holds, as one message, a list of them, or
 * (with `{}`) a map of them.
 */
const SHAPES: Record<string, Record<string, string>> = {
  AgentCard: {
    name: "r",
    description: "r",
    supportedInterfaces: "r:AgentInterface",
    provider: "d:AgentProvider",
    version: "r",
    documentationUrl: "o",
    capabilities: "r:AgentCapabilities",
    securitySchemes: "d{}:SecurityScheme",
    securityRequirements: "d:SecurityRequirement",
    defaultInputModes: "r",
    defaultOutputModes: "r",
    skills: "r:AgentSkill",
    iconUrl: "o",
  },
  AgentInterface: { url: "r", protocolBinding: "r", tenant: "d", protocolVersion: "r" },
  AgentProvider: { url: "r", organization: "r" },
  AgentCapabilities: { streaming: "o", pushNotifications: "o", extensions: "d:AgentExtension", extendedAgentCard: "o" },
  AgentExtension: { uri: "d", description: "d", required: "d", params: "*" },
  AgentSkill: {
    id: "r",
    name: "r",
    description: "r",
    tags: "r",
    examples: "d",
    inputModes: "d",
    outputModes: "d",
    securityRequirements: "d:SecurityRequirement",
  },
  SecurityRequirement: { schemes: "d{}:StringList" },
  StringList: { list: "d" },
  SecurityScheme: {
    apiKeySecurityScheme: "d:APIKeySecurityScheme",
    httpAuthSecurityScheme: "d:HTTPAuthSecurityScheme",
    oauth2SecurityScheme: "d:OAuth2SecurityScheme",
    openIdConnectSecurityScheme: "d:OpenIdConnectSecurityScheme",
    mtlsSecurityScheme: "d:MutualTlsSecurityScheme",
  },
  APIKeySecurityScheme: { description: "d", location: "r", name: "r" },
  HTTPAuthSecurityScheme: { description: "d", scheme: "r", bearerFormat: "d" },
  OAuth2SecurityScheme: { description: "d", flows: "r:OAuthFlows", oauth2MetadataUrl: "d" },
  OpenIdConnectSecurityScheme: { description: "d", openIdConnectUrl: "r" },
  MutualTlsSecurityScheme: { description: "d" },
  OAuthFlows: {
    authorizationCode: "d:AuthorizationCodeOAuthFlow",
    clientCredentials: "d:ClientCredentialsOAuthFlow",
    implicit: "d:ImplicitOAuthFlow",
    password: "d:PasswordOAuthFlow",
    deviceCode: "d:DeviceCodeOAuthFlow",
  },
  AuthorizationCodeOAuthFlow: { authorizationUrl: "r", tokenUrl: "r", refreshUrl: "d", scopes: "r", pkceRequired: "d" },
  ClientCredentialsOAuthFlow: { tokenUrl: "r", refreshUrl: "d", scopes: "r" },
  ImplicitOAuthFlow: { authorizationUrl: "d", refreshUrl: "d", scopes: "d{}" },
  PasswordOAuthFlow: { tokenUrl: "d", refreshUrl: "d", scopes: "d{}" },
  DeviceCodeOAuthFlow: { deviceAuthorizationUrl: "r", tokenUrl: "r", refreshUrl: "d", scopes: "r" },
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One message with its default-valued fields dropped, by the table above. */
function pruned(value: Record<string, unknown>, type: string): Record<string, unknown> {
  const shape = SHAPES[type] ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (member === undefined) continue;
    const rule = shape[key];
    // Unknown to the table: a later revision's field, or an extension's. Kept as sent.
    if (!rule || rule === "*") {
      out[key] = member;
      continue;
    }
    const [how, of] = rule.split(":") as [string, string | undefined];
    const keep = how[0];
    const map = how.endsWith("{}");

    let inner: unknown = member;
    if (of && Array.isArray(member)) inner = member.map((entry) => (isObject(entry) ? pruned(entry, of) : entry));
    else if (of && map && isObject(member)) {
      inner = Object.fromEntries(Object.entries(member).map(([name, entry]) => [name, isObject(entry) ? pruned(entry, of) : entry]));
    } else if (of && isObject(member)) inner = pruned(member, of);

    if (keep === "r") {
      out[key] = inner;
      continue;
    }
    // JSON `null` is how ProtoJSON writes "not set", for an optional field as for any other.
    if (inner === null) continue;
    if (keep === "o") {
      out[key] = inner;
      continue;
    }
    const empty =
      inner === "" ||
      inner === false ||
      inner === 0 ||
      (Array.isArray(inner) && !inner.length) ||
      // An empty map is a default. An empty MESSAGE is not: being set is itself the value.
      (map && isObject(inner) && !Object.keys(inner).length);
    if (!empty) out[key] = inner;
  }
  return out;
}

/** The bytes a card's signatures are over: the card without them, pruned and canonicalised. */
export function cardPayload(card: Record<string, unknown>): string {
  const { signatures: _signatures, ...rest } = card;
  return jcs(pruned(rest, "AgentCard"));
}

const b64u = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

function privateKeyOf(key: KeyObject | JsonWebKey): KeyObject {
  const object = key instanceof KeyObject ? key : createPrivateKey({ key, format: "jwk" });
  if (object.type !== "private" || object.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `an agent card is signed with the private half of an Ed25519 key, and this is a ${object.type} ` +
        `${object.asymmetricKeyType ?? "key"}. Generate one with generateKeyPairSync("ed25519").`,
    );
  }
  return object;
}

/**
 * A card with a signature added.
 *
 * The protected header says `alg: "EdDSA"` (RFC 8037: Ed25519 in JOSE), `typ: "JOSE"`
 * and the key's id, and names the key set where the signer gave one. A card that is
 * already signed keeps the signatures it has, which is how a key is rotated: both are
 * good for as long as both keys are published.
 */
export function signAgentCard(card: Record<string, unknown>, signer: CardSigner): Record<string, unknown> {
  const key = privateKeyOf(signer.privateKey);
  if (signer.jku !== undefined && !/^https:\/\//i.test(signer.jku)) {
    throw new Error(`a card's jku must be an https URL; got ${JSON.stringify(signer.jku)}`);
  }
  const header = b64u(
    JSON.stringify({
      alg: "EdDSA",
      typ: "JOSE",
      kid: signer.kid ?? thumbprint(key),
      ...(signer.jku ? { jku: signer.jku } : {}),
    }),
  );
  const signature = sign(null, Buffer.from(`${header}.${b64u(cardPayload(card))}`, "ascii"), key);
  const existing = Array.isArray(card.signatures) ? (card.signatures as AgentCardSignature[]) : [];
  return { ...card, signatures: [...existing, { protected: header, signature: signature.toString("base64url") }] };
}

/** The signer for an app that signs its requests: the same key, found in the same directory. */
export function cardSignerFor(botAuth: { privateKey: KeyObject | JsonWebKey; agent: string }): CardSigner {
  return {
    privateKey: botAuth.privateKey,
    jku: `${botAuth.agent.replace(/\/+$/, "")}${KEY_DIRECTORY_PATH}`,
  };
}

export type CardVerification =
  | { ok: true; kid: string; alg: string; jku?: string }
  | { ok: false; reason: string };

/** The key in a set that a signature's `kid` names: by its own `kid`, or by its thumbprint. */
function keyFor(jwks: { keys: JsonWebKey[] }, kid: string): JsonWebKey | undefined {
  return jwks.keys.find((candidate) => {
    if ((candidate as { kid?: unknown }).kid === kid) return true;
    if (candidate.kty !== "OKP" || candidate.crv !== "Ed25519") return false;
    try {
      return thumbprint(candidate) === kid;
    } catch {
      return false;
    }
  });
}

/**
 * Check a card's signatures against a set of public keys.
 *
 * True of a card when at least one of its signatures is good: made over this card's
 * canonical form, by a key in `jwks` that the signature's `kid` names. Answers with the
 * reason otherwise and does not throw, because an unsigned or badly signed card is an
 * ordinary thing to be handed and what to do about it is the caller's decision.
 *
 * `jwks` is the set the caller trusts for this agent: one it already holds, or one it
 * fetched from somewhere it has reason to believe. A `jku` in the signature is a hint
 * about where to look and proves nothing by being there; `fetchAgentCard` is where
 * that decision is made. Ed25519 (`EdDSA`, or `Ed25519` as RFC 9864 respells it),
 * `ES256` and `RS256` are verified. `alg: none` and anything else are refused.
 */
export function verifyAgentCard(card: unknown, jwks: { keys: JsonWebKey[] }): CardVerification {
  if (!isObject(card)) return { ok: false, reason: "the card is not an object" };
  const signatures = card.signatures;
  if (!Array.isArray(signatures) || !signatures.length) return { ok: false, reason: "the card carries no signatures" };

  let payload: string;
  try {
    payload = b64u(cardPayload(card));
  } catch (err) {
    return { ok: false, reason: `the card has no canonical form: ${(err as Error).message}` };
  }

  let reason = "no signature on the card could be checked";
  for (const entry of signatures as unknown[]) {
    if (!isObject(entry) || typeof entry.protected !== "string" || typeof entry.signature !== "string") {
      reason = "a signature on the card is missing its protected header or its value";
      continue;
    }
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(entry.protected, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      reason = "a signature's protected header is not base64url-encoded JSON";
      continue;
    }
    const { alg, kid, jku } = header;
    if (typeof alg !== "string" || typeof kid !== "string") {
      reason = "a signature's protected header must state alg and kid";
      continue;
    }
    // A header parameter this verifier must understand and does not: RFC 7515 says refuse.
    if (header.crit !== undefined) {
      reason = `the signature by "${kid}" marks header parameters as critical that this verifier does not implement`;
      continue;
    }
    const jwk = keyFor(jwks, kid);
    if (!jwk) {
      reason = `no key in the set is named "${kid}"`;
      continue;
    }
    const input = Buffer.from(`${entry.protected}.${payload}`, "ascii");
    const offered = Buffer.from(entry.signature, "base64url");
    let good = false;
    try {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      const type = key.asymmetricKeyType;
      if ((alg === "EdDSA" || alg === "Ed25519") && type === "ed25519") good = verify(null, input, key, offered);
      else if (alg === "ES256" && type === "ec" && jwk.crv === "P-256") {
        good = verify("sha256", input, { key, dsaEncoding: "ieee-p1363" }, offered);
      } else if (alg === "RS256" && type === "rsa") good = verify("sha256", input, key, offered);
      else {
        reason = `the signature by "${kid}" uses alg ${alg}, which this verifier does not accept for that key`;
        continue;
      }
    } catch (err) {
      reason = `the key named "${kid}" could not be used: ${(err as Error).message}`;
      continue;
    }
    if (good) return { ok: true, kid, alg, ...(typeof jku === "string" ? { jku } : {}) };
    reason = `the signature by "${kid}" does not match the card`;
  }
  return { ok: false, reason };
}

export interface FetchAgentCardOptions extends OutboundOptions {
  fetch?: typeof fetch;
  /**
   * Keys already held for this agent. A card signed by one of them is verified
   * without fetching anything, and is the strongest check there is: the key did not
   * come from the party being checked.
   */
  keys?: { keys: JsonWebKey[] };
  /**
   * Origins whose key sets are believed, e.g. `["https://keys.example"]`. A signature
   * whose `jku` is under one of them is checked against the set fetched from it. The
   * card's own origin is always among them: a key set served beside the card proves at
   * least that the card was not altered after that origin signed it.
   */
  trust?: string[];
  /**
   * What an unsigned or unverifiable card is: `"refuse"` throws, `"allow"` returns it
   * marked unverified. Default `"allow"`, because most cards are not signed yet; an
   * app that will only talk to agents it can verify sets `"refuse"`.
   */
  unsigned?: "allow" | "refuse";
  signal?: AbortSignal;
}

/** A peer's card, and whether its signature held. */
export interface FetchedAgentCard {
  card: Record<string, unknown>;
  /** Set when a signature verified: which key, and where it came from. */
  verified?: { kid: string; alg: string; from: "held" | "jku"; jku?: string };
  /** Why not, when it did not. */
  unverified?: string;
}

/** Where an agent's card is, given the agent's address or the card's own. */
function cardUrl(address: string): string {
  const url = new URL(address);
  if (url.pathname.endsWith("/agent-card.json")) return url.href;
  return new URL("/.well-known/agent-card.json", url.origin).href;
}

/**
 * Fetch a peer's agent card and check its signature before anything is believed.
 *
 * The keys already held are tried first. Failing that, a signature that names a key set
 * (`jku`) under an origin the caller trusts is checked against that set, fetched over
 * https from an address that is not a private one: a `jku` is the peer's own claim
 * about where its keys are, and following it blindly would let a card choose what this
 * machine requests. Redirects are not followed, for the card or for the keys.
 */
export async function fetchAgentCard(address: string, options: FetchAgentCardOptions = {}): Promise<FetchedAgentCard> {
  const send = options.fetch ?? fetch;
  const at = cardUrl(address);
  const response = await send(at, { headers: { accept: "application/json" }, redirect: "manual", signal: options.signal });
  if (!response.ok) throw new Error(`the agent card at ${at} answered ${response.status}`);
  const card = (await response.json()) as unknown;
  if (!isObject(card)) throw new Error(`the agent card at ${at} is not a JSON object`);

  const settle = (unverified: string): FetchedAgentCard => {
    if (options.unsigned === "refuse") throw new Error(`the agent card at ${at} was not accepted: ${unverified}`);
    return { card, unverified };
  };

  if (options.keys) {
    const held = verifyAgentCard(card, options.keys);
    if (held.ok) return { card, verified: { kid: held.kid, alg: held.alg, from: "held" } };
    if (!Array.isArray(card.signatures) || !card.signatures.length) return settle(held.reason);
  }
  if (!Array.isArray(card.signatures) || !card.signatures.length) return settle("the card carries no signatures");

  const trusted = new Set([new URL(at).origin, ...(options.trust ?? []).map((origin) => new URL(origin).origin)]);
  let reason = "none of the card's signatures names a key set this caller trusts";
  const tried = new Set<string>();
  for (const entry of card.signatures as unknown[]) {
    let jku: unknown;
    try {
      jku = isObject(entry) && typeof entry.protected === "string"
        ? (JSON.parse(Buffer.from(entry.protected, "base64url").toString("utf8")) as { jku?: unknown }).jku
        : undefined;
    } catch {
      continue;
    }
    if (typeof jku !== "string" || tried.has(jku)) continue;
    tried.add(jku);
    if (!URL.canParse(jku) || !trusted.has(new URL(jku).origin)) {
      reason = `the card's keys are at ${jku}, which is not an origin this caller trusts`;
      continue;
    }
    const fault = await outboundFault(jku, options);
    if (fault) {
      reason = `the card's key set at ${jku} was not fetched: ${fault}`;
      continue;
    }
    try {
      const got = await send(jku, { headers: { accept: "application/json" }, redirect: "manual", signal: options.signal });
      if (!got.ok) {
        reason = `the card's key set at ${jku} answered ${got.status}`;
        continue;
      }
      const jwks = (await got.json()) as { keys?: unknown };
      if (!Array.isArray(jwks?.keys)) {
        reason = `what is at ${jku} is not a JWK Set`;
        continue;
      }
      const checked = verifyAgentCard(card, { keys: jwks.keys as JsonWebKey[] });
      if (checked.ok && checked.jku === jku) return { card, verified: { kid: checked.kid, alg: checked.alg, from: "jku", jku } };
      reason = checked.ok ? "the signature that verified names a different key set" : checked.reason;
    } catch (err) {
      reason = `the card's key set at ${jku} could not be read: ${(err as Error).message}`;
    }
  }
  return settle(reason);
}
