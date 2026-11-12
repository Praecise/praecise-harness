/**
 * A schema, as any validation library hands one over.
 *
 * Standard Schema is an interface, not a library: a validator exposes one property,
 * `~standard`, holding a `validate` function and the types it goes between. Every
 * library that implements it is accepted here by that property alone, which is how a
 * store can check what it is given without this package depending on, or choosing,
 * whatever does the checking.
 *
 * The types below are the specification's own, written out rather than imported: it
 * is published to be copied, and a types-only dependency is still a dependency.
 *
 * This is a check on the way in and nothing more. There is no mapping of rows to
 * classes, no migration, no query builder — a record that passes is kept as the
 * validator returned it, and one that does not is refused with what was wrong.
 */

/** A validator that implements Standard Schema, version 1. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

// The specification declares these as a namespace beside the interface, so that
// `StandardSchemaV1.Issue` is the name a reader of any library's docs already knows.
// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown, options?: Options | undefined) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult;
  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  export interface Options {
    readonly libraryOptions?: Record<string, unknown> | undefined;
  }
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  export interface PathSegment {
    readonly key: PropertyKey;
  }
  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["input"];
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["output"];
}

/** Whether something is a Standard Schema validator, by the one property that says so. */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  const props = (value as { "~standard"?: { version?: unknown; validate?: unknown } })["~standard"];
  return typeof props === "object" && props !== null && props.version === 1 && typeof props.validate === "function";
}

/** One thing wrong with one record, and where in it. */
export interface SchemaIssue {
  /** Which record of the batch, counting from zero. */
  index: number;
  /** Where in the record, as a dotted path. Empty for the record as a whole. */
  path: string;
  message: string;
}

/** A write that was refused because what it carried did not match the schema. */
export class SchemaError extends Error {
  readonly issues: SchemaIssue[];
  constructor(what: string, issues: SchemaIssue[]) {
    const shown = issues
      .slice(0, 5)
      .map((issue) => `#${issue.index}${issue.path ? ` ${issue.path}` : ""}: ${issue.message}`)
      .join("; ");
    const more = issues.length > 5 ? `; and ${issues.length - 5} more` : "";
    super(`${what} refused what it was given, and nothing was kept — ${shown}${more}`);
    this.name = "SchemaError";
    this.issues = issues;
  }
}

const pathOf = (path: StandardSchemaV1.Issue["path"]): string =>
  (path ?? [])
    .map((segment) => String(typeof segment === "object" && segment !== null ? segment.key : segment))
    .join(".");

/**
 * Check a batch against a schema: every record, or none of them.
 *
 * Answers with what the validator made of each record — a default filled in, a string
 * trimmed — because that is what a library's own `parse` hands back and what should be
 * kept. Anything wrong anywhere in the batch refuses all of it: half a batch written is
 * a state nobody asked for.
 */
export async function checked<Output>(
  schema: StandardSchemaV1<unknown, Output>,
  values: readonly unknown[],
  what: string,
): Promise<Output[]> {
  const issues: SchemaIssue[] = [];
  const out: Output[] = [];
  for (const [index, value] of values.entries()) {
    const result = await schema["~standard"].validate(value);
    if (result.issues) {
      for (const issue of result.issues) issues.push({ index, path: pathOf(issue.path), message: issue.message });
    } else {
      out.push(result.value);
    }
  }
  if (issues.length) throw new SchemaError(what, issues);
  return out;
}
