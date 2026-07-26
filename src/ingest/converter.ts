/**
 * Where a file goes when the built-in converters cannot read it.
 *
 * Three destinations, chosen by `ingest.using` in the config. They all take the
 * bytes and give back text, so the pipeline does not care which one answered.
 */

import { basename } from "node:path";

import { McpClient } from "../harness/mcp.js";
import type { AppConfig } from "../define.js";
import type { Converted, Converter, ConvertRequest } from "./index.js";

const GATEWAY = "https://api.praecise.com";

/** An MCP server that converts documents — markitdown-mcp and the like. */
function overMcp(url: string, apiKey: string | undefined, fetchImpl: typeof fetch): Converter {
  const client = new McpClient(
    { name: "ingest", url, credential: "", auth: "bearer", apiKey },
    fetchImpl,
  );
  let toolName: Promise<string> | undefined;

  const findTool = async (): Promise<string> => {
    const tools = await client.listTools();
    const match =
      tools.find((tool) => /convert|markdown|extract/i.test(tool.name)) ?? tools[0];
    if (!match) throw new Error("the server advertises no tools");
    return match.name;
  };

  return async ({ bytes, path, ext }: ConvertRequest): Promise<Converted> => {
    toolName ??= findTool();
    const text = await client.call(await toolName, {
      filename: basename(path),
      extension: ext,
      content: bytes.toString("base64"),
      encoding: "base64",
    });
    return { text };
  };
}

/** The hosted service: one key, every format. */
function overCloud(url: string, apiKey: string, fetchImpl: typeof fetch): Converter {
  return async ({ bytes, path, ext }: ConvertRequest): Promise<Converted> => {
    const response = await fetchImpl(`${url.replace(/\/$/, "")}/v1/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/octet-stream",
        "x-filename": basename(path),
        "x-extension": ext,
      },
      body: new Uint8Array(bytes),
    });
    if (!response.ok) {
      throw new Error(`ingest service responded ${response.status}`);
    }
    const payload = (await response.json()) as { text?: string; note?: string };
    return { text: payload.text ?? "", note: payload.note };
  };
}

export interface ConverterOptions {
  config?: AppConfig;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

/**
 * Build the converter the pipeline hands off to, or nothing when none is
 * configured — in which case an unreadable file is reported, not guessed at.
 */
export function converterFor(options: ConverterOptions = {}): Converter | undefined {
  const env = options.env ?? process.env;
  const ingest = options.config?.ingest;
  const fetchImpl = options.fetch ?? fetch;
  const using = ingest?.using ?? (ingest?.url ? "mcp" : env.PRAECISE_API_KEY ? "cloud" : "native");

  if (using === "native") return undefined;

  const key = ingest?.credential ? env[ingest.credential] : undefined;

  if (using === "mcp") {
    if (!ingest?.url) return undefined;
    return overMcp(ingest.url, key, fetchImpl);
  }

  if (using === "cloud") {
    const cloudKey = key ?? env.PRAECISE_API_KEY;
    if (!cloudKey) return undefined;
    return overCloud(ingest?.url ?? env.PRAECISE_GATEWAY_URL ?? GATEWAY, cloudKey, fetchImpl);
  }

  // "model" — reading a page as an image needs a vision request, which the
  // built-in runtime does not make. Say so rather than silently doing nothing.
  return async () => ({
    text: "",
    note: 'ingest.using: "model" needs a converter that can see images; set ingest.url or PRAECISE_API_KEY',
  });
}
