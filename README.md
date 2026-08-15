# praecise

The framework for AI agents. A folder is an app.

You describe what an agent is for, what it knows, and what it may act through.
Everything underneath — which model to use, when to escalate to a stronger one,
how to ground an answer in your files, how to remember a conversation, how to
resume a workflow that stopped for a human — is derived and handled for you.

```
my-app/
├─ agents/support.ts
├─ functions/refund.ts
├─ memory/faq.md
└─ .env
```

```ts
// agents/support.ts
import { agent } from "praecise";

export default agent({
  role: "Customer support for Acme.",
  tools: ["refund"],
});
```

```sh
npx praecise dev
```

```
→ http://localhost:3000/support
  chat UI · REST · MCP endpoint
```

## Install

Node 22 or newer.

```sh
npx praecise init my-app
cd my-app
npm install
```

Put one key in `.env` and you are running:

```sh
PRAECISE_API_KEY=...
```

That runs the app on Praecise Cloud, which decides what each rung of the ladder
runs on. There is nothing to choose and no model id to keep current.

To run on your own endpoints instead, describe them in `praecise.config.ts` and
put their keys in `.env`:

```ts
export default defineConfig({
  models: {
    house: {
      url: "https://models.internal",
      credential: "HOUSE_KEY",
      speaks: "chat",
      fast: "…", balanced: "…", best: "…",
      room: 200_000,
    },
  },
});
```

The first endpoint whose credential is present is the one that runs, and a
declared endpoint always beats the cloud. Naming a single model is fine — every
rung then runs on it. The framework knows no endpoint but Praecise Cloud by
name: a base URL and a model id belong to the app that chose them.

`room` is how much context that endpoint has, in tokens. Everything carried into
a request — the instructions, what was recalled, the conversation so far, and
what a tool handed back — is a share of it, so an endpoint with room to spare
uses it. Leave it out and a modest figure is assumed, which costs you nothing
except some of the conversation you could have carried.

## The folder

Nothing here is required except the one folder you actually use.

```
agents/          one file per agent
workflows/       one file per workflow
memory/          .md and .txt every agent can answer from
functions/       your own code, callable by an agent
tools/           MCP services the app may act through
stores/          somewhere to keep things
guard.ts         which tool calls the app actually makes
praecise.config.ts
.env
```

A file's name is its name: `agents/support.ts` is the agent `support`, served at
`/support`. No registry, no imports between files, no config to keep in sync.

TypeScript works with no setup. `praecise dev`, `run`, `list`, `mcp` and `package` compile
the app before loading it, into `.praecise/build`, using the `typescript` in your own
project — so the version you chose is the version your code is built with, and praecise
itself stays dependency-free. Only what changed is rebuilt.

It is a transpile, not a type check: types are erased and nothing is verified, which is why
it takes milliseconds and why a type error never stops a dev server. Checking types is
`npm run typecheck` (`tsc --noEmit`), in your editor and in CI, where a type error should
stop something.

Nothing is built for a JavaScript app, or on a runtime that reads TypeScript natively.

## Or as an SDK, without a folder

The folder is the default and not the only way in. The same app can be a value you
import:

```ts
import { createApp, agent, fn, guard } from "praecise";

const app = await createApp({
  name: "acme",
  config: { models: { /* ... */ } },
  agents: {
    support: agent({ role: "Help.", description: "Answers questions.", tools: ["lookup"] }),
  },
  functions: {
    lookup: fn({
      description: "Look up an order.",
      input: { id: "the order id" },
      effect: "read",
      run: ({ id }) => ({ id, status: "delivered" }),
    }),
  },
  guard: guard((attempt) => (attempt.effect === "write" ? "read-only today" : undefined)),
});

await app.ask("support", "where is order 12?");
```

The record key is the name, which is the rule the folder already uses:
`agents/support.ts` and `{ agents: { support } }` are the same agent by the same name.

Reach for this when the folder cannot be one:

- **You are shipping agents in a package.** A library cannot ship a folder — it can ship
  one to copy, which stops receiving fixes the moment it is copied. It can export an app,
  or a piece of one.
- **There is no filesystem to scan.** An edge worker, a bundled binary, a browser. The
  loader needs `readdir` and dynamic `import` of arbitrary paths; a bundler needs to see
  imports statically. Those requirements are opposed, and this side satisfies the second.
- **The app is assembled, not written.** Generated from a spec, composed per tenant, built
  from parts.

Both doors produce the same project and run the same checks. An agent with no role, memory
pointing at a store that does not exist, a workflow with a cycle — each is refused the same
way in the same words, because two front doors with two standards is a framework where a
bug report cannot be reproduced.

`defineApp` returns the project without starting it, so you can inspect `warnings` and
`faults` first. `createApp` refuses to start a faulted app rather than serving one that is
missing the agent the next request names.

## Building on it, rather than in it

A third shape, for a package whose job is to *be* built on. Export a piece of an app and
let the application compose it:

```ts
// in your library
export const observability = {
  agents: { auditor: agent({ role: "Audit.", description: "Audits things." }) },
  functions: { measure: fn({ /* ... */ }) },
};

// in the application
import { mergeApps, createApp } from "praecise";
import { observability } from "@acme/observability";

const app = await createApp(mergeApps(observability, myOwnApp));
```

Later definitions win, because the merge order is the caller's statement of precedence —
an application overriding a library's agent is the point. Collisions are **reported** in
`collisions` rather than applied silently: two packages that both export `support` produce
an app where one of them is simply gone, and nobody notices until the wrong one answers.
Two guards is not a guard, so that is reported too.

## Agents

```ts
import { agent } from "praecise";

export default agent({
  role: "Customer support for Acme. Warm, brief, never guesses.",
  knows: ["memory/policies.md"],
  tools: ["refund"],
  rules: ["Never promise a refund date.", "Escalate anything about a chargeback."],
  greeting: "Hi — what can I help with?",
});
```

Every field but `role` is optional. `memory/**` is already included for every
agent, so `knows` is for narrowing, or for pulling in something from elsewhere.

Ask for structured data instead of prose:

```ts
export default agent({
  role: "Sort an incoming support message.",
  quality: "fast",
  memory: false,
  returns: {
    category: "one of: refund, shipping, account, other",
    urgency: "low, normal, or high",
    summary: "one sentence",
  },
});
```

`quality` is `"fast" | "balanced" | "best"` and is the only dial. It is not a
model name — it says how much room there is to work in, not which model answers.

### Which model answers

That is decided per request, before anything is spent, from the size of the
request and what has to be read to answer it. An easy question goes to the cheap
model and costs one call. A large one goes straight to a stronger model, because
starting cheap and climbing would mean paying twice and making the second model
read everything again from cold.

When a request lands near the edge of what a model handles, that model is asked
the same question more than once, at the same time, and the answers are compared
against each other. A model that knows the answer gives it twice; a model that is
guessing does not guess the same way twice. Only then does the agent climb.

Nothing asks a model how sure it is. A model asked that will say it is sure, and
an answer wrapped in a report on itself is worse than the answer.

The framework keeps a record of what it chose and what came of it, under
`.praecise/routing/`. The fact worth having is the one it would otherwise never
learn: whether a stronger model, once asked, said anything different. An agent
whose climbs keep landing on the same answer stops climbing so readily.

None of that is configuration. It is what `quality` means.

## Workflows

Steps run in order. Any `{{name}}` is replaced before the step runs, and can
reference an input or an earlier step.

```ts
import { workflow } from "praecise";

export default workflow({
  input: { message: "the customer's message" },
  steps: [
    { id: "sorted", ask: "{{message}}", agent: "triage" },
    {
      id: "reply",
      when: "{{sorted.category}}",
      is: {
        refund: [
          { id: "draft", ask: "Draft a refund reply: {{message}}", agent: "support" },
          { id: "approved", approve: "Send this?\n\n{{reply.draft}}" },
        ],
      },
      otherwise: [{ id: "draft", ask: "Reply to: {{message}}", agent: "support" }],
    },
  ],
});
```

Five kinds of step:

| | |
|---|---|
| `ask` | delegate to an agent |
| `use` | call a service, e.g. `use: "ledger.create_invoice"` |
| `approve` | stop and wait for a human |
| `each` | run steps once per item, optionally in parallel |
| `when` | branch on a value |

An `approve` step writes the run to disk and returns. It survives a restart, and
resuming replays the recorded outputs rather than re-running the steps before
it — the model is not called twice for work already done.

A string that is *only* a reference keeps its type, so `with: "{{draft}}"` hands
a tool an object rather than `[object Object]`.

## Tools

Anything that speaks MCP goes in `tools/`, one file per service:

```ts
// tools/ledger.ts
import { tool } from "praecise";

export default tool({
  url: "https://ledger.example.com/mcp",
  credential: "LEDGER_TOKEN",
});
```

Then `tools: ["ledger"]` on any agent, and `LEDGER_TOKEN` in `.env`. Leave
`credential` off and it reads `LEDGER_API_KEY`, after the filename.

There is no built-in list of known services. A hard-coded endpoint is someone
else's URL to change and someone else's product to retire; four lines in your
own repo say plainly what your app talks to.

A service that is listed but unconfigured does not break the app — the dashboard
says which key is missing and the agent runs without it.

### A local program, or an ordinary API

A large share of published MCP servers are programs you launch rather than URLs
you call, and most APIs worth reaching have an OpenAPI description and no MCP
server at all. Both are services here:

```ts
// tools/files.ts — a program, spawned without a shell
export default tool({ command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."] });

// tools/stripe.ts — an ordinary HTTP API, described
export default tool({ openapi: "https://api.example.com/openapi.json", credential: "ACME_KEY" });
```

An OpenAPI document becomes one tool per operation, with the parameters flattened
into the single object a model produces and each value's location remembered — so
the model does not have to know which of its arguments are a path segment, a query
string, a header, or the body.

### Servers that want a token you do not have yet

A hosted MCP server is usually an OAuth 2.1 protected resource, and answering its
challenge needs a browser, a callback, and somewhere to keep tokens — three things
a framework should not decide for you. praecise implements the protocol and leaves
those to you: it recognises the challenge, hands it to your `authorize` callback,
and retries the request once with whatever you return.

`OAuthClient` covers the flow itself, including the parts that exist because of an
attack rather than a feature — the `resource` parameter on both requests so a token
minted for one server cannot be spent at another, byte-exact issuer validation, PKCE,
and registrations that are never presented to a server that did not mint them.

## Reading documents into a store

`praecise ingest` turns a folder of documents into rows an agent can answer from:

```sh
praecise ingest ./docs --store catalogue
praecise ingest ./docs --store catalogue --fields "price: the amount in pounds, sku: the product code"
```

PDF, Word, Excel, PowerPoint, CSV, images and source all convert. Text is split at
the document's own paragraph boundaries rather than on a fixed window, because a
half-sentence retrieved alone is worse than a miss — the model completes it from
imagination instead of noticing it is partial.

`--fields` is opt-in and costs a model call per chunk. It turns text you can search
into records you can query, and it refuses rather than guessing: an extraction that
does not parse, or that leaves out a declared field, is kept as text with the reason
recorded. A row with prose where a price should be is worse than a row with no price.

Ids are derived from the source path and the chunk's content, so running it twice
does not double the catalogue and changing one paragraph replaces only that chunk.

Point `ask: { store, type }` at the same store and `/ask` answers from it — the
business's real data, live, rather than a copy.

## Stores

```ts
// stores/history.ts
import { store } from "praecise";

export default store({ of: "sql" });
```

That is a working store. It keeps a file under `.praecise/` and needs nothing
installed. Give it a `url`, or a `credential` naming the environment variable
that holds one, when it should live somewhere else — a `postgres://` url moves it
to a server, and nothing above changes.

The built-in backend's text search rides on the FTS5 module of Node's bundled
SQLite. Whether that module is present is a property of how your Node was BUILT,
not of its version number — the Node 22 this was last checked against has it, and
a build without it raises `no such module: fts5` while everything else about the
store keeps working. If search matters, check rather than assume:

```sh
node -e 'new (require("node:sqlite").DatabaseSync)(":memory:").exec("CREATE VIRTUAL TABLE t USING fts5(x)")'
```

Four verbs work on every store, whichever family you declared:

```ts
const history = await app.store("history");

await history.remember({ text: "customer asked about order 4021", scope: "acme" });

await history.recall("order 4021", { scope: "acme" });   // relevant, recent counting for more
await history.search("4021");                             // contains these terms, whatever its age
await history.history({ limit: 50 });                     // newest first
await history.forget({ scope: "acme" });                  // and how many went
```

`recall` and `search` are different questions. `search` is a lookup and does not
care how old something is. `recall` is a judgement, and a judgement decays —
something said this morning is more likely to be what you meant than the same
sentence from a year ago.

None of the four composes a query, which is the point: an agent asking to recall
something has no string to compose badly. Your own SQL is a separate door:

```ts
await history.query("SELECT total FROM invoices WHERE account = ?", ["acme"]);
```

A store declared `of: "vector"` compares vectors you supply, and falls back to
text when you do not:

```ts
await history.remember({ text: "…", vector: embedding });
await history.recall(embedding, { limit: 5 });
```

Embeddings are supplied rather than derived, because deriving one costs a
credential the framework does not require you to have.

### Which families are served

`of` takes five families. What ships serves four of them, and it serves them
through one shape: a table of text, json metadata, a time, and an optional
vector.

| | |
|---|---|
| `sql` | served — it is a table, and `query` is its own SQL |
| `document` | served — metadata is `jsonb` on a server, JSON on a file |
| `timeseries` | served — ordered and ranged by time, and partitioned by it where TimescaleDB is installed |
| `vector` | served — ordered by pgvector or sqlite-vec where those are installed, compared in this process where they are not |
| `graph` | **not served** — there are no edges here and nothing to walk them with |

A family the backend cannot honour is refused when the store is opened, and the
refusal names what is served and what to do instead. It used to be accepted:
`of: "graph"` against a `postgres://` url got the same table of text as
everything else, and nothing anywhere said so. `of` is still declarative where a
driver *can* honour it — nothing changes about the four verbs — but it is no
longer a word that only reaches a prompt.

Which path a store is actually on is a question with an answer:

```ts
const kept = await app.store("history");

kept.capabilities.vectorSearch;  // "index" — the database orders them
                                 // "scan"  — every vector is read and compared here
kept.capabilities.detail;        // why that one, and what would change it
```

A fallback that is a hundred times slower and completely invisible is the kind
of thing that gets discovered as a latency graph a year later, so it is not
invisible.

### What an extension costs the person installing it

Nothing here requires one, and each is worth a different amount of trouble.

| | |
|---|---|
| **pgvector** | `CREATE EXTENSION vector` — one statement, no restart, no config edit. A `vector` store then keeps embeddings in a real `vector(n)` column with an HNSW index, and `ORDER BY … <=> …` happens in the database. Declare `dimensions`; a column with no width cannot be indexed. |
| **TimescaleDB** | `shared_preload_libraries = 'timescaledb'` in `postgresql.conf`, then **a restart** — the one extension here that costs downtime. A `timeseries` store is then a hypertable in weekly chunks. Only `create_hypertable` is used, which is in the Apache-2.0 subset; compression, continuous aggregates, retention policies and the job scheduler are the source-available half and are deliberately not touched. |
| **sqlite-vec** | Build or download the extension, then name the file in `PRAECISE_SQLITE_EXTENSION`. Off unless that variable is set: loading one runs somebody else's machine code inside the process holding your data, which is a decision for whoever is deploying, not for a framework guessing from a url. |
| **Apache AGE** | `CREATE EXTENSION age`, then `LOAD 'age'` and a `search_path` in **every session**. Nothing here uses it, and a graph store is refused rather than pretended at. |

An existing table is never migrated underneath you. A Postgres store that
already keeps its vectors as `bytea` goes on comparing them here even once the
extension is installed, and says so in `detail` — reading a column that no
longer holds your vectors would not be faster, it would be empty.

All of it is reachable through `query()` right now, whether or not anything
above knows the extension exists:

```ts
await kept.query("SELECT id FROM praecise_items ORDER BY vector <=> $1 LIMIT 5", [asked]);
await kept.query(`SELECT time_bucket('1 day', to_timestamp(at / 1000)) AS day, count(*)
                  FROM praecise_items GROUP BY day ORDER BY day DESC`);
await kept.query("SELECT * FROM cypher('g', $$ MATCH (a)-[:KNOWS]->(b) RETURN b $$) AS (b agtype)");
```

That door is the author's, not the agent's, and it is open before any of this
is.

An agent can remember into a store instead of into files, which is the same two
operations against a real index:

```ts
export default agent({
  role: "Answers customer questions about orders.",
  memory: { store: "history" },
});
```

Each agent is its own scope, so one store holds every agent's memory without any
of them seeing another's.

### Bringing a backend

Three backends ship: a file, a server spoken to over its own wire protocol, and
one that keeps nothing past the process — `url: "memory:"`, for an example or a
test that should leave nothing behind. None costs a dependency. Anything else is
a `Driver` your app hands over, matched to a store by the scheme of its url:

```ts
const app = await App.load({ drivers: [myDriver] });
```

A driver implements named operations — keep these, list that window, match these
terms, drop this scope — not a SQL string. Everything above it is written once
and every backend gets it, and there is no query language between a model and
your data for either of them to get wrong.

Four that are worth the afternoon, one per family this does not serve well or at
all. Each speaks HTTP, so a driver is a `fetch` and the six operations above it:

| | |
|---|---|
| **Qdrant** for `vector` | Apache-2.0. Named vectors, payload filters and a filtered search that stays exact — which is the thing an approximate index gives up when a window narrows. |
| **Neo4j Community** for `graph` | Its Query API is plain HTTP: `POST /db/neo4j/query/v2`, Cypher in the body, Basic auth. The server is GPLv3; speaking HTTP to a server creates no obligation for the thing doing the speaking, which is what makes this reachable without a licence conversation. |
| **CouchDB** for `document` | Apache-2.0, and HTTP is its native interface rather than a gateway to it. Mango selectors do the narrowing. |
| **ClickHouse** for `timeseries` | Apache-2.0. Where a hypertable stops being enough and the question turns into an aggregate over a billion rows. |

None of them is a dependency here, and none of them is endorsed by anything but
the fit. `conform` grades whichever you write exactly as harshly as the ones
that ship.

Most of what a store promises is not in the type. A redacted row keeps its place
and its timestamp; clearing what it said also clears the vector it could still be
found by; a negative limit means the whole window; handing a row back does not
hand over the row itself. A driver can satisfy the compiler completely and get
every one of those wrong, and nothing would say so until an agent recalled
something that was meant to have been taken back. So ask it:

```ts
import { conform, conformanceReport } from "praecise";

console.log(conformanceReport(await conform(myDriver, { url: "…" })));
```

It answers with a line per promise, says which it did not check and why, and
does not grade your backend any more gently than the ones that ship.

## Running it

```sh
praecise dev                 # dashboard, chat, REST, MCP, traces — reloads on save
praecise run support "where is order 4021?"
praecise run handle message="I want a refund"
praecise list
praecise doctor              # everything wrong with this app, in one pass
praecise ingest ./docs --store catalogue
```

`doctor` is the first thing to run when something is not working. It reports what
will stop the app, then what merely degrades it, then what is only worth knowing,
and exits non-zero only on the first kind — so CI can gate on it.

`run` also reads stdin, and takes `--json`.

While `dev` is up:

| | |
|---|---|
| `GET /` | dashboard |
| `GET /<agent>` | chat UI |
| `GET /w/<workflow>` | run form and history |
| `POST /api/agents/<name>` | `{ input, thread? }` |
| `POST /api/workflows/<name>` | the workflow's inputs |
| `POST /api/runs/<id>` | `{ approved, approver?, signature?, note? }` |
| `POST /mcp` | every agent and workflow, as MCP tools |
| `POST /a2a` | the same app as an agent a peer delegates to |
| `GET /.well-known/agent-card.json` | what a peer needs to know first |
| `GET /ask` | a natural-language question, answered from this app's own store |
| `GET /llms.txt` | a map of this app, for a model that arrived knowing nothing |
| `GET /ai.json` | the same, as JSON-LD |
| `GET /traces` | what the last few requests actually did |

That MCP line means anything that speaks it — a chat app, an IDE, another agent —
can use this app without knowing it is one. The rest is the same idea for the other
three kinds of caller: a peer agent (A2A), a person's front end (AG-UI, below), and
a machine that arrived at the URL knowing nothing (`llms.txt`).

### Streaming

Any agent endpoint streams when you ask for `text/event-stream`. praecise's own
event shape is the default; `?protocol=ag-ui` switches to AG-UI, which anything
built to render agents already understands, and `?stream=` narrows what you get:

```sh
curl -N -H "Accept: text/event-stream" \
  "$URL/api/agents/support?protocol=ag-ui&stream=messages,tools" \
  -d '{"input":"where is order 4021?"}'
```

`messages` is the agent's words, `tools` what it reached for, `updates` how the
answer was routed, `custom` your own notes, `values` lifecycle only. They combine.

### Seeing what happened

`praecise dev` collects OpenTelemetry GenAI spans in memory and renders them at
`/traces` — a timeline per request, with how long each call took, tokens in and
out, which model, and which failed. In production you pass your own `tracer` and
the spans go to whatever you already run; praecise adds no OpenTelemetry
dependency, because the convention is in the data and the transport is yours.

Every one of these needs the bearer token the server prints on startup. Pass it as
`Authorization: Bearer <token>`.

## What you are trusting

A framework does not get to assume where it will run, so here is what this one assumes
and what it does not.

**The dev server authenticates.** It mints a token on startup and prints it; every
`/api/*` and `/mcp` request needs it. It binds loopback by default, and it **refuses to
start** on an address the network can see unless you have configured authentication —
a refusal rather than a warning, because that misconfiguration is the one that turns
every other risk into a remote one. Mutating requests are checked against an origin
allowlist and a `Host` allowlist, and must be `application/json`, so a page you happen
to be visiting cannot drive it and a rebound DNS name cannot read it.

**Approvals are attributed; they are non-repudiable only if you make them so.** With no
signer wired, an approval records who claimed it and is marked `unsigned` — the
framework will not synthesise a signature, because a fake one is a lie the audit trail
carries forever. Wire `approvals.sign` and `approvals.verify` and the picture changes:
a signature that does not verify is refused rather than stored, and a quorum counts the
**subjects your verifier proved**, never the names a caller typed. A gate that requires
two people refuses to start without a verifier, rather than accepting one person twice.

**Agents are not sandboxed from the control plane.** `guard.ts` is the boundary for what
a tool may do, and it sees which channel a call arrived on. A `plan` step gives a model
no tools unless you name them.

**Everything is persisted in plaintext.** Prompts, inputs, outputs and conversations go
to `<root>/.praecise/`, owner-only (`0700`/`0600`), with no encryption at rest and no
retention policy. Credentials quoted by an exception are redacted before anything is
written. If you process personal data, this directory is your record and `app.redact()`
is your erasure mechanism.

**Limits are enforced, not declared.** A budget counts planning and judging, not just
the obvious calls; concurrency is bounded across the whole run rather than per step, so
nesting cannot multiply it; and every model call has a timeout.

## Config

Optional. A project needs none.

```ts
// praecise.config.ts
import { defineConfig } from "praecise";

export default defineConfig({
  name: "Acme Support",
  quality: "balanced",
  port: 3000,
});
```

## Handing it to someone else

An app is finished when someone else can run it. `praecise package` writes a
directory that installs and starts like anything else on npm:

    praecise package ./dist
    cd dist && npm install && npx my-app

What comes out is your own files, a launcher, and `mcp.json` — the tool surface,
written down. Nothing is bundled or compiled, because the folder already is the
app. Keeping the surface in a file means a rename shows up as a diff someone can
review rather than as a break a caller discovers at run time.

It also comes out importable, for a caller that would rather write code than
read a list of tools:

```ts
import app from "my-app";

const answer = await app.support({ input: "where is order 4021?" });
```

That is the same app under the same rules — `api.d.ts` is a line per tool where
`mcp.json` is a schema per tool, which matters when the reader is a model paying
for every one of them.

The same folder also runs in place. `praecise mcp` serves it on stdin and stdout
for a client that launches it as a subprocess, and `praecise dev` serves it over
HTTP for a browser and for anything already speaking the protocol.

## Deciding what leaves the building

Anything published can say who may reach it and what calling it does:

```ts
export default agent({
  role: "Review the ledger and flag anything unusual.",
  description: "Audits transactions for a named account.",
  access: "gated",   // open (default) · gated · internal
  effect: "read",    // read · write (default) · destructive
});
```

`internal` is the useful one. The agent still exists and your other agents still
use it, it simply never leaves — it is absent from the published list and cannot
be called even by a caller who knows the name, because refusing is not the same
as admitting it is there.

This is worth doing for a reason beyond privacy. A caller shown twenty tools
starts acting where it should have declined, so the smallest honest surface is
also the most accurate one. `effect` feeds the same judgement: it tells a caller
what a call would cost before it makes it, and an undeclared tool is assumed to
change something.

Both `mcp` and `package` will narrow further on request, and packaging says so
when the surface has grown past what a caller can weigh:

```sh
praecise mcp --groups workflows       # one part of the app, not all of it
praecise package ./dist --read-only   # only what changes nothing
```

The same two narrow the dev server: `POST /mcp?groups=workflows&read`.

Nothing published can be undescribed. `praecise package` refuses an app whose
tools say only their own name back, because a caller reads the description and
nothing else before deciding — describe it, or mark it `internal` if it was
never meant to leave.

### Deciding call by call

`access` and `effect` settle what an agent may reach for. What it may do with a
particular call is a different question, and a `guard.ts` at the root answers it:

```ts
import { guard } from "praecise";

export default guard(({ tool, args }) => {
  if (tool === "refund" && Number(args.amount) > 500) {
    return "A refund over 500 needs a person to approve it.";
  }
});
```

Say nothing and the call goes ahead. Say a sentence and it does not — and the
sentence goes back to the model as that tool's own result.

That last part is the point. A model told a refund needs approval can say so to
the customer and offer to raise it; a model handed an exception can only stop,
and the run ends somewhere nobody chose. So write the reason for the model to
read, because it will read it. A guard that throws is treated as a refusal too,
for the same reason: the app was asked and did not manage to say yes.

A refusal is not counted against the model that asked for it. It says nothing
about whether that model was good enough — a stronger one would have been
refused in the same place.

## Underneath

The runtime is part of the package and has no dependencies of its own — nothing
to install alongside it, nothing to configure. It takes each question to the
cheapest model that can answer it and climbs only when that one is not confident
enough, which is why `quality` is the only dial you are given.

## Bring your own, or bring one key

The framework is open source and complete on its own. Point it at your own model
endpoints, your own database, your own object storage, and it runs entirely on
things you operate — the only cost is that you describe each one and hold its
credentials.

Praecise Cloud is the managed side of the same app. One key, and the models
behind the ladder, the database, and object storage are all provisioned for you
and reachable through the same code you already wrote. Nothing in the app
changes; the config gets shorter.

## The API

Every name exported from `praecise` is listed in [API.md](API.md), grouped by
the task it belongs to. From 1.0 that list is what semantic versioning covers.

The framework's own moving parts — the project loader, the planner, the provider
wire formats, the packager, the CLI entry point — live at `praecise/internal`,
which is deliberately **not** covered: names there may change or disappear in any
release, patch releases included. Nothing was deleted to draw that line; it
moved, so that needing one of those names never means forking the framework.
Changes to either surface are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

Apache-2.0
