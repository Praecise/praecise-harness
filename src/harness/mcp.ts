/**
 * A minimal MCP client over streamable HTTP — enough to discover a server's
 * tools and call them. Servers may answer JSON-RPC with either a JSON body or
 * an SSE stream, so both are handled.
 *
 * Tool names are namespaced `service__tool` on the way out, because providers
 * restrict tool names to `[A-Za-z0-9_-]` and an agent may hold several services
 * at once.
 */

import type { ResolvedService } from "../compile/services.js";
import { StdioTransport } from "./stdio-transport.js";
import type { ToolSchema } from "./types.js";

/** The revision we speak when calling out. Kept level with the one we serve. */
const PROTOCOL_VERSION = "2025-11-25";
const SEPARATOR = "__";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface RpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

/** Pull the first JSON-RPC payload out of an SSE stream. */
function parseSse(body: string): unknown {
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      return JSON.parse(line.slice(5).trim());
    } catch {
      // A partial or non-JSON data frame; keep looking.
    }
  }
  return undefined;
}

export class McpClient {
  /** Set when this service is a launched program rather than an endpoint. */
  private readonly stdio?: StdioTransport;
  private sessionId?: string;
  private initialized = false;
  private nextId = 1;

  constructor(
    private readonly service: ResolvedService,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (service.command?.length) {
      this.stdio = new StdioTransport({
        command: service.command[0] as string,
        args: service.command.slice(1),
        env: service.env,
      });
    }
  }

  /** Stop a launched server. A spawned process outlives good intentions. */
  close(): void {
    this.stdio?.close();
  }

  get name(): string {
    return this.service.name;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (this.service.apiKey) {
      if (this.service.auth === "header" && this.service.header) {
        headers[this.service.header] = this.service.apiKey;
      } else {
        headers.authorization = `Bearer ${this.service.apiKey}`;
      }
    }
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  private async rpc(method: string, params?: unknown, notify = false): Promise<unknown> {
    const body = notify
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: this.nextId++, method, params };

    // A launched server is spoken to over its own stdin and stdout; everything above
    // this line is identical either way, which is the point of putting the split here.
    if (this.stdio) {
      if (notify) {
        this.stdio.notify(method, params);
        return undefined;
      }
      return this.stdio.request((body as { id: number }).id, method, params);
    }

    const response = await this.fetchImpl(this.service.url as string, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;

    if (!response.ok) {
      throw new Error(
        `MCP ${this.service.name} ${method} failed (${response.status}): ` +
          `${(await response.text().catch(() => "")).slice(0, 200)}`,
      );
    }
    if (notify) return undefined;

    const text = await response.text();
    if (!text.trim()) return undefined;

    const payload = (
      response.headers.get("content-type")?.includes("text/event-stream")
        ? parseSse(text)
        : JSON.parse(text)
    ) as RpcResponse | undefined;

    if (payload?.error) {
      throw new Error(`MCP ${this.service.name} ${method}: ${payload.error.message}`);
    }
    return payload?.result;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "praecise", version: "0.1.0" },
    });
    // Best-effort: some servers do not implement the notification.
    await this.rpc("notifications/initialized", {}, true).catch(() => undefined);
    this.initialized = true;
  }

  async listTools(): Promise<McpTool[]> {
    await this.ensureInitialized();
    const result = (await this.rpc("tools/list", {})) as { tools?: McpTool[] } | undefined;
    return (result?.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  /** Call a tool and flatten its content blocks to text. */
  async call(
    tool: string,
    args: Record<string, unknown>,
    opts: { idempotencyKey?: string } = {},
  ): Promise<string> {
    await this.ensureInitialized();
    const params: Record<string, unknown> = { name: tool, arguments: args };
    // `_meta` is MCP's reserved sideband for exactly this: a compliant server can
    // dedupe a retried side effect on the key without any schema change, and one
    // that ignores `_meta` sees the call it always saw.
    if (opts.idempotencyKey) params._meta = { "praecise/idempotencyKey": opts.idempotencyKey };
    const result = (await this.rpc("tools/call", params)) as
      | { content?: { type: string; text?: string }[]; isError?: boolean }
      | undefined;

    const text = (result?.content ?? [])
      .map((block) => (block.type === "text" ? (block.text ?? "") : JSON.stringify(block)))
      .join("\n")
      .trim();

    if (result?.isError) throw new Error(text || `tool ${tool} reported an error`);
    return text || "(no output)";
  }
}

/** Namespaced name a model sees for a service's tool. */
export const toolName = (service: string, tool: string): string =>
  `${service}${SEPARATOR}${tool}`;

/** Split a namespaced tool name back into service and tool. */
export function splitToolName(name: string): { service: string; tool: string } | undefined {
  const at = name.indexOf(SEPARATOR);
  if (at <= 0) return undefined;
  return { service: name.slice(0, at), tool: name.slice(at + SEPARATOR.length) };
}

/**
 * Connect to every configured service and collect their tools. A service that
 * is unreachable or missing its credential is skipped with a note rather than
 * failing the request — losing one integration should not take the agent down.
 */
export async function collectTools(
  services: ResolvedService[],
  fetchImpl: typeof fetch = fetch,
): Promise<{
  schemas: ToolSchema[];
  clients: Map<string, McpClient>;
  notes: string[];
}> {
  const schemas: ToolSchema[] = [];
  const clients = new Map<string, McpClient>();
  const notes: string[] = [];

  await Promise.all(
    services.map(async (service) => {
      if (!service.apiKey) {
        notes.push(`service "${service.name}" skipped: ${service.credential} is not set`);
        return;
      }
      const client = new McpClient(service, fetchImpl);
      try {
        const tools = await client.listTools();
        clients.set(service.name, client);
        for (const tool of tools) {
          schemas.push({
            name: toolName(service.name, tool.name),
            description: tool.description,
            parameters: tool.inputSchema,
          });
        }
      } catch (err) {
        notes.push(`service "${service.name}" unavailable: ${(err as Error).message}`);
      }
    }),
  );

  return { schemas, clients, notes };
}
