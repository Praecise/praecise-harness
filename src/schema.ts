/**
 * What an agent's `returns` may be, and how an answer is held to it.
 *
 * Three forms, told apart by what they are:
 *
 *   fields    `{ label: "one of: refund, shipping" }` — names and plain-English hints.
 *             Every value is typed as text; the structure is constrained, the values are not.
 *   schema    a JSON Schema object — sent to the endpoint for constrained decoding as it
 *             is, and the answer is checked against it here.
 *   standard  a Standard Schema v1 validator (anything with `~standard`): a library's
 *             schema, which checks the answer itself and types `answer.data`.
 *
 * The check made here on a JSON Schema is deliberately a subset, and says so. It covers
 * what an answer is most often wrong about — a field missing, a field of the wrong type,
 * a value outside a list — and the keywords it does not check are named in
 * `UNCHECKED_KEYWORDS` and reported on the agent, not skipped in silence. An endpoint
 * that constrains decoding enforces the whole schema itself; this is the check that
 * holds on the endpoints that do not.
 */

// ── Standard Schema ─────────────────────────────────────────────────────────

/** One thing wrong with a value, as a Standard Schema validator reports it. */
export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

/** What validating returns: the value, as the schema produces it, or what was wrong. */
export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

/**
 * The Standard Schema v1 interface, as much of it as is used: the part every validator
 * library that implements the specification exposes under `~standard`. Declared here so
 * that accepting one needs no dependency on any of them.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    /** Carries the types; never read. */
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

/** What a Standard Schema produces when a value passes. */
export type StandardOutput<Schema> = Schema extends StandardSchemaV1<unknown, infer Output> ? Output : unknown;

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  const standard = (value as { "~standard"?: { validate?: unknown } })["~standard"];
  return typeof standard === "object" && standard !== null && typeof standard.validate === "function";
}

/**
 * The JSON Schema a Standard Schema describes itself with, where it can.
 *
 * The specification's JSON Schema companion puts a converter under
 * `~standard.jsonSchema`. A validator that has one can be sent for constrained decoding;
 * one that does not is still checked afterwards, and the model is asked for JSON without
 * being told a shape.
 */
function jsonSchemaOf(schema: StandardSchemaV1): Record<string, unknown> | undefined {
  const converter = (schema["~standard"] as { jsonSchema?: { output?: (options: { target: string }) => unknown } }).jsonSchema;
  if (typeof converter?.output !== "function") return undefined;
  try {
    const made = converter.output({ target: "draft-2020-12" });
    return typeof made === "object" && made !== null ? (made as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// ── Telling the forms apart ─────────────────────────────────────────────────

const JSON_TYPES: ReadonlySet<string> = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/**
 * Whether a plain object is a JSON Schema, as opposed to fields and hints.
 *
 * It is one when it says so (`$schema`), when its `type` is a JSON Schema type, or when
 * any of its values is not text — fields and hints are text all the way through. The
 * one shape this reads the other way is a hint record with a field called `type` whose
 * hint is exactly a type name; call that field something else.
 */
export function isJsonSchema(value: Record<string, unknown>): boolean {
  if (typeof value.$schema === "string") return true;
  if (typeof value.type === "string" && JSON_TYPES.has(value.type)) return true;
  return Object.values(value).some((entry) => typeof entry !== "string");
}

export type ReturnsKind = "fields" | "schema" | "standard";

export function returnsKind(returns: unknown): ReturnsKind {
  if (isStandardSchema(returns)) return "standard";
  return isJsonSchema(returns as Record<string, unknown>) ? "schema" : "fields";
}

// ── Checking a value against a JSON Schema ──────────────────────────────────

/** The keywords `validateJson` checks. */
export const CHECKED_KEYWORDS: readonly string[] = Object.freeze([
  "type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "oneOf", "nullable",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems",
]);

/** Keywords that say something about a value and are NOT checked here. An endpoint that constrains decoding may still enforce them. */
export const UNCHECKED_KEYWORDS: readonly string[] = Object.freeze([
  "$ref", "$defs", "definitions", "allOf", "not", "if", "then", "else", "pattern", "format", "multipleOf",
  "patternProperties", "propertyNames", "prefixItems", "contains", "uniqueItems", "minProperties", "maxProperties",
  "dependentRequired", "dependentSchemas", "unevaluatedProperties", "unevaluatedItems",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The keywords in a schema, at any depth, that `validateJson` does not check. */
export function uncheckedIn(schema: unknown, found: Set<string> = new Set()): string[] {
  if (Array.isArray(schema)) for (const entry of schema) uncheckedIn(entry, found);
  else if (isObject(schema)) {
    for (const [key, value] of Object.entries(schema)) {
      if (UNCHECKED_KEYWORDS.includes(key)) found.add(key);
      // A property may be called anything, `format` included: look inside it, not at its name.
      if (key === "properties" && isObject(value)) for (const inner of Object.values(value)) uncheckedIn(inner, found);
      else if (key !== "enum" && key !== "const" && key !== "default" && key !== "examples") uncheckedIn(value, found);
    }
  }
  return [...found];
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

const isType = (value: unknown, type: string): boolean => {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
};

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

const shown = (value: unknown): string => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

/** The most that is said about one answer. Past this, the rest is more of the same. */
const MOST_ISSUES = 12;

/**
 * What is wrong with a value, against a JSON Schema. An empty list means nothing was
 * found by the keywords in `CHECKED_KEYWORDS`. `path` names where, from `$`.
 */
export function validateJson(schema: unknown, value: unknown, path = "$", issues: string[] = []): string[] {
  if (issues.length >= MOST_ISSUES) return issues;
  // `true` and `{}` accept anything; `false` accepts nothing.
  if (schema === false) return (issues.push(`${path}: nothing is allowed here`), issues);
  if (!isObject(schema)) return issues;

  if (value === null && schema.nullable === true) return issues;

  if ("const" in schema && !same(schema.const, value)) issues.push(`${path}: expected ${shown(schema.const)}, got ${shown(value)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => same(allowed, value))) {
    issues.push(`${path}: expected one of ${shown(schema.enum)}, got ${shown(value)}`);
  }

  const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type.filter((t): t is string => typeof t === "string") : [];
  if (types.length && !types.some((type) => isType(value, type))) {
    issues.push(`${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`);
    // What follows describes a value of the right type; there is nothing more to say about this one.
    return issues;
  }

  for (const keyword of ["anyOf", "oneOf"] as const) {
    const options = schema[keyword];
    if (!Array.isArray(options) || !options.length) continue;
    const passing = options.filter((option) => validateJson(option, value, path, []).length === 0).length;
    if (passing === 0) issues.push(`${path}: matched none of the ${options.length} shapes under ${keyword}`);
    else if (keyword === "oneOf" && passing > 1) issues.push(`${path}: matched ${passing} shapes under oneOf, and exactly one is allowed`);
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) issues.push(`${path}: ${value} is less than ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) issues.push(`${path}: ${value} is more than ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) issues.push(`${path}: ${value} is not more than ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) issues.push(`${path}: ${value} is not less than ${schema.exclusiveMaximum}`);
  }

  if (typeof value === "string") {
    // Counted in characters, as the specification counts them, not in UTF-16 units.
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) issues.push(`${path}: shorter than ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && length > schema.maxLength) issues.push(`${path}: longer than ${schema.maxLength} characters`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) issues.push(`${path}: fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) issues.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items !== undefined && !Array.isArray(schema.items)) {
      value.forEach((item, at) => validateJson(schema.items, item, `${path}[${at}]`, issues));
    }
  }

  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) issues.push(`${path}.${key}: missing`);
      }
    }
    for (const [key, inner] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validateJson(properties[key], inner, `${path}.${key}`, issues);
      else if (schema.additionalProperties === false) issues.push(`${path}.${key}: not a field of the declared shape`);
      else if (isObject(schema.additionalProperties)) validateJson(schema.additionalProperties, inner, `${path}.${key}`, issues);
    }
  }

  return issues.slice(0, MOST_ISSUES);
}

// ── A declared shape, ready to use ──────────────────────────────────────────

/** What checking an answer comes to: the data, as the shape produces it, or what was wrong. */
export type Checked = { value: unknown; issues?: undefined } | { issues: string[] };

/** A `returns`, worked out once: what to send an endpoint, and how to check what comes back. */
export interface Shape {
  kind: ReturnsKind;
  /** JSON Schema for constrained decoding. Absent for a Standard Schema that cannot describe itself as one. */
  schema?: Record<string, unknown>;
  /**
   * Whether an answer is held to the shape: checked, and an answer that fails counted
   * as a failed answer. True for a JSON Schema and a Standard Schema. Fields and hints
   * are advice about values, so there is nothing to hold an answer to beyond its being JSON.
   */
  checked: boolean;
  check(data: unknown): Promise<Checked>;
}

function pathOf(issue: StandardIssue): string {
  const steps = (issue.path ?? []).map((step) => (typeof step === "object" && step !== null ? step.key : step));
  return steps.reduce<string>((path, step) => (typeof step === "number" ? `${path}[${step}]` : `${path}.${String(step)}`), "$");
}

const shapes = new WeakMap<object, Shape>();

/** The shape a `returns` declares. Worked out once per declaration and kept. */
export function shapeOf(returns: Record<string, unknown> | StandardSchemaV1): Shape {
  const kept = shapes.get(returns);
  if (kept) return kept;
  const kind = returnsKind(returns);
  let shape: Shape;
  if (kind === "standard") {
    const standard = returns as StandardSchemaV1;
    const schema = jsonSchemaOf(standard);
    shape = {
      kind,
      ...(schema ? { schema } : {}),
      checked: true,
      async check(data) {
        let result: StandardResult<unknown>;
        try {
          result = await standard["~standard"].validate(data);
        } catch (err) {
          return { issues: [`$: the schema could not check this (${(err as Error)?.message ?? String(err)})`] };
        }
        if (result.issues) {
          return { issues: result.issues.slice(0, MOST_ISSUES).map((issue) => `${pathOf(issue)}: ${issue.message}`) };
        }
        return { value: result.value };
      },
    };
  } else if (kind === "schema") {
    const schema = returns as Record<string, unknown>;
    shape = {
      kind,
      schema,
      checked: true,
      async check(data) {
        const issues = validateJson(schema, data);
        return issues.length ? { issues } : { value: data };
      },
    };
  } else {
    const fields = returns as Record<string, string>;
    const properties: Record<string, unknown> = {};
    for (const [field, hint] of Object.entries(fields)) properties[field] = { type: "string", description: hint };
    shape = {
      kind,
      schema: { type: "object", additionalProperties: false, required: Object.keys(fields), properties },
      checked: false,
      check: async (data) => ({ value: data }),
    };
  }
  shapes.set(returns, shape);
  return shape;
}

/**
 * An agent's answer was not in the shape it declared, on every rung that was asked.
 *
 * Thrown only after the ladder has been climbed: each rung that got it wrong was
 * followed by a deeper pass or a stronger model, and this is what is left when the
 * strongest got it wrong too. `issues` is what was wrong with the last answer, and
 * `text` is that answer as it was written.
 */
export class ShapeError extends Error {
  readonly agent: string;
  readonly issues: string[];
  readonly text: string;
  constructor(agent: string, issues: string[], text: string) {
    super(
      `agent "${agent}" did not answer in the shape it declares under \`returns\`, on any model it could be asked on: ` +
        issues.join("; "),
    );
    this.name = "ShapeError";
    this.agent = agent;
    this.issues = issues;
    this.text = text;
  }
}
