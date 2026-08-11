/**
 * Dialect codec — the mechanism for a compressed-but-legible internal notation.
 *
 * praecise ships the ENGINE, not the vocabulary. An app defines its own message
 * types (its dialect) over `defineDialect`, because a dialect compresses against a
 * shared codebook and that codebook is the app's domain. Each message has a terse
 * condensed wire form and a lossless expansion to a self-describing, schema-tagged
 * object for any boundary a human must audit.
 *
 * The one safety property enforced here: decode REFUSES a version or unknown-tag
 * mismatch, so a drifted codebook is caught, never silently mis-decoded. The
 * lossless-round-trip property (decode(encode(x)) === x) is the app's to assert over
 * its own specs.
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

export const str: FieldCodec<string> = { enc: (v) => String(v), dec: (s) => s };
export const num: FieldCodec<number> = { enc: (v) => String(v), dec: (s) => Number(s) };
export const fixed2: FieldCodec<number> = { enc: (v) => (+v).toFixed(2), dec: (s) => parseFloat(s) };
export const bool: FieldCodec<boolean> = { enc: (v) => (v ? "1" : "0"), dec: (s) => s === "1" };
export const list: FieldCodec<string[]> = { enc: (v) => v.join(","), dec: (s) => (s ? s.split(",") : []) };

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

export function defineDialect(version: string, specs: Record<string, MessageSpec>): Dialect {
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
    const parts = String(line).split("|");
    const ver = parts[0] ?? "";
    if (ver !== version) throw new Error(`dialect version mismatch: '${ver}' != '${version}' — refusing to mis-decode a drifted codebook`);
    const type = parts[1] ?? "";
    const spec = specOf(type);
    const byTag = new Map(spec.fields.map((f) => [f.tag, f]));
    const value: Record<string, unknown> = {};
    for (const p of parts.slice(2)) {
      const i = p.indexOf("=");
      if (i < 0) throw new Error(`malformed field '${p}'`);
      const f = byTag.get(p.slice(0, i));
      if (!f) throw new Error(`unknown field tag '${p.slice(0, i)}' for ${type} — codebook drift, refusing`);
      value[f.key] = f.codec.dec(p.slice(i + 1));
    }
    for (const f of spec.fields) if (!f.opt && value[f.key] == null) throw new Error(`${type}: missing required field '${f.key}' on decode`);
    return { type, value };
  };

  const expand = (type: string, v: Record<string, unknown>): Record<string, unknown> => ({ schema: specOf(type).schema, type, ...v });

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
