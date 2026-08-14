/**
 * `{{ref}}` substitution. A string that is nothing but a reference resolves to
 * the referenced value with its type intact, so `with: "{{draft}}"` hands an
 * object to a tool rather than the string "[object Object]". Anywhere else,
 * references are rendered into the surrounding text.
 *
 * A reference that names nothing is an error rather than an empty string. This
 * is the single most likely mistake in the whole framework — `{{mesage}}` is one
 * keystroke from `{{message}}` — and rendering it away produced the worst
 * possible outcome: "Reply to: " went to the model, the model answered it, and
 * the run reported `done`. Nothing anywhere held the information that the prompt
 * had a hole in it. So the substitution refuses, names what could have been
 * meant, and lists what was actually in scope.
 *
 * The boundary is the head of the path, not the whole of it. `{{prior.draft}}`
 * on a loop's first attempt is a real name holding no value yet, and a step that
 * reads a field a tool did not return is a fact about the data rather than about
 * the template. Only "nothing here has ever been called that" is a typo.
 */

const WHOLE = /^\s*\{\{\s*([\w.[\]-]+)\s*\}\}\s*$/;
const INLINE = /\{\{\s*([\w.[\]-]+)\s*\}\}/g;

function segmentsOf(path: string): string[] {
  return path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
}

function walk(scope: unknown, segments: string[]): unknown {
  let current = scope;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Walk a dotted path, tolerating `a.0.b` and `a[0].b`.
 *
 * A step inside a branch or a loop is recorded under its full scoped id —
 * `"reply.draft"` is one key, not a nested object — so the longest literal key
 * wins before dots are read as nesting. That is what lets `{{reply.draft}}` and
 * `{{sorted.category}}` both mean what the author intended.
 */
export function resolvePath(scope: unknown, path: string): unknown {
  const segments = segmentsOf(path);

  if (scope && typeof scope === "object" && !Array.isArray(scope)) {
    const record = scope as Record<string, unknown>;
    for (let take = segments.length; take > 1; take--) {
      const key = segments.slice(0, take).join(".");
      if (key in record) return walk(record[key], segments.slice(take));
    }
  }

  return walk(scope, segments);
}

/**
 * Is there anything in scope this reference could be about?
 *
 * Own keys only, and by presence rather than by value: a step that produced
 * `undefined` is still a step that ran, and `{{that}}` is still a reference to
 * it. Reading the prototype instead would make `{{constructor}}` resolve.
 */
function bound(scope: Record<string, unknown>, path: string): boolean {
  const segments = segmentsOf(path);
  for (let take = segments.length; take >= 1; take--) {
    if (Object.hasOwn(scope, segments.slice(0, take).join("."))) return true;
  }
  return false;
}

/** Levenshtein distance, stopped early once it is past anything worth suggesting. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, at) => at);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + cost);
      row.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    previous = row;
  }
  return previous[b.length]!;
}

/**
 * The name most likely to have been meant, if one is close enough.
 *
 * Deliberately stingy: a suggestion that is wrong sends the author looking in
 * the wrong file, which is worse than no suggestion beside a list of what is
 * actually there.
 */
function nearest(name: string, options: string[]): string | undefined {
  const limit = name.length <= 4 ? 1 : 2;
  let best: { name: string; at: number } | undefined;
  for (const option of options) {
    const at = distance(name.toLowerCase(), option.toLowerCase(), limit);
    if (at <= limit && (!best || at < best.at)) best = { name: option, at };
  }
  return best?.name;
}

/** Enough names to recognise the right one by, without printing a whole run. */
const SHOWN = 24;

function unresolved(path: string, scope: Record<string, unknown>, where?: string): Error {
  const available = Object.keys(scope).sort();
  const head = segmentsOf(path)[0] ?? path;
  const guess = nearest(head, available);
  const listed =
    available.length > SHOWN
      ? `${available.slice(0, SHOWN).join(", ")}, and ${available.length - SHOWN} more`
      : available.join(", ");

  return new Error(
    `${where ? `${where}: ` : ""}nothing in scope is called "${head}", ` +
      `so \`{{${path}}}\` would be filled in with nothing at all. ` +
      (guess ? `Did you mean \`{{${path.replace(head, guess)}}}\`? ` : "") +
      `What is in scope here: ${listed || "nothing yet — this is the first thing to run"}.`,
  );
}

function render(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

/**
 * Substitute references throughout a value of any shape.
 *
 * `where` is only ever read back to whoever wrote the template — the step or the
 * prompt this value came off — so a refusal says which line to go and look at.
 */
export function interpolate<T>(value: T, scope: Record<string, unknown>, where?: string): T {
  if (typeof value === "string") {
    const whole = value.match(WHOLE);
    if (whole) {
      if (!bound(scope, whole[1]!)) throw unresolved(whole[1]!, scope, where);
      return resolvePath(scope, whole[1]!) as T;
    }
    return value.replace(INLINE, (_, path: string) => {
      if (!bound(scope, path)) throw unresolved(path, scope, where);
      return render(resolvePath(scope, path));
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolate(item, scope, where)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = interpolate(item, scope, where);
    return out as T;
  }
  return value;
}
