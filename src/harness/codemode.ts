/**
 * Code mode: an agent's services as one typed API, and one tool that runs code against it.
 *
 * A model handed fifty tools reads fifty schemas on every turn and passes every
 * intermediate result back through its context. Handed one `code` tool instead, it
 * reads the services as TypeScript declarations, writes a short program that calls
 * them, filters and combines what comes back, and returns only the answer. Models have
 * read far more real TypeScript than tool-call transcripts, and a chain of calls costs
 * one turn instead of one per call.
 *
 * The program runs in a Praecise Silo: a microVM with no network, whose only way out
 * is the services bound to it. Each HTTP service becomes a binding; the silo's host
 * makes the call with the credential, so the key never enters the code's world. A
 * service launched as a local program cannot be bound and stays an ordinary tool.
 */
import { request as httpRequest } from "node:http";
import type { ResolvedService } from "../compile/services.js";
import type { McpTool, ToolSource } from "./mcp.js";
import { serviceSegment, splitToolName } from "./mcp.js";
import type { ToolSchema } from "./types.js";

/** How an agent runs in code mode. `code: true` takes every default. */
export interface CodeModeSpec {
  /**
   * Where the silo service answers: `unix:/run/furcate-silo/api.sock` on the same
   * machine, or an `https://` address reached with the token in `PRAECISE_SILO_TOKEN`.
   * Default: the `PRAECISE_SILO` environment variable, then the local socket.
   */
  silo?: string;
  /** What the model writes. Default `typescript`. */
  language?: "typescript" | "javascript" | "python";
  /** How long the silo lives, in seconds. Default 1800. */
  ttl?: number;
}

/** The single tool a code-mode agent sees. */
export const CODE_TOOL = "code";

/** What goes back to the model from one program, at most: about six thousand tokens. */
const MAX_OUTPUT = 24_000;

export interface Binding {
  name: string;
  url: string;
  headers?: Record<string, string>;
  kind?: "mcp" | "http";
  spec?: string;
}

const ident = (s: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
const key = (s: string): string => (ident(s) ? s : JSON.stringify(s));
/** A binding name the silo accepts: lower case, digits and underscores, from a letter. */
export const bindingName = (service: string): string => {
  const n = serviceSegment(service).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "");
  return (n || "service").slice(0, 40);
};

/** A TypeScript type for a JSON Schema: the shapes tools use, and `unknown` for the rest. */
export function tsType(schema: unknown, depth = 0): string {
  if (depth > 6 || typeof schema !== "object" || schema === null) return "unknown";
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  for (const k of ["anyOf", "oneOf"]) {
    if (Array.isArray(s[k])) return (s[k] as unknown[]).map((x) => tsType(x, depth + 1)).join(" | ");
  }
  const type = Array.isArray(s.type) ? undefined : (s.type as string | undefined) ?? (s.properties ? "object" : undefined);
  if (Array.isArray(s.type)) return (s.type as string[]).map((t) => tsType({ ...s, type: t }, depth + 1)).join(" | ");
  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const item = tsType(s.items, depth + 1);
      return item.includes(" ") ? `Array<${item}>` : `${item}[]`;
    }
    case "object": {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
      const fields = Object.entries(props).map(([k, v]) => {
        const d = (v as Record<string, unknown>)?.description;
        const doc = typeof d === "string" ? `/** ${d.replace(/\*\//g, "* /").replace(/\n/g, " ")} */ ` : "";
        return `${doc}${key(k)}${required.has(k) ? "" : "?"}: ${tsType(v, depth + 1)}`;
      });
      return fields.length ? `{ ${fields.join("; ")} }` : "Record<string, unknown>";
    }
    default:
      return "unknown";
  }
}

function doc(text: string | undefined, pad: string): string {
  if (!text?.trim()) return "";
  const body = text.replace(/\*\//g, "* /").split("\n").map((l) => `${pad} * ${l.trimEnd()}`);
  return `${pad}/**\n${body.join("\n")}\n${pad} */\n`;
}

/**
 * The declarations the model reads, one namespace per bound service.
 *
 * Built from the schemas the harness already discovered, so the model sees exactly the
 * tools and arguments the services declared, under the binding names the silo uses.
 */
export function typesFor(schemas: ToolSchema[], bound: Map<string, string>, http: Set<string> = new Set()): string {
  const byService = new Map<string, ToolSchema[]>();
  for (const binding of http) byService.set(binding, []);
  for (const s of schemas) {
    const split = splitToolName(s.name);
    if (!split) continue;
    const binding = bound.get(split.service);
    if (!binding || http.has(binding)) continue;
    byService.set(binding, [...(byService.get(binding) ?? []), { ...s, name: split.tool }]);
  }
  const lines = ["declare const tools: {"];
  for (const [binding, tools] of byService) {
    lines.push(`  ${key(binding)}: {`);
    if (http.has(binding)) {
      lines.push(
        `    /** Call the ${binding} API under its base address; search spec.${binding} for paths. */`,
        `    request(args: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; query?: Record<string, string>; body?: unknown }): Promise<{ status: number; body: any }>;`,
      );
    }
    for (const t of tools) {
      lines.push(`${doc(t.description, "    ")}    ${key(t.name)}(args: ${tsType(t.parameters)}): Promise<any>;`);
    }
    lines.push("  };");
  }
  lines.push("};");
  if (http.size) {
    lines.push("/** The OpenAPI documents of the HTTP APIs, references resolved. Search them in code. */");
    lines.push(`declare const spec: { ${[...http].map((b) => `${key(b)}: any`).join("; ")} };`);
  }
  return lines.join("\n");
}

/**
 * Which services can be bound into a silo, and how.
 *
 * An MCP server over HTTP binds as itself. An OpenAPI service binds as an HTTP API: one
 * `request()` function under its base address, and its document in the silo for the
 * program to search, which keeps a large API out of the prompt entirely. A launched
 * program, an inline document or a service with no base address cannot be bound and is
 * returned as `direct`.
 */
export function bindingsFor(services: ResolvedService[]): {
  bindings: Binding[];
  bound: Map<string, string>;
  http: Set<string>;
  direct: ResolvedService[];
} {
  const bindings: Binding[] = [];
  const bound = new Map<string, string>();
  const http = new Set<string>();
  const direct: ResolvedService[] = [];
  const taken = new Set<string>();
  for (const service of services) {
    const headers: Record<string, string> = {};
    if (service.apiKey) {
      if (service.auth === "header" && service.header) headers[service.header] = service.apiKey;
      else headers.Authorization = `Bearer ${service.apiKey}`;
    }
    let name = bindingName(service.name);
    for (let i = 2; taken.has(name); i++) name = `${bindingName(service.name).slice(0, 36)}_${i}`;
    if (service.openapi !== undefined) {
      if (typeof service.openapi !== "string" || !service.baseUrl) {
        direct.push(service);
        continue;
      }
      bindings.push({ name, kind: "http", url: service.baseUrl, spec: service.openapi, headers });
      http.add(name);
    } else if (service.url) {
      bindings.push({ name, kind: "mcp", url: service.url, headers });
    } else {
      direct.push(service);
      continue;
    }
    taken.add(name);
    bound.set(serviceSegment(service.name), name);
  }
  return { bindings, bound, http, direct };
}

/** The `code` tool's schema, with the declarations in its description. */
export function codeTool(types: string, language: CodeModeSpec["language"] = "typescript"): ToolSchema {
  return {
    name: CODE_TOOL,
    description: [
      `Run a ${language} program in an isolated sandbox. It is the body of an async function: call services through \`tools\`, chain and filter their results in the program, and \`return\` only what you need; the return value is the result.`,
      "HTTP APIs are reached as tools.<name>.request({ method, path, query, body }); their OpenAPI documents are in `spec.<name>` — search them in code rather than reading them whole.",
      "The sandbox has no network apart from these services. Available:",
      "",
      types,
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["code"],
      properties: { code: { type: "string", description: `The ${language} program` } },
    },
    effect: "write",
  };
}

type Call = (path: string, body: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;

function transport(silo: string, token?: string): Call {
  if (silo.startsWith("unix:")) {
    const socketPath = silo.slice(5);
    return (path, body) =>
      new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = httpRequest(
          { socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
          (res) => {
            let raw = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (raw += c));
            res.on("end", () => {
              try {
                resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw || "{}") });
              } catch {
                reject(new Error(`the silo answered ${res.statusCode} with something that is not JSON`));
              }
            });
          },
        );
        req.on("error", reject);
        req.end(data);
      });
  }
  return async (path, body) => {
    const res = await fetch(new URL(path, silo), {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
}

/**
 * The `code` tool's runner: one silo per agent, created on first use with the agent's
 * bindings, kept for its term, and created again if it has expired.
 */
export class SiloExecutor implements ToolSource {
  readonly name = CODE_TOOL;
  readonly warnings: string[] = [];
  private id?: string;
  private readonly post: Call;
  private readonly language: NonNullable<CodeModeSpec["language"]>;
  private readonly ttl: number;

  private readonly bindings: Binding[];

  constructor(bindings: Binding[], spec: CodeModeSpec = {}, post?: Call) {
    this.bindings = bindings;
    const silo = spec.silo ?? process.env.PRAECISE_SILO ?? "unix:/run/furcate-silo/api.sock";
    this.post = post ?? transport(silo, process.env.PRAECISE_SILO_TOKEN);
    this.language = spec.language ?? "typescript";
    this.ttl = spec.ttl ?? 1800;
  }

  async listTools(): Promise<McpTool[]> {
    return [];
  }

  remember(): void {}

  private async create(): Promise<string> {
    const r = await this.post("/v1/silo/create", { ttl_s: this.ttl, label: "praecise code mode", bindings: this.bindings });
    if (r.status !== 200 || typeof r.json.id !== "string") {
      throw new Error(`the silo did not start: ${String(r.json.error ?? r.status)}`);
    }
    return r.json.id;
  }

  async call(_tool: string, args: Record<string, unknown>): Promise<string> {
    const code = typeof args.code === "string" ? args.code : "";
    if (!code.trim()) throw new Error("code is required");
    for (let attempt = 0; attempt < 2; attempt++) {
      this.id ??= await this.create();
      const r = await this.post("/v1/silo/run", { id: this.id, code, language: this.language });
      if (r.status === 404 && attempt === 0) {
        // Its term ended: start a fresh one and run the program once more.
        this.id = undefined;
        continue;
      }
      if (r.status !== 200) throw new Error(String(r.json.error ?? `the silo answered ${r.status}`));
      return render(r.json);
    }
    throw new Error("the silo could not be reached");
  }

  close(): void {
    const id = this.id;
    this.id = undefined;
    if (id) void this.post("/v1/silo/delete", { id }).catch(() => undefined);
  }
}

function cut(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n--- TRUNCATED ---` : text;
}

/** What the model reads back: the result, and what went wrong if anything did. */
export function render(out: Record<string, unknown>): string {
  const stdout = typeof out.stdout === "string" ? out.stdout.trimEnd() : "";
  const stderr = typeof out.stderr === "string" ? out.stderr.trimEnd() : "";
  if (out.timed_out) return cut(`The program ran out of time.${stderr ? `\n${stderr}` : ""}`);
  if (out.exit !== 0) {
    return cut(`The program failed (exit ${String(out.exit)}).${stderr ? `\n${stderr}` : ""}${stdout ? `\n${stdout}` : ""}`);
  }
  return cut(stdout || "(the program returned nothing)");
}
