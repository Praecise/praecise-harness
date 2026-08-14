/**
 * An OpenAPI description, turned into tools an agent can call.
 *
 * The gap this closes: almost every API worth reaching already has an OpenAPI document
 * and does not have an MCP server. Without this, using one means either finding a
 * community MCP wrapper, writing one, or hand-writing a tool per endpoint — three
 * different ways of restating a description that already exists and is already accurate.
 *
 * ── The two decisions that shape everything here ──────────────────────────────
 *
 * **Parameters are flattened into one object, and the location is remembered.** A model
 * produces a single JSON object; HTTP wants some of those values in the path, some in the
 * query, some in headers, and the rest in a body. Rather than making the model understand
 * that split, the schema it sees is flat and the mapping is kept beside it. What comes
 * back from the model is then dispatched by a table, not by guessing from the name.
 *
 * **A name collision is resolved, never allowed.** `operationId` is optional in OpenAPI
 * and duplicated in practice, and two tools with one name is not a cosmetic problem — the
 * model picks one and the other becomes unreachable with no error anywhere. So names are
 * derived deterministically, deduplicated, and the collision is reported.
 *
 * Nothing here reaches the network on its own; `callOperation` takes an injected `fetch`,
 * the same discipline every other outbound path in this framework follows.
 */

import type { ToolSchema } from "./types.js";

/** Where a value goes once the model has produced it. */
export type Where = "path" | "query" | "header" | "cookie" | "body";

/** One callable endpoint, with everything needed to actually make the request. */
export interface Operation {
  /** The tool name a model sees. Unique within one document, by construction. */
  name: string;
  method: string;
  /** The template, still holding its `{placeholders}`. */
  path: string;
  description: string;
  /** The flat schema the model fills in. */
  parameters: Record<string, unknown>;
  /** Where each named parameter belongs. Anything absent here is part of the body. */
  places: Record<string, Where>;
  /** The server URL this operation is relative to. */
  baseUrl: string;
  /** Media type for a request body, when the operation takes one. */
  bodyType?: string;
}

/** Bits of an OpenAPI document this reads. Everything else is ignored on purpose. */
interface Document {
  openapi?: string;
  swagger?: string;
  servers?: { url?: string }[];
  host?: string;
  basePath?: string;
  schemes?: string[];
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
  definitions?: Record<string, unknown>;
}

interface Parameter {
  name?: string;
  in?: string;
  description?: string;
  required?: boolean;
  schema?: Record<string, unknown>;
  type?: string;
}

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

/**
 * A tool name derived from an operation.
 *
 * `operationId` when there is one, because it is what the API's own authors called it and
 * will match their documentation. Otherwise method-and-path, which is ugly and stable —
 * and stability is what matters, since a name that shifts between runs invalidates every
 * prompt cache and every logged trace that mentioned it.
 */
export function operationName(method: string, path: string, operationId?: unknown): string {
  const raw =
    typeof operationId === "string" && operationId.trim()
      ? operationId
      : `${method}_${path.replace(/[{}]/g, "").replace(/[^A-Za-z0-9]+/g, "_")}`;
  return raw
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/**
 * Resolve a local `$ref`.
 *
 * Local only, and deliberately: a `$ref` to a network URI is a request this makes on
 * someone else's behalf to a host chosen by the document, which is the same class of
 * problem MCP's own schema rules forbid by default. A remote ref is left as it is rather
 * than fetched, so the model sees an opaque object instead of the framework becoming a
 * fetch primitive for whoever wrote the document.
 */
export function resolveRefs(node: unknown, doc: Document, depth = 0): unknown {
  // A bounded walk: `$ref` cycles are ordinary in real documents (a Node with children
  // of Nodes), and an unbounded resolver turns one into a hang at load time.
  if (depth > 12 || !node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((item) => resolveRefs(item, doc, depth + 1));

  const record = node as Record<string, unknown>;
  const ref = record.$ref;
  if (typeof ref === "string") {
    if (!ref.startsWith("#/")) return { type: "object", description: `unresolved external reference ${ref}` };
    const target = ref
      .slice(2)
      .split("/")
      .reduce<unknown>((here, step) => {
        if (!here || typeof here !== "object") return undefined;
        return (here as Record<string, unknown>)[step.replace(/~1/g, "/").replace(/~0/g, "~")];
      }, doc);
    if (target === undefined) return { type: "object", description: `unresolved reference ${ref}` };
    return resolveRefs(target, doc, depth + 1);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) out[key] = resolveRefs(value, doc, depth + 1);
  return out;
}

/** The base URL for a document, across OpenAPI 3 and the Swagger 2 spelling. */
export function baseUrlOf(doc: Document, fallback = ""): string {
  const declared = doc.servers?.[0]?.url;
  if (declared) return declared.replace(/\/$/, "");
  if (doc.host) {
    const scheme = doc.schemes?.[0] ?? "https";
    return `${scheme}://${doc.host}${doc.basePath ?? ""}`.replace(/\/$/, "");
  }
  return fallback.replace(/\/$/, "");
}

/**
 * Read a document into operations.
 *
 * `notes` carries what was skipped and why. A description that silently yields fewer
 * tools than it describes is the failure mode worth avoiding here — the agent simply
 * never learns the endpoint exists, and nothing anywhere says so.
 */
export function operationsFrom(
  document: unknown,
  options: { baseUrl?: string } = {},
): { operations: Operation[]; notes: string[] } {
  const doc = document as Document;
  const notes: string[] = [];
  const operations: Operation[] = [];
  const taken = new Map<string, number>();

  if (!doc?.paths || typeof doc.paths !== "object") {
    return { operations: [], notes: ["the document has no `paths`, so it describes no operations"] };
  }
  const baseUrl = baseUrlOf(doc, options.baseUrl ?? "");
  if (!baseUrl) {
    notes.push("the document names no server; pass `baseUrl` or these operations have nowhere to go");
  }

  for (const [path, item] of Object.entries(doc.paths)) {
    if (!item || typeof item !== "object") continue;
    // Parameters declared once for the whole path apply to every operation under it.
    const shared = (resolveRefs((item as { parameters?: unknown }).parameters ?? [], doc) as Parameter[]) ?? [];

    for (const method of METHODS) {
      const raw = (item as Record<string, unknown>)[method];
      if (!raw || typeof raw !== "object") continue;
      const operation = resolveRefs(raw, doc) as {
        operationId?: unknown;
        summary?: unknown;
        description?: unknown;
        parameters?: Parameter[];
        requestBody?: { content?: Record<string, { schema?: Record<string, unknown> }>; required?: boolean };
        deprecated?: boolean;
      };

      if (operation.deprecated) {
        notes.push(`${method.toUpperCase()} ${path} is deprecated and was not offered`);
        continue;
      }

      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const places: Record<string, Where> = {};

      for (const parameter of [...shared, ...(operation.parameters ?? [])]) {
        const name = parameter?.name;
        if (typeof name !== "string" || !name) continue;
        const where = (parameter.in ?? "query") as Where;
        if (!["path", "query", "header", "cookie"].includes(where)) continue;
        // Swagger 2 puts the type beside the parameter; OpenAPI 3 puts it in `schema`.
        const schema = parameter.schema ?? (parameter.type ? { type: parameter.type } : { type: "string" });
        properties[name] = { ...schema, ...(parameter.description ? { description: parameter.description } : {}) };
        places[name] = where;
        // A path parameter is required whether or not the document says so: the URL
        // cannot be built without it, and a template left holding `{id}` is a request to
        // a path that does not exist.
        if (parameter.required || where === "path") required.push(name);
      }

      let bodyType: string | undefined;
      const content = operation.requestBody?.content ?? {};
      const [type, media] =
        Object.entries(content).find(([key]) => key.includes("json")) ?? Object.entries(content)[0] ?? [];
      if (type && media?.schema) {
        bodyType = type;
        const body = media.schema as { properties?: Record<string, unknown>; required?: string[]; type?: string };
        if (body.type === "object" && body.properties) {
          // Flattened into the same object the model fills in. A nested `body` field
          // would ask the model to know which of its own arguments are transport and
          // which are content, which is exactly what it should not have to think about.
          for (const [key, value] of Object.entries(body.properties)) {
            if (properties[key] === undefined) properties[key] = value;
            else notes.push(`${method.toUpperCase()} ${path}: body field "${key}" collides with a parameter of the same name`);
          }
          for (const key of body.required ?? []) if (!required.includes(key)) required.push(key);
        } else {
          // A non-object body — an array, a string — cannot be flattened, so it keeps a
          // name of its own.
          properties.body = media.schema;
          places.body = "body";
          if (operation.requestBody?.required) required.push("body");
        }
      }

      const name = unique(operationName(method, path, operation.operationId), taken, notes);
      operations.push({
        name,
        method: method.toUpperCase(),
        path,
        description:
          [operation.summary, operation.description].filter((text) => typeof text === "string" && text).join(" — ") ||
          `${method.toUpperCase()} ${path}`,
        parameters: {
          type: "object",
          properties,
          required,
          // The model is told exactly what this takes. Without it, a model that invents a
          // plausible extra field gets a 400 from the API rather than a correction here.
          additionalProperties: false,
        },
        places,
        baseUrl,
        bodyType,
      });
    }
  }

  return { operations, notes };
}

/**
 * A name nobody else has taken.
 *
 * Two tools with one name is not cosmetic: the model picks one, the other is unreachable,
 * and nothing reports it. `operationId` is optional in OpenAPI and duplicated in practice,
 * so this is a case that happens rather than one being guarded against in principle.
 */
function unique(name: string, taken: Map<string, number>, notes: string[]): string {
  const seen = taken.get(name);
  if (seen === undefined) {
    taken.set(name, 1);
    return name;
  }
  taken.set(name, seen + 1);
  const renamed = `${name}_${seen + 1}`;
  notes.push(`two operations are both named "${name}"; the second is offered as "${renamed}"`);
  return renamed;
}

/** The operations as tool schemas, ready to hand to a model. */
export function toolsFrom(operations: Operation[]): ToolSchema[] {
  return operations.map((operation) => ({
    name: operation.name,
    description: operation.description,
    parameters: operation.parameters,
  }));
}

/**
 * Build the request for one operation from what the model produced.
 *
 * Split out from calling it so it can be inspected, logged, or approved before anything
 * leaves the process — which matters for an operation that is a DELETE against somebody's
 * production API.
 */
export function requestFor(
  operation: Operation,
  args: Record<string, unknown>,
): { url: string; init: RequestInit } {
  let path = operation.path;
  const query = new URLSearchParams();
  const headers: Record<string, string> = { accept: "application/json" };
  const cookies: string[] = [];
  const body: Record<string, unknown> = {};
  let rawBody: unknown;

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const where = operation.places[key];
    if (where === "path") {
      // Encoded, because a path parameter is caller-supplied and a `/` inside one would
      // otherwise silently address a different resource.
      path = path.replace(`{${key}}`, encodeURIComponent(String(value)));
    } else if (where === "query") {
      if (Array.isArray(value)) for (const item of value) query.append(key, String(item));
      else query.set(key, String(value));
    } else if (where === "header") {
      headers[key.toLowerCase()] = String(value);
    } else if (where === "cookie") {
      cookies.push(`${key}=${encodeURIComponent(String(value))}`);
    } else if (where === "body") {
      rawBody = value;
    } else {
      body[key] = value;
    }
  }

  // A placeholder the model did not fill would produce a request to a literal `{id}`.
  const unfilled = path.match(/\{([^}]+)\}/g);
  if (unfilled) {
    throw new Error(
      `${operation.name} needs ${unfilled.join(", ")} to build its URL, and the call did not supply ${unfilled.length > 1 ? "them" : "it"}`,
    );
  }

  const url = `${operation.baseUrl}${path}${query.toString() ? `?${query}` : ""}`;
  const init: RequestInit = { method: operation.method, headers };
  if (cookies.length) headers.cookie = cookies.join("; ");

  const payload = rawBody !== undefined ? rawBody : Object.keys(body).length ? body : undefined;
  if (payload !== undefined && operation.method !== "GET" && operation.method !== "HEAD") {
    headers["content-type"] = operation.bodyType ?? "application/json";
    init.body = headers["content-type"].includes("json") ? JSON.stringify(payload) : String(payload);
  }
  return { url, init };
}

/**
 * Call one operation and return what came back, as text a model can read.
 *
 * An error status comes back as text rather than as a thrown exception, because an API
 * saying "that id does not exist" is information the model can act on — it is the same
 * distinction MCP draws between a protocol error and a tool execution error, and throwing
 * would end the turn on something the model could have corrected.
 */
export async function callOperation(
  operation: Operation,
  args: Record<string, unknown>,
  options: { fetch?: typeof fetch; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<{ text: string; isError: boolean }> {
  const { url, init } = requestFor(operation, args);
  const send = options.fetch ?? fetch;

  const response = await send(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...(options.headers ?? {}) },
    signal: options.signal,
  });

  const text = await response.text();
  if (!response.ok) {
    return {
      text: `${operation.method} ${url} failed (${response.status}): ${text.slice(0, 2_000)}`,
      isError: true,
    };
  }
  return { text, isError: false };
}
