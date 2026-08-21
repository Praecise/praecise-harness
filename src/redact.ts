/**
 * What an error is allowed to say once it leaves the process that raised it.
 *
 * An exception message is written for whoever is reading the log, and the
 * quickest way to make one useful is to quote what came back. That is fine
 * until the message is persisted onto a run record and served to whoever can
 * reach the port: a provider's 401 body carries the key that failed, a store's
 * connect error carries the DSN, and both are then part of the audit trail
 * forever. Neither of those is something a framework can fix at the point they
 * are raised, because it does not raise most of them.
 *
 * So there are two rules here, applied at every boundary a message crosses.
 * Anything shaped like a credential is replaced. And an error carrying a verbatim
 * upstream body — which is the one class of message that is unbounded and
 * attacker-influenced at once — is reduced to the fact that the upstream refused,
 * with the detail left in the log where it belongs.
 */

/**
 * Things that are credentials wherever they appear.
 *
 * Ordered longest-context-first so a specific pattern claims the text before a
 * general one gets to it. Every pattern is anchored on how the secret is
 * introduced (`Bearer `, `api_key=`, a known key prefix) rather than on entropy:
 * guessing from shape alone redacts commit hashes, run ids and base64 payloads,
 * and a redactor that eats ordinary text gets turned off.
 *
 * The lead-in is necessary and, for the two words English also uses, not
 * sufficient — see `looksLikeSecret`.
 */

/**
 * Is this the value of a credential, or is it the next word of a sentence?
 *
 * `Bearer`, `Basic`, `Token` and `authorization` are how a credential is
 * introduced AND how English writes about one. Anchored on the lead-in alone,
 * "Basic understanding of the schema is required" comes back as "Basic
 * [redacted] of the schema", "Token exchanged successfully" loses the verb, and
 * "authorization: denied by policy" stops saying why. This module's own note at
 * the top is that a redactor which eats ordinary text gets turned off — and a
 * redactor that is off leaks every credential it would ever have caught, so
 * mangling prose is a safety failure and not only a cosmetic one.
 *
 * An ordinary word is defined as narrowly as it can be, because the trade runs
 * the other way too: a run of letters, all lower case or capitalised and then
 * all lower case, up to 23 long. That is the shape English has and credentials
 * do not. Hex has digits. Base64 has mixed case, digits and padding. A JWT has
 * dots. Every vendor prefix has a hyphen or an underscore. `dXNlcjpwYXNz` — a
 * real Basic value — has capitals inside it and is caught.
 *
 * What is given up, exactly: a secret introduced by one of those four words and
 * made of nothing but 23 or fewer lower-case letters. Nothing else. Everything
 * with a digit or a separator anywhere in it, and every all-letter run of 24 or
 * more, is still a secret here. Applied only to those four lead-ins — the
 * `api_key=`/`password:` family is redacted whatever the value looks like,
 * because a password really can be a word.
 */
function looksLikeSecret(value: string): boolean {
  return !/^[A-Z]?[a-z]{1,23}$/.test(value);
}

/**
 * The value half of a `name=value` dump.
 *
 * Brackets are excluded from BOTH ends, and the opening one is what makes
 * `redact` idempotent. `[redacted]` is what the rules above write, and a value
 * class that admits `[` but not `]` consumes the marker and leaves the bracket
 * behind: `api_key=[redacted]]`, then `]]]`, a bracket for every boundary the
 * message crosses. A credential in a query string, an env line or a JSON body
 * does not contain a bracket, so refusing to start on one costs nothing.
 */
const DUMPED_VALUE = String.raw`[^\s,;&"'}\])[]`;

/**
 * A rule replaces with a string, or — where the lead-in is also an English word
 * — with a function that leaves the sentence alone.
 *
 * The pattern keeps its `i` flag either way. Case-insensitivity is right for the
 * lead-in (`bearer` and `Authorization` are both real) and would be fatal inside
 * a test that turns on case, which is why `looksLikeSecret` is a separate,
 * case-sensitive expression rather than a lookahead in the same regex.
 */
type Rule = {
  pattern: RegExp;
  replace: string | ((whole: string, lead: string, gap: string, value: string) => string);
};

/** Redact the value, or hand the sentence back untouched. */
const ifSecret = (whole: string, lead: string, gap: string, value: string): string =>
  looksLikeSecret(value) ? `${lead}${gap}[redacted]` : whole;

const CREDENTIALS: Rule[] = [
  // Authorization headers, however they are quoted.
  { pattern: /\b(Bearer|Basic|Token)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi, replace: ifSecret },
  // Known vendor key prefixes. These are worth naming individually: a leaked one
  // is live until it is rotated, and the prefix is what makes it recognisable.
  { pattern: /\b(sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xox[abposr]|AKIA|ASIA)[-_][A-Za-z0-9_-]{8,}/g, replace: "[redacted]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[redacted]" },
  { pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}/g, replace: "[redacted jwt]" },
  // A named secret in a query string, a header dump, an env line or a JSON body.
  // `authorization` is deliberately not on this list — see the rule after it.
  {
    pattern: new RegExp(
      String.raw`\b(api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|credential)\b(\s*[:=]\s*|"\s*:\s*")\s*"?${DUMPED_VALUE}{4,}"?`,
      "gi",
    ),
    replace: "$1$2[redacted]",
  },
  // `authorization: <value>` is the one name on that list that is also a
  // sentence, so it gets the same treatment as the header words above. Nothing
  // is given up by it: a real header value is either `Bearer …`/`Basic …`, which
  // the first rule has already taken, or a bare token, which is unwordlike.
  {
    pattern: new RegExp(
      String.raw`\b(authorization)(\s*[:=]\s*|"\s*:\s*")\s*"?(${DUMPED_VALUE}{4,})"?`,
      "gi",
    ),
    replace: ifSecret,
  },
  // Credentials inside a connection string: postgres://user:pw@host.
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, replace: "$1$2:[redacted]@" },
];

/**
 * Replace anything credential-shaped.
 *
 * Idempotent — `redact(redact(t)) === redact(t)` — and that is a property of the
 * rules rather than a hope: nothing any rule writes is matched by any rule,
 * including itself. It has to be. `safeMessage` runs at every boundary a message
 * crosses, so a failure that passes through the runner and then the server is
 * redacted two or three times before anyone reads it, and a rule that consumed
 * its own marker made the message worse on each hop.
 */
export function redact(text: string): string {
  let out = text;
  for (const { pattern, replace } of CREDENTIALS) {
    out =
      typeof replace === "string" ? out.replace(pattern, replace) : out.replace(pattern, replace);
  }
  return out;
}

/**
 * Is this an error that quoted an upstream response body verbatim?
 *
 * Matched by name rather than by `instanceof` on purpose: the error may have
 * crossed a module boundary, been re-thrown, or been rebuilt from a structured
 * clone, and every one of those breaks identity while leaving the body in place.
 */
function quotesUpstream(err: unknown): err is { provider?: string; status?: number } {
  return Boolean(err) && (err as Error).name === "ProviderError";
}

/**
 * The text a thrown thing is trying to say.
 *
 * `String(err)` alone is right for a string, a number and a null, and useless for
 * the one case that carries the diagnosis: a plain object with a `message`. That
 * is exactly what an `Error` looks like after a structured clone out of a worker
 * or off a message port, and `"[object Object]"` is what the caller was being
 * handed instead. Failing safe, but failing blind.
 *
 * Only a string `message` is taken, and what comes back goes through `redact`
 * like any other message, so reading it widens what may be SAID and not what may
 * be leaked. An object with no string `message` still stringifies as before.
 */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const said = (err as { message?: unknown }).message;
    if (typeof said === "string") return said;
  }
  return String(err);
}

/**
 * What a caller may be told about a failure, and what only the log may know.
 *
 * The full error is written to stderr under `where`, so nothing is lost — it
 * moves from a surface a stranger can read to one only the operator can.
 */
export function safeMessage(err: unknown, where: string): string {
  console.error(`praecise: ${where}:`, err);

  if (quotesUpstream(err)) {
    const at = err.provider ? `the ${err.provider} endpoint` : "a model endpoint";
    const status = typeof err.status === "number" ? ` responded ${err.status}` : " refused the request";
    return `${at}${status}. What it said is in the server log — it is not repeated here because a provider's body can carry the credential that failed.`;
  }

  return redact(messageOf(err));
}
