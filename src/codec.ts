/**
 * Dialect codec — the mechanism for a compressed-but-legible internal notation.
 *
 * praecise ships the ENGINE, not the vocabulary. An app defines its own message
 * types (its dialect) over `defineDialect`, because a dialect compresses against a
 * shared codebook and that codebook is the app's domain. Each message has a terse
 * condensed wire form and a lossless expansion to a self-describing, schema-tagged
 * object for any boundary a human must audit.
 *
 * The safety properties enforced here: decode REFUSES a version, unknown-tag or
 * duplicate-tag mismatch, so a drifted codebook is caught, never silently
 * mis-decoded; and the wire delimiters (`|`, `=`, `,`) are backslash-escaped inside
 * string and list values, so a hostile value cannot forge a field. Values free of
 * delimiter characters encode byte-identically to the unescaped form — escaping is
 * internal to encode/decode and invisible on clean wires. The lossless-round-trip
 * property (decode(encode(x)) === x) is the app's to assert over its own specs.
 */

export interface FieldCodec<T> {
  enc(v: T): string;
  dec(s: string): T;
}

export interface Field {
  key: string;
  tag: string;
  opt?: boolean;
  codec: FieldCodec<unknown>;
}

export interface MessageSpec {
  schema: string;
  fields: Field[];
}

// ── Escaping ───────────────────────────────────────────────────────────────
// Deterministic backslash escaping over exactly the wire's structural characters:
// `|` separates fields, `=` splits tag from value, `,` separates list elements,
// and `\` is the escape itself. Nothing else is touched, which is what keeps a
// clean value's wire form byte-identical to the pre-escaping format.

const esc = (s: string): string => s.replace(/[\\|=,]/g, (c) => `\\${c}`);
const unesc = (s: string): string => s.replace(/\\(.)/g, "$1");

/** Split on a delimiter, honouring backslash escapes, keeping the raw segments. */
function splitUnescaped(s: string, delim: string): string[] {
  const parts: string[] = [];
  let part = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length) {
      part += c + s[++i]!;
    } else if (c === delim) {
      parts.push(part);
      part = "";
    } else {
      part += c;
    }
  }
  parts.push(part);
  return parts;
}

export const str: FieldCodec<string> = { enc: (v) => esc(String(v)), dec: (s) => unesc(s) };
/**
 * A number, and only a number.
 *
 * `Number("")` is 0 and `Number("oops")` is NaN, and NaN is the dangerous one: it
 * passes the required-field check (`NaN == null` is false), survives into the
 * decoded message, and then every comparison made against it is false — so a
 * limit is never exceeded, a total never matches, and nothing anywhere reports a
 * problem. Refusing at the codec is the only place that failure is still legible.
 */
function finite(s: string, what: string): number {
  // `Number("")` is 0, so an empty value would decode as a legitimate zero. A
  // field that carried nothing did not carry a number.
  if (s === "") throw new Error(`a ${what} field arrived empty — that is a malformed message, not a zero`);
  const n = Number(s);
  if (!Number.isFinite(n)) {
    throw new Error(
      `'${s}' is not a finite number — refusing to decode it as one. ` +
        `A ${what} field carries a number; NaN and Infinity have no wire form here because a NaN that decodes cleanly makes every later comparison silently false.`,
    );
  }
  return n;
}

export const num: FieldCodec<number> = {
  enc: (v) => {
    if (!Number.isFinite(v)) throw new Error(`cannot encode ${String(v)} as a number — it has no wire form that decodes back`);
    return String(v);
  },
  dec: (s) => finite(s, "num"),
};
/** Fixed-point quantization to two decimals — LOSSY by definition: 1.005 and 1.01
 *  share a wire form. Use it only where cents-precision is the domain's own unit. */
export const fixed2: FieldCodec<number> = {
  enc: (v) => {
    if (!Number.isFinite(+v)) throw new Error(`cannot encode ${String(v)} as a fixed2 number — it has no wire form that decodes back`);
    return (+v).toFixed(2);
  },
  dec: (s) => finite(s, "fixed2"),
};
export const bool: FieldCodec<boolean> = { enc: (v) => (v ? "1" : "0"), dec: (s) => s === "1" };
/** `\e` marks an empty element, because `[""].join(",")` and `[].join(",")` are the
 *  same wire otherwise. `esc` never produces `\e` (it only escapes delimiters), so
 *  the marker cannot collide with a real value. */
export const list: FieldCodec<string[]> = {
  enc: (v) => v.map((el) => (el === "" ? "\\e" : esc(el))).join(","),
  dec: (s) => (s === "" ? [] : splitUnescaped(s, ",").map((el) => (el === "\\e" ? "" : unesc(el)))),
};

export interface Dialect {
  version: string;
  encode(type: string, v: Record<string, unknown>): string;
  decode(line: string): { type: string; value: Record<string, unknown> };
  expand(type: string, v: Record<string, unknown>): Record<string, unknown>;
  roundTrip(type: string, v: Record<string, unknown>): Record<string, unknown>;
  savings(type: string, v: Record<string, unknown>): { condensed: number; expanded: number; ratio: number };
  types(): string[];
  isExpanded(msg: unknown): boolean;
}

/** The names the wire is built FROM must never contain what the wire is split BY. */
const DELIMITERS = /[\\|=,]/;

export function defineDialect(version: string, specs: Record<string, MessageSpec>): Dialect {
  if (DELIMITERS.test(version)) {
    throw new Error(`dialect version '${version}' contains a wire delimiter — it could never be decoded`);
  }
  for (const [type, spec] of Object.entries(specs)) {
    if (DELIMITERS.test(type)) {
      throw new Error(`message type '${type}' contains a wire delimiter — it could never be decoded`);
    }
    for (const f of spec.fields) {
      if (DELIMITERS.test(f.tag)) {
        throw new Error(`${type}: field tag '${f.tag}' contains a wire delimiter — it could never be decoded`);
      }
    }
  }

  const specOf = (type: string): MessageSpec => {
    const s = specs[type];
    if (!s) throw new Error(`unknown message type '${type}'`);
    return s;
  };

  const encode = (type: string, v: Record<string, unknown>): string => {
    const spec = specOf(type);
    const parts: string[] = [version, type];
    for (const f of spec.fields) {
      const val = v[f.key];
      if (val == null) {
        if (!f.opt) throw new Error(`${type}: missing required field '${f.key}'`);
        continue;
      }
      parts.push(`${f.tag}=${f.codec.enc(val)}`);
    }
    return parts.join("|");
  };

  const decode = (line: string): { type: string; value: Record<string, unknown> } => {
    const parts = splitUnescaped(String(line), "|");
    const ver = parts[0] ?? "";
    if (ver !== version) throw new Error(`dialect version mismatch: '${ver}' != '${version}' — refusing to mis-decode a drifted codebook`);
    const type = parts[1] ?? "";
    const spec = specOf(type);
    const byTag = new Map(spec.fields.map((f) => [f.tag, f]));
    const value: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const p of parts.slice(2)) {
      const i = p.indexOf("=");
      if (i < 0) throw new Error(`malformed field '${p}'`);
      const tag = p.slice(0, i);
      const f = byTag.get(tag);
      if (!f) throw new Error(`unknown field tag '${tag}' for ${type} — codebook drift, refusing`);
      // Last-wins on a duplicate would let a forged trailing field silently
      // shadow the real one; a duplicate is a malformed message, so refuse.
      if (seen.has(tag)) throw new Error(`duplicate field tag '${tag}' for ${type} — refusing an ambiguous message`);
      seen.add(tag);
      value[f.key] = f.codec.dec(p.slice(i + 1));
    }
    for (const f of spec.fields) if (!f.opt && value[f.key] == null) throw new Error(`${type}: missing required field '${f.key}' on decode`);
    return { type, value };
  };

  // The spec's own identity spreads LAST: a payload carrying `schema` or `type`
  // keys must never be able to override what the codebook says the message is.
  const expand = (type: string, v: Record<string, unknown>): Record<string, unknown> => ({ ...v, schema: specOf(type).schema, type });

  return {
    version,
    encode,
    decode,
    expand,
    roundTrip: (type, v) => decode(encode(type, v)).value,
    savings: (type, v) => {
      const condensed = encode(type, v).length;
      const expanded = JSON.stringify(expand(type, v)).length;
      return { condensed, expanded, ratio: +(expanded / condensed).toFixed(2) };
    },
    types: () => Object.keys(specs),
    isExpanded: (msg) => !!msg && typeof msg === "object" && typeof (msg as { schema?: unknown }).schema === "string",
  };
}
