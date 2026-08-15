/**
 * The pieces `praecise add` can write for you.
 *
 * `init` gives you an agent. Everything after that — a function it can call, a service it
 * can reach, somewhere to keep things, a guard on what it may do — you had to know the
 * shape of already, because `add` only knew about blueprints an app had written for
 * itself and a new app has written none. So the second command anybody runs printed
 * "no blueprints in this app" and stopped.
 *
 * These are the shapes, with the decisions already made and the reasons in the file. They
 * are deliberately small: a piece you have to delete half of is worse than a blank file,
 * and the point is to get the conventions right on the first try rather than to write
 * somebody's application for them.
 */

export interface Piece {
  name: string;
  summary: string;
  /** Where it goes, given a name. */
  path: (name: string) => string;
  contents: (name: string, framework: string) => string;
  /** What to say after writing it, when there is something to do next. */
  next?: string;
}

const camel = (name: string): string =>
  name.replace(/[^A-Za-z0-9]+(.)/g, (_, ch: string) => ch.toUpperCase());

export const PIECES: Piece[] = [
  {
    name: "function",
    summary: "your own code, callable by an agent",
    path: (name) => `functions/${name}.ts`,
    next: "add it to an agent's `tools` list to let the agent call it",
    contents: (_name, framework) => `import { fn } from "${framework}";

export default fn({
  // The model reads this to decide WHEN to call it, so it is closer to
  // documentation for a colleague than to a summary of the code.
  description: "Look up an order by its id.",

  // Argument names to plain-English hints. This is the schema the model sees,
  // and it types the \`run\` arguments below — a field you did not declare is a
  // compile error rather than \`undefined\` at runtime.
  input: { order: "the order id, like ACME-1024" },

  // "read" changes nothing; "write" does. A guard can refuse on this alone,
  // which is why it is worth being honest about.
  effect: "read",

  run: async ({ order }) => {
    // Whatever this returns is what the model sees. Return data rather than
    // prose: the model reads JSON perfectly well and prose loses the fields.
    return { order, status: "delivered", carrier: "DPD" };
  },
});
`,
  },
  {
    name: "tool",
    summary: "an MCP service, a launched program, or an API with an OpenAPI description",
    path: (name) => `tools/${name}.ts`,
    next: "put its credential in .env, then add it to an agent's `tools` list",
    contents: (name, framework) => `import { tool } from "${framework}";

export default tool({
  // One of three, never more than one:
  //
  //   url:     an MCP server you call
  //   command: an MCP server you launch — a large share of published ones are
  //            programs rather than endpoints
  //   openapi: an ordinary HTTP API that has a description; every operation
  //            becomes a tool, with no MCP server in between
  url: "https://${name}.example.com/mcp",

  // Read from the environment. Left out, it looks for ${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY.
  credential: "${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN",

  // Documents this service publishes that every request should carry. "*" takes
  // everything it offers. Omit unless the agent genuinely needs the context —
  // these are read on every request, on purpose, because a cached answer to
  // "what is true now" is worse than none.
  // resources: ["*"],
});
`,
  },
  {
    name: "store",
    summary: "somewhere to keep things — notes, documents, vectors, rows",
    path: (name) => `stores/${name}.ts`,
    next: "point an agent's `memory` at it, or ingest documents with `praecise ingest`",
    contents: (name, framework) => `import { store } from "${framework}";

export default store({
  // What family this is. The backend has to serve it, and saying so here is what
  // lets a mismatch be an error at load rather than a surprise at runtime.
  //
  //   document   text you search
  //   vector     embeddings you compare (needs \`dimensions\`)
  //   sql        rows you query
  //   timeseries points you aggregate
  of: "document",

  // Left out, this is SQLite in .praecise/ — no service to run, nothing to
  // configure, and the same four verbs as everything else. Point it at Postgres
  // by giving it a url, and nothing above this line changes.
  // url: "postgres://localhost/${camel(name)}",
});
`,
  },
  {
    name: "workflow",
    summary: "steps with dependencies, checkpointed and resumable",
    path: (name) => `workflows/${name}.ts`,
    next: "run it with `praecise run " + "<name>" + "`, or POST to /api/workflows/<name>",
    contents: (_name, framework) => `import { workflow } from "${framework}";

export default workflow({
  description: "Handle one case from start to finish.",

  // Named inputs, as plain-English hints. These become the run form in the
  // dashboard and the schema an MCP client sees.
  input: { case: "what happened, in the customer's words" },

  // A list, but a graph: \`after\` is what makes it one. Steps with no
  // dependency between them run at the same time.
  //
  // \`after\` only accepts ids that exist in this list — a typo is a compile
  // error rather than a step that is never ready.
  steps: [
    { id: "read", ask: "Summarise this case: {{case}}", agent: "assistant" },
    { id: "decide", ask: "What should we do about it?", agent: "assistant", after: ["read"] },
  ],

  // What the run is supposed to have achieved. Checked after it finishes, so a
  // workflow that ran cleanly and did nothing useful is not reported as success.
  // outcome: { that: "the case has a decision recorded against it" },
});
`,
  },
  {
    name: "guard",
    summary: "what the app is actually allowed to do",
    path: () => "guard.ts",
    next: "it applies to every agent immediately — nothing to wire",
    contents: (_name, framework) => `import { guard } from "${framework}";

// One function, for the whole app. It sees every attempted TOOL CALL before it
// happens — which agent, which tool, what arguments, and whether the tool
// declares that it writes.
//
// Return a reason to refuse, or nothing to allow. The reason is written for the
// model to read, so write it as one: a model handed an explanation can choose
// something else, and a model handed an exception can only stop.
export default guard((attempt) => {
  if (attempt.effect === "write" && attempt.via !== "cli") {
    return "this deployment only makes changes when a person runs the command";
  }

  // A tool from a service is whatever that service makes of it, so a guard that
  // cares should decide on \`origin\` rather than assume an effect was declared.
  if (attempt.origin === "remote" && attempt.tool.includes("delete")) {
    return "deleting through a third-party service is not allowed here";
  }

  return undefined;
});
`,
  },
  {
    name: "memory",
    summary: "a note every agent can answer from",
    path: (name) => `memory/${name}.md`,
    next: "it is in scope for every agent on the next reload — nothing to wire",
    contents: (name) => `# ${camel(name).replace(/^./, (c) => c.toUpperCase())}

Anything in \`memory/\` is knowledge every agent in this app can answer from.
Plain Markdown, no wrapper, no registry — the file being here is the wiring.

Write what you would tell a new colleague on their first day, not what you would
put in a specification. Short paragraphs with a clear subject retrieve better
than long ones that bury it.

## What this covers

Replace this with something true about your business. A note that describes the
file rather than the domain is worse than no note: it will be retrieved, take up
room in the prompt, and answer nothing.
`,
  },
  {
    name: "prompt",
    summary: "a canned request a person picks",
    path: (name) => `prompts/${name}.ts`,
    next: "MCP clients list it under prompts; the dashboard offers it as a button",
    contents: (_name, framework) => `import { prompt } from "${framework}";

export default prompt({
  description: "Draft a reply to a customer about an order.",

  // Every {{placeholder}} in the text below must name one of these. A typo is a
  // compile error rather than a hole in the sentence the model receives.
  input: { customer: "who is asking", order: "the order id" },

  text: "Draft a short, warm reply to {{customer}} about order {{order}}. " +
    "Say what has happened and what happens next. Do not apologise twice.",
});
`,
  },
];

/** One piece by name, if there is one. */
export const pieceNamed = (name: string): Piece | undefined =>
  PIECES.find((piece) => piece.name === name);
