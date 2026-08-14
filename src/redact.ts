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
 */
const CREDENTIALS: { pattern: RegExp; replace: string }[] = [
  // Authorization headers, however they are quoted.
  { pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: "$1 [redacted]" },
  // Known vendor key prefixes. These are worth naming individually: a leaked one
  // is live until it is rotated, and the prefix is what makes it recognisable.
  { pattern: /\b(sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xox[abposr]|AKIA|ASIA)[-_][A-Za-z0-9_-]{8,}/g, replace: "[redacted]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[redacted]" },
  { pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}/g, replace: "[redacted jwt]" },
  // A named secret in a query string, a header dump, an env line or a JSON body.
  {
    pattern:
      /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|authorization|credential)\b(\s*[:=]\s*|"\s*:\s*")\s*"?[^\s,;&"'}\])]{4,}"?/gi,
    replace: "$1$2[redacted]",
  },
  // Credentials inside a connection string: postgres://user:pw@host.
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, replace: "$1$2:[redacted]@" },
];

/** Replace anything credential-shaped. Safe to apply more than once. */
export function redact(text: string): string {
  let out = text;
  for (const { pattern, replace } of CREDENTIALS) out = out.replace(pattern, replace);
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

  const message = err instanceof Error ? err.message : String(err);
  return redact(message);
}
