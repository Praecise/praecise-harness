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
    },
  },
});
```

The first endpoint whose credential is present is the one that runs, and a
declared endpoint always beats the cloud. Naming a single model is fine — every
rung then runs on it. The framework knows no endpoint but Praecise Cloud by
name: a base URL and a model id belong to the app that chose them.

## The folder

Nothing here is required except the one folder you actually use.

```
agents/          one file per agent
workflows/       one file per workflow
memory/          .md and .txt every agent can answer from
functions/       your own code, callable by an agent
tools/           MCP services the app may act through
stores/          somewhere to keep things
praecise.config.ts
.env
```

A file's name is its name: `agents/support.ts` is the agent `support`, served at
`/support`. No registry, no imports between files, no config to keep in sync.

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

Two backends ship: a file, and a server spoken to over its own wire protocol.
Neither costs a dependency. Anything else is a `Driver` your app hands over,
matched to a store by the scheme of its url:

```ts
const app = await App.load({ drivers: [myDriver] });
```

A driver implements named operations — keep these, list that window, match these
terms, drop this scope — not a SQL string. Everything above it is written once
and every backend gets it, and there is no query language between a model and
your data for either of them to get wrong.

## Running it

```sh
praecise dev                 # dashboard, chat, REST, MCP — reloads on save
praecise run support "where is order 4021?"
praecise run handle message="I want a refund"
praecise list
```

`run` also reads stdin, and takes `--json`.

While `dev` is up:

| | |
|---|---|
| `GET /` | dashboard |
| `GET /<agent>` | chat UI |
| `GET /w/<workflow>` | run form and history |
| `POST /api/agents/<name>` | `{ input, thread? }` |
| `POST /api/workflows/<name>` | the workflow's inputs |
| `POST /api/runs/<id>` | `{ approved, note? }` |
| `POST /mcp` | every agent and workflow, as MCP tools |

That last one means anything that speaks MCP — a chat app, an IDE, another agent —
can use this app without knowing it is one.

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

## License

Apache-2.0
