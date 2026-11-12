/**
 * Saying who is calling, in a way the server can check: Web Bot Auth.
 *
 * A server deciding whether to answer an agent has had a User-Agent string and an IP
 * range to go on, and both are claims anyone can make. Web Bot Auth
 * (draft-ietf-webbotauth-httpsig-protocol-01) replaces the claim with a signature: each
 * request carries an RFC 9421 HTTP Message Signature made with an Ed25519 key, and
 * names the origin whose key directory holds the public half. The server fetches the
 * directory, finds the key by its thumbprint, and knows the request came from whoever
 * controls that origin.
 *
 * The app's injected fetch is the one way out to the network, so wrapping it signs every
 * request the app makes — tool calls and model calls alike — and nothing has to remember to.
 *
 * What is here: signing, the key directory's body, and a verifier for the same profile.
 * What is not: the directory response is served unsigned (the directory draft lets a
 * server sign it to prove it holds the keys), and the verifier does not remember nonces,
 * so refusing a replay inside the validity window is left to the caller, who is handed
 * the nonce.
 */

import { KeyObject, createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";

/** Where a verifier looks for an agent's public keys, under the origin `Signature-Agent` names. */
export const KEY_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";

/** The media type the key directory is served with. */
export const KEY_DIRECTORY_TYPE = "application/http-message-signatures-directory+json";

/** The `tag` that marks a signature as this profile's, so a verifier knows which rules apply. */
export const WEB_BOT_AUTH_TAG = "web-bot-auth";

/** One label for the signature and for the `Signature-Agent` member it covers. */
const LABEL = "sig1";

export interface BotSigner {
  /** The Ed25519 private key requests are signed with. */
  privateKey: KeyObject | JsonWebKey;
  /** The https origin that serves this key's directory at `KEY_DIRECTORY_PATH`. */
  agent: string;
  /** How long a signature stays valid, in seconds. Default 60: long enough to arrive, short enough to be useless stolen. */
  ttlSeconds?: number;
  /** The clock, in milliseconds. Defaults to `Date.now`; a test brings its own. */
  now?: () => number;
}

/** The public half of an Ed25519 key, in the only three members its thumbprint is taken over. */
export interface Ed25519PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

/** The parameters of one signature. `created` and `expires` are seconds since the epoch. */
export interface SignatureParams {
  created: number;
  expires: number;
  keyid: string;
  nonce: string;
  /** Defaults to `web-bot-auth`. */
  tag?: string;
}

function publicJwk(key: KeyObject | JsonWebKey): Ed25519PublicJwk {
  let object: KeyObject;
  try {
    object =
      key instanceof KeyObject
        ? key.type === "public"
          ? key
          : createPublicKey(key)
        : createPublicKey({ key, format: "jwk" });
  } catch (cause) {
    throw new Error(
      `this is not a key Web Bot Auth can use (${(cause as Error).message}). ` +
        `Pass an Ed25519 key as a KeyObject or a JWK, e.g. generateKeyPairSync("ed25519").privateKey.`,
      { cause },
    );
  }
  if (object.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `Web Bot Auth signs with Ed25519, and this key is ${object.asymmetricKeyType ?? object.type}. ` +
        `Generate one with generateKeyPairSync("ed25519").`,
    );
  }
  const { x } = object.export({ format: "jwk" });
  return { kty: "OKP", crv: "Ed25519", x: x! };
}

/**
 * The RFC 7638 SHA-256 thumbprint of an Ed25519 key, base64url — the `keyid` a
 * signature names its key by. Given a private key, it is the public half's thumbprint.
 */
export function thumbprint(key: KeyObject | JsonWebKey): string {
  const { crv, kty, x } = publicJwk(key);
  // RFC 7638: the required members only, in lexicographic order, with no whitespace.
  return createHash("sha256").update(JSON.stringify({ crv, kty, x })).digest("base64url");
}

/**
 * The body of the key directory: a JWKS of the public keys an agent signs with.
 *
 * Private keys are accepted and only their public half is written, so the key handed to
 * `signingFetch` can be handed here unchanged.
 */
export function keyDirectory(keys: (KeyObject | JsonWebKey)[]): { keys: Ed25519PublicJwk[] } {
  return { keys: keys.map(publicJwk) };
}

/**
 * The RFC 9421 signature base for this profile, and the `Signature-Input` value it ends with.
 *
 * `authority` is the host being called, lower-case, with a port only when it is not the
 * scheme's default. `agent` is the URL the `Signature-Agent` header gives under `sig1`.
 * One line per covered component, then the parameters line; no trailing newline.
 */
export function signatureBase(authority: string, agent: string, params: SignatureParams): { base: string; input: string } {
  const input =
    `("@authority" "signature-agent";key="${LABEL}")` +
    `;created=${params.created};expires=${params.expires};keyid="${params.keyid}"` +
    `;alg="ed25519";tag="${params.tag ?? WEB_BOT_AUTH_TAG}";nonce="${params.nonce}"`;
  const base = [
    `"@authority": ${authority}`,
    `"signature-agent";key="${LABEL}": "${agent}"`,
    `"@signature-params": ${input}`,
  ].join("\n");
  return { base, input };
}

/**
 * A fetch that signs every request it sends.
 *
 * Three headers are added: `Signature-Agent` naming where the key directory is,
 * `Signature-Input` saying what was signed, and `Signature`. Each request gets its own
 * nonce and its own short validity, so a captured request is not a reusable one.
 */
export function signingFetch(base: typeof fetch, signer: BotSigner): typeof fetch {
  // Checked once, here, so a bad key or agent fails when the app is assembled rather
  // than on whichever request happens to go out first.
  const key = signer.privateKey instanceof KeyObject ? signer.privateKey : privateKeyFrom(signer.privateKey);
  if (key.type !== "private") {
    throw new Error(`botAuth.privateKey is a ${key.type} key; signing needs the private half of an Ed25519 pair.`);
  }
  const keyid = thumbprint(key);
  const agent = agentOf(signer.agent);
  const ttl = signer.ttlSeconds ?? 60;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error(`botAuth.ttlSeconds is ${String(signer.ttlSeconds)}; it must be a positive number of seconds.`);
  }
  const now = signer.now ?? Date.now;

  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const created = Math.floor(now() / 1000);
    const signed = signatureBase(new URL(url).host, agent, {
      created,
      expires: created + ttl,
      keyid,
      nonce: randomBytes(64).toString("base64"),
    });
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("signature-agent", `${LABEL}="${agent}"`);
    headers.set("signature-input", `${LABEL}=${signed.input}`);
    headers.set("signature", `${LABEL}=:${sign(null, Buffer.from(signed.base), key).toString("base64")}:`);
    return base(input, { ...init, headers });
  };
}

function privateKeyFrom(jwk: JsonWebKey): KeyObject {
  try {
    return createPrivateKey({ key: jwk, format: "jwk" });
  } catch (cause) {
    throw new Error(
      `botAuth.privateKey is not a private JWK (${(cause as Error).message}). ` +
        `Pass the Ed25519 private key, e.g. generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }).`,
      { cause },
    );
  }
}

function agentOf(agent: string): string {
  let protocol = "";
  try {
    protocol = new URL(agent).protocol;
  } catch {
    // Falls through to the refusal below, which says what was given.
  }
  // The value is written inside a quoted string, so it must not be able to end one.
  if (protocol !== "https:" || /["\\]|[^\x20-\x7e]/.test(agent)) {
    throw new Error(
      `botAuth.agent is ${JSON.stringify(agent)}; it must be the https URL of the origin serving your key directory ` +
        `at ${KEY_DIRECTORY_PATH}, e.g. "https://agent.example".`,
    );
  }
  return agent;
}

/** What a verifier is given: where the request was sent, and its headers. */
export interface SignedRequest {
  /** The absolute URL requested. Not needed when `authority` is given or a `Host` header is present. */
  url?: string;
  /** The host the client dialled, when the server knows better than the URL — behind a proxy, say. */
  authority?: string;
  headers: Headers | Record<string, string | string[] | undefined>;
}

export type Verification =
  | {
      ok: true;
      keyid: string;
      /** The origin the signed `Signature-Agent` member says the key directory is at; absent when none was covered by key. */
      agent?: string;
      created: number;
      expires: number;
      /** Remember it for the validity window to refuse a replay; this function does not. */
      nonce?: string;
    }
  | { ok: false; reason: string };

/**
 * Check a request signed under the Web Bot Auth profile against a set of public keys.
 *
 * It answers with the reason rather than throwing, because an unsigned or badly signed
 * request is an ordinary thing for a server to receive and what to do about it is the
 * server's decision. Checked: that a signature tagged `web-bot-auth` is present, that it
 * covers `@authority` (and `Signature-Agent` when one was sent), that it has not
 * expired, that its `keyid` is one of `jwks`, and that the signature is good.
 *
 * `jwks` is the agent's key directory, which the caller fetches from the origin
 * `Signature-Agent` names — or already holds, for agents it knows.
 */
export function verifySignature(
  request: SignedRequest,
  jwks: { keys: JsonWebKey[] },
  options: { now?: () => number } = {},
): Verification {
  const header = (name: string): string | undefined => {
    if (request.headers instanceof Headers) return request.headers.get(name) ?? undefined;
    const value = request.headers[name];
    return Array.isArray(value) ? value.join(", ") : value;
  };
  const refuse = (reason: string): Verification => ({ ok: false, reason });

  const inputs = dictionary(header("signature-input") ?? "");
  const signatures = dictionary(header("signature") ?? "");
  if (!inputs.size || !signatures.size) return refuse("the request carries no Signature-Input and Signature headers");

  let label: string | undefined;
  let covered = "";
  let params: Record<string, string | number> = {};
  for (const [name, value] of inputs) {
    const close = value.startsWith("(") ? value.indexOf(")") : -1;
    if (close < 0) continue;
    const these = parameters(value.slice(close + 1));
    if (these.tag !== WEB_BOT_AUTH_TAG) continue;
    label = name;
    covered = value.slice(1, close);
    params = these;
    break;
  }
  if (!label) return refuse(`no signature on the request is tagged "${WEB_BOT_AUTH_TAG}"`);
  const raw = inputs.get(label)!;

  const { keyid, created, expires, alg, nonce } = params;
  if (typeof keyid !== "string" || typeof created !== "number" || typeof expires !== "number") {
    return refuse("the signature must state created, expires and keyid");
  }
  if (alg !== undefined && alg !== "ed25519") return refuse(`the signature uses alg ${String(alg)}; this profile is ed25519`);
  const now = Math.floor((options.now ?? Date.now)() / 1000);
  if (expires <= now) return refuse(`the signature expired at ${expires}; it is now ${now}`);

  // A server holds a path, not a URL, and what the client dialled is in `Host`.
  const authority =
    request.authority ?? (request.url && URL.canParse(request.url) ? new URL(request.url).host : header("host"));
  if (!authority) return refuse("the request's authority is unknown; pass `authority` or an absolute `url`");

  // The base is rebuilt from the components the signer listed, in its order and spelling:
  // what was signed is the signer's serialisation, and re-deriving it differently would
  // refuse a good signature.
  const agents = dictionary(header("signature-agent") ?? "");
  const lines: string[] = [];
  const names: string[] = [];
  let agent: string | undefined;
  for (const [, name, itemParams = ""] of covered.matchAll(/"([^"\\]*)"((?:;[^\s;]+)*)/g)) {
    names.push(name!);
    let value: string | undefined;
    if (name === "@authority" && !itemParams) {
      value = authority.toLowerCase();
    } else if (name === "signature-agent") {
      const member = parameters(itemParams).key;
      value = itemParams ? (typeof member === "string" ? agents.get(member) : undefined) : header("signature-agent")?.trim();
      // Only a member the signature covers is reported: an uncovered one is anybody's claim.
      if (itemParams && value?.startsWith('"')) agent = value.slice(1, value.indexOf('"', 1));
    } else if (!name!.startsWith("@") && !itemParams) {
      value = header(name!)?.trim();
    }
    if (value === undefined) {
      return refuse(`the signature covers "${name}"${itemParams}, which this verifier cannot read from the request`);
    }
    lines.push(`"${name}"${itemParams}: ${value}`);
  }
  if (!names.includes("@authority")) return refuse('the signature does not cover "@authority", so it is good for any host');
  if (agents.size && !names.includes("signature-agent")) {
    return refuse("a Signature-Agent header was sent but is not covered by the signature");
  }
  lines.push(`"@signature-params": ${raw}`);

  const jwk = jwks.keys.find((candidate) => {
    if (candidate.kty !== "OKP" || candidate.crv !== "Ed25519" || typeof candidate.x !== "string") return false;
    return thumbprint(candidate) === keyid;
  });
  if (!jwk) return refuse(`no key in the directory has the thumbprint ${keyid}`);

  const signature = /^:([A-Za-z0-9+/=]*):$/.exec(signatures.get(label) ?? "")?.[1];
  if (signature === undefined) return refuse(`there is no Signature for "${label}"`);
  const good = verify(
    null,
    Buffer.from(lines.join("\n")),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(signature, "base64"),
  );
  if (!good) return refuse("the signature does not match the request");

  return {
    ok: true,
    keyid,
    agent,
    created,
    expires,
    nonce: typeof nonce === "string" ? nonce : undefined,
  };
}

/** A structured-field dictionary's members, each left as the text it was sent as. */
function dictionary(text: string): Map<string, string> {
  const members = new Map<string, string>();
  let start = 0;
  let quoted = false;
  const take = (end: number): void => {
    const member = text.slice(start, end).trim();
    if (!member) return;
    const equals = member.indexOf("=");
    members.set(equals < 0 ? member : member.slice(0, equals), equals < 0 ? "" : member.slice(equals + 1));
  };
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === "\\" && quoted) at++;
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      take(at);
      start = at + 1;
    }
  }
  take(text.length);
  return members;
}

/** Structured-field parameters (`;name=value`), integers as numbers and strings unquoted. */
function parameters(text: string): Record<string, string | number> {
  const found: Record<string, string | number> = {};
  for (const [, name, value] of text.matchAll(/;\s*([a-z*][a-z0-9_.*-]*)(?:=("(?:[^"\\]|\\.)*"|[^;]*))?/g)) {
    if (value === undefined) continue;
    found[name!] = value.startsWith('"')
      ? value.slice(1, -1).replace(/\\(.)/g, "$1")
      : /^-?\d+$/.test(value)
        ? Number(value)
        : value.trim();
  }
  return found;
}
