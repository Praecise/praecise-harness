/**
 * `{{ref}}` substitution. A string that is nothing but a reference resolves to
 * the referenced value with its type intact, so `with: "{{draft}}"` hands an
 * object to a tool rather than the string "[object Object]". Anywhere else,
 * references are rendered into the surrounding text.
 */

const WHOLE = /^\s*\{\{\s*([\w.[\]-]+)\s*\}\}\s*$/;
const INLINE = /\{\{\s*([\w.[\]-]+)\s*\}\}/g;

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
  const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);

  if (scope && typeof scope === "object" && !Array.isArray(scope)) {
    const record = scope as Record<string, unknown>;
    for (let take = segments.length; take > 1; take--) {
      const key = segments.slice(0, take).join(".");
      if (key in record) return walk(record[key], segments.slice(take));
    }
  }

  return walk(scope, segments);
}

function render(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

/** Substitute references throughout a value of any shape. */
export function interpolate<T>(value: T, scope: Record<string, unknown>): T {
  if (typeof value === "string") {
    const whole = value.match(WHOLE);
    if (whole) return resolvePath(scope, whole[1]!) as T;
    return value.replace(INLINE, (_, path: string) =>
      render(resolvePath(scope, path)),
    ) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolate(item, scope)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = interpolate(item, scope);
    return out as T;
  }
  return value;
}
