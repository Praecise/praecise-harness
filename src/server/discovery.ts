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

import { groupsOf, toolsOf, type Caller } from "./mcp.js";
import { AGENT_CARD_PATH } from "./a2a.js";
import type { App } from "../app.js";

/** Where a model looks for a curated map of a site. */
export const LLMS_TXT_PATH = "/llms.txt";

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
  const published = toolsOf(app, caller);
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
    for (const tool of published) {
      lines.push(`- [${tool.name}](${at(`/api/agents/${tool.name}`)}): ${tool.description}`);
    }
    lines.push("");
  }

  lines.push(
    "## Interfaces",
    "",
    `- [MCP](${at("/mcp")}): Model Context Protocol endpoint. POST JSON-RPC; every capability above is a tool.`,
    `- [Agent card](${at(AGENT_CARD_PATH)}): A2A. What this agent accepts when another agent delegates to it.`,
    `- [Ask](${at("/ask")}): a natural-language question, answered from this app's own knowledge and data.`,
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
    potentialAction: toolsOf(app, caller).map((tool) => ({
      "@type": "Action",
      name: tool.name,
      description: tool.description,
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${baseUrl}/api/agents/${tool.name}`,
        httpMethod: "POST",
        contentType: "application/json",
      },
    })),
    // Where a machine goes to do something rather than read something.
    subjectOf: [
      { "@type": "WebAPI", name: "MCP", url: `${baseUrl}/mcp` },
      { "@type": "WebAPI", name: "A2A", url: `${baseUrl}${AGENT_CARD_PATH}` },
      { "@type": "WebAPI", name: "Ask", url: `${baseUrl}/ask` },
    ],
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
    "Disallow: /a2a",
    "Disallow: /ask",
    "",
    `# What to read instead: ${baseUrl}/llms.txt`,
    "",
  ].join("\n");
}
