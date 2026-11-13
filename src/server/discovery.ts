/**
 * Being found and understood by a machine, which is the SEO problem restated for a reader
 * that does not have eyes.
 *
 * A website tells a search crawler what it is through `<meta>` tags, a sitemap, and
 * JSON-LD, and that whole apparatus assumes the same thing: a crawler fetches pages,
 * extracts text, and ranks it for a human who will click. None of those assumptions hold
 * for an agent. An agent does not browse, does not click, and does not want a page — it
 * wants to know what this system can DO and how to invoke it, and it will decide that in
 * one request.
 *
 * So the equivalent of "SEO metadata" here is four different documents for four different
 * kinds of reader, all generated from the same app so they cannot disagree:
 *
 *   `/llms.txt`                     a curated Markdown map, for a model reading the site
 *   `/.well-known/agent-card.json`  A2A: what a peer agent can delegate here
 *   `/mcp`                          MCP: what a tool-calling model can invoke
 *   `/ask`                          NLWeb: a natural-language question, answered
 *
 * Plus JSON-LD on the human pages, because a general web crawler still reads that and it
 * costs nothing to be legible to both.
 *
 * ── Why generated rather than authored ────────────────────────────────────────
 *
 * Every one of these is a description of the app's published surface, and that surface is
 * already declared: agents, workflows and functions with their descriptions, effects, and
 * access. A hand-written `llms.txt` is a second copy of that, and a second copy is a copy
 * that goes stale — the failure being avoided is an app that tells an agent it can do
 * something it removed a month ago. Nothing here is authored; it is all derived, and it
 * is filtered by the SAME access rules that filter the tool list, so a discovery document
 * never advertises what a caller could not reach.
 */

import { PROTOCOL_VERSION, groupsOf, publishedOf, type Caller } from "./mcp.js";
import { AGENT_CARD_PATH } from "./a2a.js";
import { ASYNCAPI_PATH } from "./asyncapi.js";
import type { App } from "../app.js";
import { listingNote, listingOf } from "./catalogue.js";

/**
 * Where an MCP client reads what this server is before it connects: the streamable
 * HTTP URL with `/server-card` appended (SEP-2127).
 */
export const MCP_SERVER_CARD_PATH = "/mcp/server-card";

/**
 * The MCP Server Card: who this server is and where it listens, and nothing else.
 *
 * It carries no tools and no capabilities on purpose. Those depend on who is asking and
 * are answered by the protocol itself once connected; a static copy here would be a second
 * list to keep true, and one a cache hands to callers it was not filtered for.
 *
 * `icons`, `repository` and `websiteUrl` are left out rather than guessed: an app
 * declares none of them. Field spellings are the camelCase ones SEP-2127 was described
 * with when this was written; `remotes` with `type: "streamable-http"` follows the MCP
 * registry's server description and was not checked against the published card schema.
 */
export function mcpServerCard(app: App, baseUrl = ""): Record<string, unknown> {
  return {
    name: app.name,
    title: app.name,
    version: app.version,
    description: `${app.name}, published by Praecise Harness`,
    remotes: [{ type: "streamable-http", url: `${baseUrl}/mcp` }],
    supportedProtocolVersions: [PROTOCOL_VERSION],
  };
}

/** Where a model looks for a curated map of a site. */
export const LLMS_TXT_PATH = "/llms.txt";

/** Where the JSON-LD description is served. */
const AI_JSON_PATH = "/ai.json";

/** The one URL a client asks to learn everything else this origin offers. */
export const AI_CATALOG_PATH = "/.well-known/ai-catalog.json";

/**
 * The version of the shape `aiCatalog` writes. It is this framework's, not the
 * specification's: the specification has not settled on one to quote.
 */
export const AI_CATALOG_VERSION = "0.1-provisional";

/**
 * The AI Catalog: every machine-readable description this origin serves, behind one URL.
 *
 * PROVISIONAL. The AI Catalog is a Linux Foundation draft awaiting adoption by the MCP
 * and A2A steering committees, and this was not written against its schema. The shape is
 * modelled on what the draft is for — a well-known index, like the agent card's own
 * placement, whose entries each say what a thing is (`type`), where it is (`url`) and
 * why a client would fetch it (`description`). The `type` values are this framework's
 * names. Expect the field names to change when the draft is adopted; `catalogVersion`
 * is what a reader keys on to tell this shape from the adopted one.
 *
 * Pure, and the same for every caller: it lists documents, never capabilities, so there
 * is nothing on it to filter.
 */
export function aiCatalog(app: App, baseUrl = ""): Record<string, unknown> {
  const at = (path: string): string => `${baseUrl}${path}`;
  return {
    catalogVersion: AI_CATALOG_VERSION,
    name: app.name,
    version: app.version,
    entries: [
      {
        type: "mcp-server-card",
        url: at(MCP_SERVER_CARD_PATH),
        description: "MCP Server Card: what the MCP server is and which protocol versions it speaks.",
      },
      {
        type: "mcp-server",
        url: at("/mcp"),
        description: "Model Context Protocol endpoint, streamable HTTP. POST JSON-RPC.",
      },
      {
        type: "a2a-agent-card",
        url: at(AGENT_CARD_PATH),
        description: "A2A agent card: what a peer agent can delegate here, and how to reach it.",
      },
      {
        type: "llms-txt",
        url: at(LLMS_TXT_PATH),
        description: "A Markdown map of this app's capabilities, for a model reading the site.",
      },
      {
        type: "json-ld",
        url: at(AI_JSON_PATH),
        description: "The same surface as schema.org JSON-LD, for a reader that parses rather than reads.",
      },
      {
        type: "asyncapi",
        url: at(ASYNCAPI_PATH),
        description: "AsyncAPI description of the events this app receives and sends, as CloudEvents.",
      },
    ],
  };
}

/**
 * `llms.txt` — a Markdown map of this app, for a model that arrived without being told
 * what it found.
 *
 * The format is small and specified: one H1 with the name, a blockquote summary, then
 * H2-delimited lists of `[name](url): notes`. It is deliberately Markdown rather than
 * JSON because the reader is a language model, and the point of the file is to be the
 * one thing worth putting in a context window instead of crawling everything.
 *
 * What this writes is the app's real surface: the agents, workflows and functions it
 * publishes, and the protocol endpoints that let a machine act rather than read.
 */
export function llmsTxt(app: App, caller: Caller = {}, baseUrl = ""): string {
  const published = publishedOf(app, caller);
  const groups = groupsOf(app);
  const at = (path: string): string => `${baseUrl}${path}`;

  const lines: string[] = [
    `# ${app.name}`,
    "",
    `> ${app.name} is an agentic application. It publishes ${published.length} ` +
      `${published.length === 1 ? "capability" : "capabilities"} that a model or another agent can invoke ` +
      `directly — not pages to read. Prefer calling one of them over scraping anything here.`,
    "",
  ];

  if (published.length) {
    // Named "Capabilities" rather than "Docs": these are things to DO. A model reading
    // this file is deciding whether to act, not whether to keep reading.
    lines.push("## Capabilities", "");
    for (const { tool, group } of published) {
      // Three groups, three routes. Sending a workflow to /api/agents/ answers
      // `no agent named "x"` — a dead link in the one file a model reads to decide what to call.
      lines.push(`- [${tool.name}](${at(`/api/${group}/${tool.name}`)}): ${tool.description}${listingNote(app, tool.name)}`);
    }
    lines.push("");
  }

  lines.push(
    "## Interfaces",
    "",
    `- [MCP](${at("/mcp")}): Model Context Protocol endpoint. POST JSON-RPC; every capability above is a tool.`,
    `- [MCP server card](${at(MCP_SERVER_CARD_PATH)}): what the MCP server is and which protocol versions it speaks, before connecting.`,
    `- [Agent card](${at(AGENT_CARD_PATH)}): A2A. What this agent accepts when another agent delegates to it.`,
    `- [Ask](${at("/ask")}): a natural-language question, answered from this app's own knowledge and data.`,
    `- [Events](${at(ASYNCAPI_PATH)}): AsyncAPI. The events this app can be sent, where to send them, and the ones it sends.`,
    `- [AI catalog](${at(AI_CATALOG_PATH)}): every discovery document this origin serves, from one URL. A draft format.`,
    "",
  );

  if (groups.length > 1) {
    lines.push(
      "## Notes",
      "",
      `- Capabilities are grouped: ${groups.join(", ")}. A client may request a subset with \`?groups=\`.`,
      `- Some capabilities may be withheld from an unauthenticated caller; this file lists only what you can reach.`,
      "",
    );
  }

  return lines.join("\n");
}

/**
 * The same surface as JSON-LD, for a reader that parses rather than reads.
 *
 * A general web crawler and a schema.org consumer both understand this, and emitting it
 * costs nothing. `SoftwareApplication` with `potentialAction` entries is the honest
 * vocabulary: this is a piece of software with things you can ask it to do, which is
 * closer to the truth than describing an agent as a `WebPage`.
 */
export function jsonLd(app: App, caller: Caller = {}, baseUrl = ""): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: app.name,
    applicationCategory: "AIApplication",
    softwareVersion: app.version,
    url: baseUrl || undefined,
    description: `${app.name}, an agentic application published by Praecise Harness.`,
    // Each capability as an action a machine could take, with where to take it.
    potentialAction: publishedOf(app, caller).map(({ tool, group }) => ({
      "@type": "Action",
      name: tool.name,
      description: tool.description,
      ...catalogued(app, tool.name),
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${baseUrl}/api/${group}/${tool.name}`,
        httpMethod: "POST",
        contentType: "application/json",
      },
    })),
    // Where a machine goes to do something rather than read something.
    subjectOf: [
      { "@type": "WebAPI", name: "MCP", url: `${baseUrl}/mcp` },
      { "@type": "WebAPI", name: "A2A", url: `${baseUrl}${AGENT_CARD_PATH}` },
      { "@type": "WebAPI", name: "Ask", url: `${baseUrl}/ask` },
      { "@type": "DataCatalog", name: "AI Catalog", url: `${baseUrl}${AI_CATALOG_PATH}` },
    ],
  };
}

/** What an agent's `meta` adds to its action: what it is about and the languages it works in. */
function catalogued(app: App, name: string): Record<string, unknown> {
  const meta = listingOf(app, name).meta;
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [];
  const tags = list(meta?.tags);
  const languages = list(meta?.languages);
  return {
    ...(tags.length ? { keywords: tags.join(", ") } : {}),
    ...(languages.length ? { inLanguage: languages } : {}),
  };
}

/**
 * The JSON-LD block, ready to drop into a page's `<head>`.
 *
 * `<` is escaped inside the JSON because a string in the data containing `</script>`
 * would otherwise close the tag early — an injection with a very old pedigree and no
 * excuse for appearing in newly written code.
 */
export function jsonLdScript(app: App, caller: Caller = {}, baseUrl = ""): string {
  const data = JSON.stringify(jsonLd(app, caller, baseUrl), null, 2).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">\n${data}\n</script>`;
}

/**
 * `robots.txt`, which is about consent rather than discovery.
 *
 * Worth generating for one reason: the crawl directives a site actually wants for an
 * agentic app are the opposite of a content site's. There are no pages worth indexing and
 * a great deal worth NOT hammering — every `/api/` path costs a model call. So the
 * default points machines at `llms.txt` and away from the endpoints that spend money.
 */
export function robotsTxt(baseUrl = ""): string {
  return [
    "# An agentic application. There is little here to index and much that costs money to call.",
    "User-agent: *",
    "Allow: /$",
    "Allow: /llms.txt",
    "Disallow: /api/",
    "Disallow: /mcp",
    // The card is a description, not a call: it costs nothing and is meant to be fetched.
    `Allow: ${MCP_SERVER_CARD_PATH}`,
    "Disallow: /a2a",
    "Disallow: /ask",
    // The Responses ingress: every call to it is a model call.
    "Disallow: /v1/",
    "",
    `# What to read instead: ${baseUrl}/llms.txt`,
    "",
  ].join("\n");
}
