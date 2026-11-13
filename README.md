# praecise-harness

The framework for AI agents. A folder is an app.

> Praecise names two things that work at different levels. **This is
> praecise-harness**: it runs agents — models, escalation, grounding, memory,
> resumable workflows. [praecise-engine](https://github.com/Praecise/praecise-engine)
> is the acceleration layer underneath a model: speculative decoding, batching,
> backend tuning. One makes an agent work; the other makes a model faster, and
> neither needs the other to be useful. The `@praecise` npm scope is shared on
> purpose — it is the family, not either product.

> This package was previously published as `praecise`. That package name is
> deprecated: install `@praecise/harness`. The command is still `praecise`.

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
import { agent } from "@praecise/harness";

export default agent({
  role: "Customer support for Acme.",
  tools: ["refund"],
});
```

```sh
npx @praecise/harness dev
```

```
→ http://localhost:3000/support
  chat UI · REST · MCP endpoint
```

## Install

Node 22 or newer.

```sh
npm i @praecise/harness
```

Or start a new app from scratch:

```sh
npx @praecise/harness init my-app
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

An endpoint with needs of its own says so in the same three lines rather than in
a patched copy of the framework:

```ts
house: {
  url: "https://models.internal",
  credential: "HOUSE_KEY",
  credentialHeader: "x-house-key",
  headers: { "x-region": "eu" },
  body: { chat_template_kwargs: { enable_thinking: false } },
},
```

`credentialHeader` is for an endpoint that refuses `Authorization: Bearer` and
wants its own key header; the credential still comes from `credential`, so
nothing in your app has to read the secret in order to place it. `headers` are
sent with every request and applied last, so one of them beats anything else the
wire would send. `body` is for fields the endpoint's runtime names and the
protocol does not — merged underneath the request, so what was actually asked for
wins and `model` and the conversation can never be replaced from a config file.

An endpoint that serves one request at a time refuses everything queued behind
the one in flight, and crossing to a dearer model on that is paying more
precisely because the cheap one was busy. `limits: { retries: 4, retryDelay: 2000 }`
says how many times to ask the same endpoint again and how long to wait before the
first of them; the wait doubles, with jitter, and the defaults are 2 and 200 ms. An
endpoint that says how long to wait (`retry-after`) is waited on for that long, up
to thirty seconds.

Four more fields describe what an endpoint can do, and all are optional:

```ts
house: {
  url: "https://models.internal",
  credential: "HOUSE_KEY",
  speaks: "responses",
  thinking: "effort",
  levels: ["low", "medium", "high", "xhigh"],
  output: 32_000,
  embeds: "…",
  cache: false,
},
```

`levels` are the words the endpoint takes for depth, shallowest first; the default
is `low`, `medium`, `high`, and an endpoint with a level above `high` names it here.
`output` is the most tokens one reply may take. `embeds` is the model the endpoint
turns text into vectors with (see [Stores](#stores)). `cache: false` stops the
`messages` wire marking the instructions and the conversation for the endpoint to
keep between requests, for a gateway that refuses the marker.

An endpoint that says what it charges has its answers priced. `prices` is per
million tokens, per rung, in a currency the endpoint names:

```ts
house: {
  url: "https://models.internal",
  credential: "HOUSE_KEY",
  fast: "…", best: "…",
  prices: {
    currency: "USD",
    fast: { input: 1, output: 5 },
    best: { input: 5, output: 25, cachedRead: 0.5, cacheWrite: 6 },
  },
},
```

`answer.usage.cost` is then the cost by currency (`{ USD: 0.0095 }`), and a span
carries it as `praecise.usage.cost` and `praecise.usage.cost.currency`. Where
only some of the models that answered declared a price, `usage.unpricedTokens`
says how many tokens the figure leaves out. The framework ships no price list:
an endpoint with no `prices` is not priced at all.

## The folder

Nothing here is required except the one folder you actually use.

```
agents/          one file per agent
workflows/       one file per workflow
memory/          .md and .txt every agent can answer from
functions/       your own code, callable by an agent
tools/           MCP services the app may act through
skills/          how to do a kind of work, read when it applies
evals/           what a right answer looks like, checked on demand
stores/          somewhere to keep things
guard.ts         which tool calls the app actually makes
hooks.ts         what happens after a tool runs and before an agent stops
praecise.config.ts
.env
```

A file's name is its name: `agents/support.ts` is the agent `support`, served at
`/support`. Nothing to register, no imports between files, no config to keep in sync.

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
import { createApp, agent, fn, guard } from "@praecise/harness";

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

### Changing agents while the app runs

A running app can take a new agent, a new version of one, or lose one:

```ts
await app.add(agent({ name: "billing", role: "Answer billing questions." }));
await app.replace(agent({ name: "support", role: "Customer support for Acme.", tools: ["lookup"] }));
await app.remove("billing");
```

The agent is checked and planned as it would be at load. Requests already under
way finish on the plan they started with; the next request for that name gets the
new one. MCP clients are not sent a list-changed notification.

### Testing without a model

`@praecise/harness/testing` is a model that says what a test tells it to:

```ts
import { createApp } from "@praecise/harness";
import { scriptedModel } from "@praecise/harness/testing";

const model = scriptedModel([
  { tool: { name: "lookup", args: { order: "9" } } },
  "It shipped.",
]);

const app = await createApp({ config: { models: model.models }, agents, functions });
const answer = await app.ask("support", "where is order 9?");

model.requests; // every request the app made, in order
```

Each entry is one reply: text, a tool call, or a function of the request.
`scriptedEndpoint` does the same one level down, as a `fetch` that answers with
the bodies it is given, and `systemText` reads the instructions out of a request.

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
import { mergeApps, createApp } from "@praecise/harness";
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
import { agent } from "@praecise/harness";

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

When the documents do not fit in the agent's instructions, none of them are
dropped. The instructions carry an outline of every document — its name, its
size and its headings — along with the documents that still fit whole, and the
agent gets one `read_knowledge` tool to read a document, or a single section of
it by heading. The tool offers only the names that exist, and an unknown name or
heading is answered with the ones that do. A folder that fits is composed as it
always was and gets no tool. If the outline itself cannot fit, the documents it
leaves out are named in the app's problems.

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

`returns` takes three forms. Fields and hints, as above, constrain the structure
and leave each value as text. A JSON Schema object asks for typed data. A
[Standard Schema](https://standardschema.dev) validator, which is what most
validation libraries hand over, also types `answer.data`:

```ts
const triage = agent({
  role: "Sort an incoming support message.",
  returns: Ticket, // any Standard Schema validator
  read: (ticket) => (ticket.urgency === "high" && !ticket.summary ? "A high-urgency ticket needs a summary." : undefined),
});

const answer = await app.ask(triage, "My order never arrived.");
answer.data.category; // typed by the schema
```

A JSON Schema or a Standard Schema is sent to the endpoint for constrained
decoding where it has that, and the answer is checked against it either way.
`read` is a check of your own on the result: say nothing to accept it, or a
sentence to refuse it. An answer that fails either is asked for again with more
depth, then from a stronger model, and after the strongest the request ends in a
`ShapeError` carrying `issues` and the `text` that failed. The JSON Schema
keywords that are checked are listed in `CHECKED_KEYWORDS`; a schema that uses
one that is not (`UNCHECKED_KEYWORDS`: `$ref`, `allOf`, `pattern`, `format` and
others) is reported in the app's problems.

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

### Bounding one request

A caller can narrow the ladder for a single request, never widen it:

```ts
// economise: this request may not reach the strongest rung
await app.ask("support", question, { ceiling: "balanced" });

// the cheap answer was rejected: re-ask without starting on that model again
await app.ask("support", question, { floor: "balanced" });
```

`ceiling` is the most expensive rung the request may reach. It trims the agent's
declared ladder rather than picking one rung, so the router still escalates below it.
`floor` is the cheapest rung it may start on. Lifting a ceiling does not move a
request up, because the router still enters cheapest-first; a floor is how a caller
that already rejected the cheap model's answer says not to ask it again.

Both can only remove rungs the agent declared, never add one, so neither can reach a
model its author did not put on that agent. With both set the floor is clamped to
the ceiling: a floor above the ceiling gets the ceiling, never an empty ladder.

A caller can narrow what the agent may use the same way:

```ts
await app.ask("desk", question, {
  allow: { tools: ["lookup"], knows: ["pricing"] },
  maxCalls: 12,
});
```

`allow.tools` lists what the agent may still call and `allow.knows` what stays in
its instructions. Both only take away. Anything else the agent was given is not
offered and is refused if it is called anyway, through tool search, through code
mode, or by an agent this one asks, which is held to the same lists. A name the
agent does not have is an error. A live session is not narrowed.

`maxCalls` is the most model calls the request may make, counting tool turns,
samples, climbs, summaries and the calls of any agent asked on the way. Reaching
it ends the request with `CallLimitReached`. `limits.calls` in the config is the
default for requests that do not say.

### Who a request is for

```ts
await app.ask("support", question, {
  caller: { person: "u_1", plan: "pro" },
  context: { tenant },
});
```

`caller` is who the request is for, as the app vouches for them, and `context` is
anything else the app wants to travel with it. Both reach the guard and the
authority on every tool call (`attempt.caller`, `attempt.context`), the second
argument of every function called, the meter, and any agent this one asks,
in the background or not. Neither is sent to a model, a trace or a recording.
`startWorkflow`, `resumeWorkflow` and `callTool` take the same two.

### Sending more than text

A question can carry anything that has a media type: a picture, a recording, a film,
a PDF, a sensor log, a robot's joint state, a table, a scene.

```ts
await app.ask("support", "What does this invoice say is due?", {
  attachments: [{ mime: "application/pdf", url: "https://files.example.com/invoice.pdf" }],
});
```

An attachment is a media type and either the bytes (`data`, base64) or a `url` the
endpoint can fetch. Over HTTP it is `attachments` on the request body, up to ten,
and a `url` must be `https:` or `data:`. An attachment belongs to the request it
came with: a named conversation keeps what was said, not what was shown.

What the model is shown follows one rule, the same on every wire:

1. **The endpoint reads it.** Images and PDFs on `messages` and `responses`; images
   on `chat`; images, audio, video and PDFs on `contents` and `interactions`. A
   `chat` server that takes audio or video says so with `takes: ["image", "audio",
   "video"]` on the endpoint. These are sent as they are, in the shape the wire has
   for them.
2. **A reader renders it.** Data no model reads is shown as a faithful rendering,
   placed after the question:

   | Media type | What the model is shown |
   | --- | --- |
   | `application/senml+json` (RFC 8428 sensor measurements) | each channel as a series: count, span, min, max, mean, deviation, and 24 evenly spaced values |
   | JSON tensors in the Open Inference Protocol form (`{ name, shape, datatype, data }`): robot state, action chunks, latents | each tensor's name, shape, type, range and first values |
   | `text/csv`, `text/tab-separated-values` | columns with their statistics, and the first and last rows; a short table whole |
   | `model/gltf+json` | what the scene contains, counted and named |
   | `text/*`, JSON, XML, YAML | the text, cut to fit |

3. **Neither.** It is left out, and `answer.notes` says which attachment and why.

The data is never rewritten: a tool or a store handed the same attachment gets every
sample. Teach the framework another kind of data with a reader:

```ts
import { registerReader } from "@praecise/harness";

registerReader("a robot log", "application/vnd.mcap", (attachment) => summarise(attachment));
```

A function returns something other than text with `attach`, and an MCP tool that
returns an image, audio or a file has it handed to the model the same way rather
than spelled out as base64:

```ts
import { attach, fn } from "@praecise/harness";

export default fn({
  description: "Take a picture with the front camera.",
  effect: "read",
  run: async () => attach("Frame 12.", { mime: "image/jpeg", data: await frame() }),
});
```

What a model makes that is not text (an image from `contents` or `interactions`,
speech from `chat`) comes back on `answer.attachments`. Asking an endpoint for it is
the endpoint's own field, set through `body` in `models`.

**A film an endpoint cannot watch** is taken apart by a decoder the app registers.
One ships, over an `ffmpeg` binary the app points to:

```ts
import { ffmpegDecoder, registerDecoder } from "@praecise/harness";

registerDecoder("ffmpeg", "video/", ffmpegDecoder({ bin: "/usr/bin/ffmpeg", every: 2, frames: 16 }));
```

The stills are sent as images. The sound is sent as audio where the endpoint takes
it, transcribed by the cheapest rung that does where it does not, and otherwise
left out with a note.

**A large attachment is uploaded once.** Past a size, an attachment is sent
through the endpoint's files API and named from then on instead of being sent
inside every request: past 5 MB on `messages`, 20 MB on `responses`, `contents`
and `interactions`, and not at all on `chat` unless the endpoint says
`uploads: true`. `uploads: { over, keep }` sets the size in bytes and how long
the endpoint is asked to hold the file; `uploads: false` turns it off. What was
uploaded is remembered for the life of the process. An upload that fails is sent
inside the request, with a note.

**Large media can be kept by address.** `app.blobs` holds bytes under the SHA-256
of what they are, on disk under `.praecise/blobs` unless the app brings a store:

```ts
import { detach, sweepBlobs } from "@praecise/harness";

const light = await detach(app.blobs, attachment); // { mime, blob: "sha256:…" }
await sweepBlobs(app.blobs, live);                  // remove what `live` does not name
```

An attachment carried as `blob` costs its address wherever it is written down,
and its bytes are put back before a model or a reader is shown it. Bytes are
hashed again when read. Nothing is removed until `sweepBlobs` is run. An HTTP
caller cannot send a `blob`.

**More formats, as a plugin.** `@praecise/harness/formats` adds readers for
robotics, scene and array data:

```ts
import { defineConfig } from "@praecise/harness";
import { formats } from "@praecise/harness/formats";

export default defineConfig({ plugins: [formats()] });
```

It reads MCAP, ROS 1 bags, LeRobot dataset metadata, Parquet footers, Arrow IPC
schemas, PCD and PLY point clouds, Gaussian splats (PLY and `.splat`), USD
(`.usda` in full; `.usdc` and `.usdz` described) and `.npy`/`.npz` arrays, and
identifies a ROS 2 `.db3` bag. Each rendering ends by saying what was not read.
`formats({ only })` and `formats({ except })` choose among them, and
`registerFormats()` registers them without a plugin. MCAP chunks compressed with
zstd need Node 22.15 or newer.

### Work that takes a while

An agent may go to its tools sixteen times in one request before it has to answer;
`turns` on the agent changes that. What keeps long work inside the endpoint's
context is not the count:

- A tool result too long to hand over is kept whole for the length of the request.
  The agent sees the start and the end of it and a name, and reads the rest with
  `read_result`, by line or by search.
- When the record of the work passes half the endpoint's `room`, older tool results
  are replaced by a line saying they were cleared and can be asked for again. The
  calls themselves stay.
- If that is not enough, the model is asked once for notes on the earlier work, and
  those notes replace it. The question itself is never rewritten.

Each of these is reported in `answer.notes`. Calls in one turn that only read
(`effect: "read"`) run together; anything else runs in the order the model asked.

### Many questions at once

`askMany` hands many questions for one agent to the endpoint's batch API:

```ts
const results = await app.askMany("triage", messages);

for (const { answer, error } of results) {
  // one entry per question, in the order asked
}
```

Each entry is an answer or the error that question ended in. An agent's tools run
between batches. Batching ships for the `messages`, `responses`, `chat` and
`contents` shapes; on `interactions`, or on an endpoint that says
`batch: false`, the requests are sent one at a time. `poll`, `within`, `linger`,
`signal` and `onBatch` are the options, and `registerBatch` teaches the framework
the batch API of a shape of your own.

### A live session

A conversation over one connection, for voice and anything else that is not a
request and a reply. The endpoint says where sessions run:

```ts
house: { url: "https://models.example", credential: "HOUSE_KEY", speaks: "responses", realtime: { model: "…" } },
```

```ts
const session = await app.open("desk", { output: "audio" });

session.send({ text: "Where is order 4021?" });

for await (const event of session) {
  if (event.kind === "audio") play(event.data);
  if (event.kind === "turn" && event.state === "ended") break;
}

await session.close();
```

`send` takes `text`, `audio` or `attachments`; `interrupt()` stops the agent
speaking. Events are `text`, `audio`, `transcript`, `speech`, `turn`, `tool`,
`tool result`, `refused`, `usage`, `note`, `error` and `closed`. The agent's
tools are called through the same guard and authority as in a request.

Sessions run over WebSocket. Protocols ship for the `responses`, `chat`,
`contents` and `interactions` shapes, not for `messages`; `registerSession` adds
one. A session has no failover: a connection that drops is closed, not reopened
on another endpoint. A named conversation's history, recall and selves are not
carried into a session, and images are the only media that can be sent beside
audio and text.

### One agent asking another

Name an agent in another agent's `tools` and it becomes a tool:

```ts
// agents/lead.ts
export default agent({
  role: "Answer questions about an account.",
  tools: ["researcher", "refund"],
});
```

The agent asked starts from its own role and tools and sees nothing of the
conversation that led to it, so the task it is given has to stand on its own. Only
its answer comes back; the results it read along the way never enter the asking
agent's context. Its tokens are counted in the asking request's `usage`, the call
goes through `guard.ts` like any other, and what it read marks the answer
`tainted` the same way. A request may go three agents deep (`limits.depth`); past
that the model is told why not.

A name in `tools` is a function if `functions/` has it, a service if `tools/` has
it, and an agent otherwise.

With `background: true` the asking agent may start another agent and carry on:

```ts
export default agent({
  role: "Answer questions about an account.",
  tools: ["researcher"],
  background: true,
});
```

Calling `researcher` with `background: true` returns a handle at once. The agent
then has `check_agent`, `steer_agent`, `cancel_agent` and `collect_agent` to see
how the other is getting on, tell it something more, stop it, and take its
answer. Four may be working at once in one request, and any still working when
the request answers are stopped.

### Advice from a stronger model

```ts
export default agent({
  role: "Triage incoming tickets.",
  quality: "best",
  tools: ["lookup"],
  advisor: true,
});
```

With `advisor: true` the agent gets a `consult` tool. Calling it sends the
agent's instructions and the work so far to the strongest model on its ladder, which
says what it would do next in at most about two thousand tokens and does none of the
work. The cheaper model carries on. It is not offered while the strongest model is
itself answering.

### An agent that remembers who it is

An agent starts every request from its role, its rules and its tools. A **self**
is what persists around it: an identity, what it has learned, what it has been
reading, and what came of its earlier work. An agent declares the self it is,
and the harness does the rest on every request, however the agent is reached:

```ts
export default agent({
  role: "Find the pieces in the catalogue that carry an idea.",
  tools: ["search-products"],
  self: "design",
});
```

Before the request, the self's context is read and placed after everything
stable in the system prompt, as the self's own notes. After it, what was asked
and answered is recorded against a ticket, so that what comes of the answer later
reaches exactly what the self drew on.

Where selves live is the app's choice, in `praecise.config.ts`:

```ts
export default defineConfig({
  selves: { url: "https://selves.example.com", credential: "SELVES_KEY" },
});
```

`url` may also come from `SELVES_URL`. The provider speaks a small protocol:

| | |
|---|---|
| `POST {url}/selves/{handle}/context` | `{surface, task, interactive}` → `{preamble, ticket, lessons}` |
| `POST {url}/tickets/{ticket}/work` | `{brief}` |
| `POST {url}/tickets/{ticket}/outcome` | `{signal: -1..1, label, detail?, by?}` |
| `PUT {url}/selves/{handle}` | create a self from the agent's `template`, with `adminCredential` (default `SELVES_ADMIN_KEY`) |

Or bring your own provider in code: `App.load({ selves: myProvider })` with
anything that implements `SelfProvider`.

**A self per person.** A handle with `{person}` is a self for each person the
app serves, created from a template the first time they ask:

```ts
self: {
  handle: "coach-{person}",
  template: { name: "Coach", charter: { purpose: "Remember what works for this person." } },
},
```

The person is the one the caller names (`caller.person` in `ask`, `person` on the
HTTP body, `_meta["com.praecise/person"]` on an MCP `tools/call`), vouched for by
whoever holds the app's token. A caller can name where it is asking in the same way
(`surface`, or `_meta["com.praecise/surface"]`), which picks the self's persona for
that surface. It is reduced to a digest before it becomes part of
a handle.

**Rating an answer.** Every answer from a self carries `answer.self`: the handle,
what it drew on, and a ticket. Set `SELVES_TICKET_SECRET` (or `ticketCredential`)
and the ticket is bound to the person it was issued to, which makes it safe to
send to their browser. A rating comes back through `app.rate(ticket, verdict,
person)` or `POST /api/selves/outcome`, optionally with a `check`: something the app
measured about what came of the answer (`{ name, passed, failures }`). A rating is
credit; a failed check is what a self learns from; a ticket issued to somebody else reads
exactly like one that has expired. The ticket also arrives early, as a `self`
progress event, and in `_meta["com.praecise/self"]` on an MCP result.

**One memory.** A self already remembers, so an agent that is a self cannot also
declare `memory`: two records of the same life would disagree.

**What a self is sent.** After an answer, the provider is sent what was asked,
what was answered and which tools were used. An agent and an app each have a say
over that:

```ts
self: {
  handle: "coach-{person}",
  record: (work) => ({ ...work, answer: redact(work.answer) }),
},
```

`record` returns what is sent instead; returning nothing sends nothing. The
app's `beforeRecord` hook in `hooks.ts` is asked after it, with what it left, and
answers the same way. One that throws sends nothing.

**Memory, not a dependency.** If the provider cannot be reached, the agent answers
as it would have without its self and says so in a note. `selves: { required:
true }` makes that an error instead.

## Workflows

Steps run in order. Any `{{name}}` is replaced before the step runs, and can
reference an input or an earlier step.

```ts
import { workflow } from "@praecise/harness";

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

Eight kinds of step:

| | |
|---|---|
| `ask` | delegate to an agent |
| `use` | call a service, e.g. `use: "ledger.create_invoice"` |
| `approve` | stop and wait for a human |
| `wait` | stop and wait for an event from outside |
| `each` | run steps once per item, optionally in parallel |
| `when` | branch on a value |
| `repeat` | run steps until a check holds, with a required `max` |
| `plan` | let a model lay out the remaining work, then run it as a graph |

An `approve` step writes the run to disk and returns. It survives a restart, and
resuming replays the recorded outputs rather than re-running the steps before
it — the model is not called twice for work already done.

A `wait` step stops the same way, for an event instead of a person:

```ts
{ id: "paid", wait: "com.acme.payment.received", subject: "{{order}}", timeout: 86400, onTimeout: "continue" }
```

`wait` is the CloudEvent `type` awaited. `source` and `subject` narrow it, which
is how a run waits for its own event and not the next one of that type. The
event that matches continues the run, once, and is the step's output: `type`,
`source`, `id`, `subject`, `time`, `data` and `timedOut`. It arrives through
`app.signal(event)`, `app.deliver(workflow, event)`, `app.publish(event)` or the
[event routes](#events). An event that arrives while nothing waits for it is not
kept. `timeout` is in seconds; running out fails the run, or with
`onTimeout: "continue"` carries on with `{ timedOut: true }`. A timeout fires
only while a process holds the app, or when `app.expire()` is called: nothing
wakes a run whose app is not running. A run waits for one event at a time.

A string that is *only* a reference keeps its type, so `with: "{{draft}}"` hands
a tool an object rather than `[object Object]`.

Any step may carry `after: ["id", ...]`. One `after` anywhere turns the list into a
graph: steps run as soon as what they wait for is done, so independent work goes in
parallel instead of in the order it happened to be written. Without any `after`, the
steps run in order, which is what a short workflow wants.

Two things about `after` that are easy to read the wrong way, because both are about
where a step SITS rather than what it says:

A step inside `each`, `when` or `repeat` may wait for a step outside it, and usually
means to. If the block it sits in already waits for that step, the dependency is
satisfied before the block begins — naming it again is redundant rather than wrong,
and nothing is lost. What is reported is the other case: a wait on something nobody
waits for, where the two really could run in either order.

A `repeat` condition may name the steps inside its own body. `until: "{{panel.passed}}"`
over a body containing `panel` is the ordinary way to write "go round again until the
panel agrees", and it works because the condition is evaluated after the body has run.

`max` is required on `repeat` because an unbounded loop is a bug, so there is no way
to write one. And a `plan` is produced once rather than on every step — deciding what
to do next is itself a model call, and paying for it repeatedly is what makes agentic
loops expensive. The plan is recorded as a version rather than overwritten, so a
resume runs the graph that was agreed rather than inventing a fresh one.

## When a run stops badly

A workflow that waits for a human is the easy case. The hard cases are a process
that died and a decision that turned out to be wrong, and they need different
answers.

```ts
import { resumeRun, recoverRun, forkRun } from "@praecise/harness";

// a human answered the gate — the decision is the argument, not a flag
await resumeRun(runId, { approved: true, approver: "ada", channel: "cli" }, spec, deps);

// the process driving the run died; re-drive it from the journal
await recoverRun(runId, spec, deps);

// ask what would have happened if an earlier step had decided differently
await forkRun(runId, spec, deps, { after: "sorted", patch: { sorted: { category: "refund" } } });
```

**`resumeRun`** answers a gate. It refuses a run still marked `running`, because
something may still be driving it.

**`recoverRun`** exists for exactly that refusal. A crash leaves a `running` status
behind with nobody driving, and the journal is the only way back. Calling it asserts
the driver is dead — the store records state, not processes, so that assertion is
yours to make. Completed steps are replayed from the journal and never re-executed.

A step interrupted **mid-side-effect** is the case neither can resolve alone. It is
marked inflight, and recovery refuses to repeat it: nothing in the journal can prove
the effect did not already happen, and a charge issued twice is worse than a run that
stopped. Resolve it and clear the entry, or retry under the same idempotency key.

**`forkRun`** is for the counterfactual. It copies the journal up to a point and
nothing past it, so the original stays readable exactly as it happened, beside the
one that might have. `patch` is what makes it worth having: edit an earlier step's
output and watch what follows change — asking what the run would have done if the
classifier had said `refund`, without pretending it did. Every patched value is
recorded as patched.

**Stopping a run** is `app.cancelWorkflow(runId, { reason, by })`, or
`POST /api/runs/<id>/cancel`. A run in flight is interrupted where it stands and
one waiting at a gate or for an event is ended there; either is recorded as
`cancelled`. A function hears it as `signal` in its second argument, and
`startWorkflow(name, input, { signal })` ties a run to a signal of the caller's.
A `passes` check that is running a command is not interrupted, and a run streamed
over AG-UI reports its cancellation as `RUN_ERROR`. There is no CLI command for
it.

**A ceiling in money.** `limits: { spend: { amount: 2, currency: "USD" } }` in the
config stops a run that has spent that much, counted from the `prices` its
endpoints declared. A run that reaches a model with no declared price, or one
priced in another currency, is stopped and told why instead of being counted as
free.

## Tools

Anything that speaks MCP goes in `tools/`, one file per service:

```ts
// tools/ledger.ts
import { tool } from "@praecise/harness";

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

### Code mode

An agent with many tools, or one that chains calls, does better writing a program
than making calls one by one. Turn on `code` and the agent gets a single `code`
tool instead of one per operation: its services appear as a typed API in the
tool's description, the model writes a short program against it, and only the
program's result comes back into context.

```ts
// agents/analyst.ts
export default agent({
  role: "Answers questions that need several systems at once.",
  tools: ["crm", "billing", "acme"],
  code: true,
});
```

The program runs in a [Praecise Silo](https://praecise.com/silo): a microVM with no
network, whose only way out is the agent's services. Each HTTP service is bound into
it; the silo's host makes each call with the credential from `.env`, so the key never
enters the program's world. An MCP server becomes `tools.<service>.<tool>(args)`; an
OpenAPI service becomes `tools.<service>.request({ method, path, query, body })`,
with its document in `spec.<service>` for the program to search — a large API never
has to fit in the prompt. A service launched as a local program cannot be bound and
stays an ordinary tool beside `code`.

`code: true` reaches the silo service named by `code: { silo }`, else by
`PRAECISE_SILO`, else its local socket: a `unix:` path on the same machine, or an
`https://` address reached with the agent token in `PRAECISE_SILO_TOKEN`.
`code: { language: "python" }` asks for Python (`"javascript"` also works); the
default is TypeScript. One silo is kept per agent for its term, `ttl` seconds
(default 1800), and replaced when it expires.

`code: { allow: { acme: ["GET /things/*"], crm: ["find_contact"] } }` narrows what the
program may call, by service: tool names for an MCP server, `"METHOD /path"` patterns
for an OpenAPI service. The silo refuses anything else before it leaves the host and
logs every call, allowed or not.

### More tools than fit in a list

Every tool an agent is shown is read on every request. When an agent's services
publish more than a dozen tools and their definitions pass a tenth of the endpoint's
`room`, they are not listed. The agent gets `find_tools`, which answers a
description of a job with the best-matching tools and their arguments, and
`use_tool`, which calls one by name. A call made through `use_tool` is checked by
`guard.ts` and recorded as a call to the tool it names. Your own functions are
always listed.

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

Where the authorization server supports Client ID Metadata Documents, set
`clientMetadataUrl` to the HTTPS address of a document your app hosts and that
address is used as the client id, with no registration request.
`clientMetadataDocument()` builds the document. Without the option, or on a server
that does not support it, the client registers dynamically as before.

Two grants need nobody at a keyboard, and a service names one in its file:

```ts
// tools/ledger.ts
export default tool({
  url: "https://ledger.example.com/mcp",
  oauth: {
    grant: "client_credentials",
    issuer: "https://auth.example.com",
    clientId: "acme-app",
    secret: "LEDGER_CLIENT_SECRET",
  },
});
```

`client_credentials` is the app acting as itself, with a secret or a private key
(`key`) it signs an assertion with. `grant: "id-jag"` is enterprise-managed
authorization: the identity provider at `idp` is asked, on the strength of the ID
token named by `assertion`, for a grant the server's authorization server
exchanges for a token. `secret`, `key` and `assertion` are names of environment
variables, never the values. `issuer` is required, and the grant is made there or
not at all. A service declared this way has one identity; an app that serves
many people calls `exchangeIdentity` and `redeemGrant` on `OAuthClient` for each
of them. The `id-jag` grant follows a specification that is still a draft.

### What an MCP server may ask of the app

**Something from a person, mid-call.** A server may ask for a value (a form) or
send the person to a page (a URL). The app answers through `mcp.elicit`:

```ts
const app = await App.load({
  root,
  mcp: {
    elicit: {
      form: async ({ service, message, schema }) => ({ action: "accept", content: await askPerson(message, schema) }),
      url: async ({ service, url, host }) => ({ action: "decline" }),
    },
  },
});
```

Each mode is declared to a server only when its handler is there, so a server
never asks for what nothing can answer. The URL is handed to the app and never
fetched. A call may be asked for more input eight times running.

**To be told when its tools change.** `watch: true` on a service keeps a
`subscriptions/listen` stream open and lists the server's tools again when it
says they changed.

**To offer its skills.** `skills: true` on a service, or a list of
`skill://` addresses, offers agents the skills that server serves, read through a
`read_service_skill` tool. Each file is checked against the server's manifest by
SHA-256, marked with where it came from, and treated as that service's output.
Nothing in a skill is executed.

**To show a view.** A tool may bring an interactive page with its result (an MCP
App). With `mcp: { apps: true }` the page is read from the service and handed on
as `answer.ui`, and as an `ACTIVITY_SNAPSHOT` over AG-UI, for a front end to
render in a sandbox of its own. What the page asks for (`tools/call`,
`resources/read`, `ping`) is forwarded to `POST /api/ui/<service>` and goes
through `guard.ts` with `via: "ui"`. The frame, its sandbox and the messages
into it are the front end's.

MCP roots, sampling and logging are not offered: the revision of the protocol
spoken here deprecates all three.

### A screen as a tool

`computer` turns a screen into a function an agent can call, and `browserScreen`
is the screen that ships, a Chromium the app points to:

```ts
// functions/browser.ts
import { browserScreen, computer } from "@praecise/harness";

export default computer(await browserScreen({ executable: "/usr/bin/chromium", url: "https://example.com" }));
```

The agent takes screenshots and clicks, double-clicks, moves, drags, scrolls,
types, presses keys, waits and zooms. The function is `effect: "write"` and its
output is untrusted, so the guard sees every action and what is read from a page
taints what follows. An endpoint that has a computer tool of its own names its
type as `computer` on the endpoint, and on the `messages` shape the tool is sent
as that; everywhere else it is sent as an ordinary function. Any other screen is
an object that implements `Screen`.

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
import { store } from "@praecise/harness";

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

Embeddings are supplied rather than derived, unless an endpoint says what it
embeds with. Name an `embeds` model on an endpoint in `models` and an agent that
remembers into a vector store has each exchange embedded as it is kept and is
recalled by meaning. If the embedding cannot be had, recall falls back to text.
`App.load({ embedder })` takes your own function instead.

Asked with both, a store answers both ways and joins the two orders by
reciprocal rank:

```ts
await history.recall({ text: "order 4021", vector: embedding }, { scope: "acme" });
```

An agent that remembers into a vector store is recalled this way. A reranker
scores what was found a second time, reading the question and each candidate
together: name a `reranks` model on an endpoint (sent to `{url}/rerank`), or pass
`App.load({ reranker: async (query, documents) => scores })`. `{ rerank: false }`
leaves it out of one question.

### Typed records

A store may say what a record in it looks like, with any Standard Schema
validator:

```ts
// stores/tickets.ts
export default store({ of: "document", schema: Ticket });
```

Everything `remember` is given is checked first. A batch with anything wrong in
it is refused whole, with a `SchemaError` whose `issues` name each row, path and
message, and what is kept is what the validator returned. `RecordOf<typeof spec>`
is the record's type. It is a check on the way in and nothing more; values, facts
and series are not checked against it.

### Values, facts and series

Text to recall is one shape of data. A store also keeps three others, on every
backend, with nothing more to declare or install:

```ts
const kept = await app.store("history");

// a value under a name, in a namespace, with an optional lifetime in seconds
await kept.values.put(["users", "ada"], "theme", { dark: true }, { ttl: 3600 });
await kept.values.get(["users", "ada"], "theme");
await kept.values.list(["users", "ada"]);
await kept.values.delete(["users", "ada"], "theme");

// how two things are related, and when that was true
const id = await kept.facts.relate("ada", "works_at", "acme", { validFrom, source: "hr-export", confidence: 0.9 });
await kept.facts.unrelate(id, { at });                       // closed, never deleted
await kept.facts.facts({ subject: "ada", asOf });            // what was true then
await kept.facts.neighbors("ada", { direction: "both", depth: 2 });

// readings in order of time
await kept.series.append("boiler/temp", [{ at, value: 61.5, tags: { unit: "Cel" } }]);
await kept.series.range("boiler/temp", { from, to, bucket: 60_000, aggregate: "mean" });
await kept.series.last("boiler/temp");
```

A value is replaced when written again. A fact said twice is one fact, and one that
stops being true keeps its place in the record: `asOf` answers with what was true
at a moment, and `asOf: "ever"` with everything that was ever believed. A reading
sent twice for the same moment is one reading. None of the three turns up when an
agent recalls something, because each is kept under a scope of its own.

They are verbs over the operations every backend already implements, so a driver
you bring has all of them once it passes `conform`. What that costs is stated: on
a backend that offers nothing more, a walk over facts and an aggregate over a
series read the rows involved and work the answer out in this process. That is the
right trade for what an agent keeps and the wrong one for a warehouse, which is
what `query()` is for.

A backend may do some of it itself, and says which in `capabilities.faster`:
`walk`, `buckets`, `ids`, `validity`. The file and Postgres backends walk facts
with a recursive query and aggregate a series in the database, Postgres using
`time_bucket` where TimescaleDB is found. On PostgreSQL 18 ids are made by the
server (`uuidv7()`), and where `btree_gist` is installed a fact's validity is
held under a key that refuses overlap, so `facts.relate` throws on a fact that
overlaps one already there. `conform` holds each of these to the answer worked
out in this process.

There is no ORM, and that is a decision rather than a gap. A layer mapping tables to
classes buys type safety for code a person writes; an agent's access to data is
safe because of the role its connection holds and because every value is bound, not
because of a type. For a table of your own, `query()` takes the SQL.

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
| `graph` | **not served as an engine** — relationships are kept and walked through `facts` on any store; a graph database is a backend you bring |

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

### Skills it worked out for itself

Remembering a fact is one thing; noticing that a sequence of steps keeps working is
another. An agent can propose a **procedure** from its own traces — a named recipe,
with the traces it was drawn from cited — and those proposals land as candidates.

A candidate is not a skill. It sits in its own file beside the traces, so accepting
one is a deliberate act and rejecting one is a delete. Nothing an agent proposed
about itself takes effect because it proposed it. That floor is the same one notes
use, and it exists because a system that promotes its own guesses accumulates
confident nonsense at exactly the rate it runs.

Accepted skills are rendered into the agent's context alongside its role. What was
learned is legible in a file you can read, edit, or throw away.

### Bringing a backend

Four backends ship: a file, a Postgres server spoken to over its own wire
protocol, Redis or Valkey spoken to the same way, and one that keeps nothing past
the process — `url: "memory:"`, for an example or a test that should leave
nothing behind. None costs a dependency.

```ts
// stores/cache.ts
export default store({ of: "vector", url: "redis://cache:6379/0?prefix=app", dimensions: 1024 });
```

A `redis://`, `rediss://` or `valkey://` url is spoken to in RESP3, falling back
to RESP2. Vector sets, time series and JSON are used where the server has them.
There is no text index, so `search` reads a scope and compares; `sql` and `graph`
are not served; and `query()` takes a command, not SQL.

Anything else is a `Driver` your app hands over, matched to a store by the scheme
of its url:

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
import { conform, conformanceReport } from "@praecise/harness";

console.log(conformanceReport(await conform(myDriver, { url: "…" })));
```

It answers with a line per promise, says which it did not check and why, and
does not grade your backend any more gently than the ones that ship.

## Skills you wrote

A skill is how to do a kind of work, written once and read only when it applies. It
is a folder in the open [Agent Skills](https://agentskills.io/specification) format:

```
skills/
└─ refunds/
   ├─ SKILL.md
   └─ references/policy.md
```

```md
---
name: refunds
description: How to decide and issue a refund. Use when a customer asks for money back.
---

1. Look the order up before anything else.
2. …
```

Each agent's instructions list every skill's name and description. The body is read
through a `read_skill` tool when the agent decides the skill applies, and the other
files in the folder the same way, by path. `skills: ["refunds"]` on an agent narrows
what it sees; `skills: false` gives it none. `allowed-tools` is read and not
enforced.

These are different from the [skills an agent works out for itself](#skills-it-worked-out-for-itself):
those are proposed from its traces and wait for a person to accept them.

### Skills and plugins from a registry

A registry is an index anyone can host, in the Agent Skills discovery format
(`/.well-known/agent-skills/index.json`). An app lists the ones it reads:

```ts
export default defineConfig({ registries: ["https://skills.example"] });
```

```sh
praecise search refunds      # look through the registries for skills and plugins
praecise add refunds --show  # fetch and print a skill without installing it
praecise add refunds         # install it
```

A skill is fetched over `https`, checked against the digest the index gives, and
written to `skills/<name>/` with nothing marked executable. A plugin is not
fetched: it is recorded in `praecise.plugins.json` and the command to install it
is printed. `--kind skill` or `--kind plugin` says which, where a registry lists
both under one name. Nothing is read from a registry unless one of the two
commands is run, and there is no default registry.

An app serves its own skills to MCP clients as well: `skills/list`, `skills/get`
and `skill://<name>/<path>` resources. A skill whose front matter says
`metadata: { access: internal }` is not served.

## Evals

An eval says what a right answer looks like, so a change to a role, a tool or a
model can be checked rather than hoped about:

```ts
// evals/support.ts
import { evaluation } from "@praecise/harness";

export default evaluation({
  agent: "support",
  trials: 3,
  cases: [
    {
      name: "refund over the limit is not promised",
      input: "I want a refund of 900 for order 4021.",
      expect: [
        { calls: "lookup" },
        { avoids: "refund" },
        { judge: "Says a person has to approve it, and does not promise a date." },
      ],
    },
  ],
});
```

```sh
praecise eval                # every suite; exits 1 if a case misses its bar
praecise eval support --trials 5 --json
```

A suite names an `agent` or a `workflow`. Graders are `contains`, `excludes`,
`matches`, `equals` and `fields` (over `returns` data), `calls`, `avoids`,
`judge` (a rubric graded by a model, which may answer "unknown"), `reference`
(the answer says what a recorded one did), and `check` (your own function). A
case may set `budget: { tokens, spend }`. Each case is run `trials` times
and the report gives `pass@k` (at least one trial passed) and `pass^k` (every trial
passed); `bar: "any"` accepts the first, and the default `"all"` requires the
second. Trials do not share a conversation or memory. The same run is
`app.evaluate(suite?, { trials })`.

### Cases from what really happened

With `record: true` in the config, what each agent was asked, what its tools
returned and what it answered is kept under `.praecise/recordings`, with
credentials redacted. `capture` turns those into a suite:

```sh
praecise capture support --last 50      # an agent's recorded exchanges
praecise capture handle --name nightly  # a workflow's runs, written as evals/nightly.ts
```

A captured agent case is replayed: a tool the agent calls is answered from the
recording and never run, so the same input meets the same world every time, and
a call the recording does not hold is answered with an error. The case's grader
is `{ reference: "judge" }`, which compares a structured result field for field
and asks a model whether two texts say the same thing; `--exact` writes
`{ reference: "exact" }`, which fails any difference. A workflow's cases are
captured and compared the same way, but its steps run for real. Replay needs the
built-in runtime. `app.capture(name, { last, mode })` is the same from code, and
`App.load({ recorder })` takes the record somewhere else.

### Scoring live answers

A suite can score a sample of an agent's live answers with its graders:

```ts
export default evaluation({
  agent: "support",
  cases: [],
  online: { sample: 0.1, expect: [{ judge: "Does not promise a refund date." }], threshold: 0.8 },
});
```

Scoring starts after the answer has been returned and can neither delay nor fail
the request. The score is the share of the graders that passed. It goes to the
app's `tracer` as a span named `evaluate <suite>` in the answer's own trace,
carrying a `gen_ai.evaluation.result` event, and below `threshold` it goes to
`notify` as `com.praecise.eval.below`. One answer is scored at a time, and
scores waiting beyond thirty-two are dropped. `app.settled()` waits for
recording and scoring already begun; `app.close()` does too.

## Events

A workflow can be started, or continued, by something that happened elsewhere.

**Pushed.** `POST /api/events/<workflow>` takes a
[CloudEvent](https://cloudevents.io) — structured (`application/cloudevents+json`),
a batch of up to a hundred (`application/cloudevents-batch+json`), or binary
(`ce-id`, `ce-source`, `ce-type`, `ce-specversion` headers with the data as the
body):

```sh
curl -X POST "$URL/api/events/paid" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/cloudevents+json" \
  -d '{"specversion":"1.0","id":"evt-1","source":"/billing","type":"invoice.paid","data":{"invoice":4021}}'
```

The run is named from the event's `source` and `id`, so an event delivered twice,
as anything that retries will do, finds the run the first delivery started. The
workflow receives the event's `data` as `event`, with `type`, `subject` and `time`
beside it. `app.deliver(workflow, event)` is the same from code. A run of that
workflow stopped at a `wait` step the event matches is continued instead, and
only when none is waiting is a run started.

**Published.** A workflow says which event types start it, and anything in the
app can publish one:

```ts
// workflows/fulfil.ts
export default workflow({
  on: "com.acme.order.placed",
  steps: [{ id: "pack", ask: "Pack order {{event.order}}", agent: "warehouse" }],
});
```

```ts
// functions/checkout.ts
export default fn({
  input: { order: "the order id" },
  run: async ({ order }, { publish }) => {
    await publish("com.acme.order.placed", { order });
  },
});
```

`app.publish(event)` and `POST /api/events` do the same with a CloudEvent. Every
workflow that declared the type starts a run, and every run waiting for the
event continues. An event published twice with the same `source` and `id` starts
nothing new, and a step that is retried publishes the same event. The bus is in
this process: types match exactly, with no patterns; a chain of runs publishing
to each other is refused past sixteen deep; and what a publisher read as
untrusted does not mark the runs it starts.

**Pulled.** `app.follow(source, workflow, { signal })` starts a run for every event
a `Source` yields and stores the cursor of the last one handled, so it continues
where it stopped after a restart.

**On time.** A clock is a source:

```ts
import { clock } from "@praecise/harness";

await app.follow(clock("nightly", { cron: "0 2 * * *", zone: "Europe/Lisbon" }), "report", { signal });
await app.follow(clock("poll", { every: 300 }), "sync", { signal });
```

`cron` is five fields, read in `zone` (UTC unless said); `every` is in seconds.
The run receives `scheduled` and `missed`. `catchUp` says what happens to ticks
that fell due while nothing was running: `"latest"` (the default) runs the most
recent and counts the rest in `missed`, `"all"` runs each, `"none"` runs none.
There is no seconds field and no macros such as `@daily`, and nothing follows a
clock unless the app calls `follow`. `cronNext(expression, after, zone)` is the
arithmetic on its own.

**Told.** A run outlives whoever started it, so an app can say what its runs do to
somebody who is not holding a connection open:

```ts
const app = await App.load({
  root,
  notify: { url: "https://ops.example.com/hooks/praecise", secret: process.env.HOOK_SECRET },
});
```

Each run reports `com.praecise.run.started`, `.waiting` (stopped at a gate, with
the step and what is being asked), `.done`, `.failed` and `.cancelled` as
CloudEvents, once per change, except that two processes holding the same run may
each report its cancellation. The event names the run and its status and never carries what the run
produced. A `{ url, secret }` target receives a signed webhook in the
[Standard Webhooks](https://www.standardwebhooks.com) form (`webhook-id`,
`webhook-timestamp`, `webhook-signature`), retried with backoff;
`verifyWebhook(secret, headers, body)` checks one on the receiving side. `notify`
may be a function instead. Delivery happens behind the run and cannot fail it; one
that does not arrive is listed in `app.problems`. `app.onRunChange(listener)`
hears the same changes in this process.

**Described.** `GET /asyncapi.json` is the events the app receives and sends, as
an AsyncAPI 3.1.0 document: the types its workflows start on and wait for, and
the notifications above. `asyncApi(app)` builds it.

## Work that outlives a connection

Three callers can start work here and come back for it later:

| Caller | How |
| --- | --- |
| An MCP client that declares the Tasks extension | Calling a workflow returns a task at once (`resultType: "task"`). The client polls `tasks/get`, or names the task in `subscriptions/listen` and is sent `notifications/tasks` as it changes. `tasks/cancel` stops the run. A run waiting at an approval gate is `input_required`, and is never approved over MCP. `tasks/get`, `tasks/update` and `tasks/cancel` require the `Mcp-Name` header. A client that does not declare the extension gets the blocking call it always got. |
| An A2A peer | `SendMessage` returns a task; `GetTask`, `SubscribeToTask` and `ListTasks` follow it, and `CancelTask` stops the run. A 1.0 peer may register a webhook to be told instead (below). |
| Anything that speaks HTTP | `POST /api/workflows/<name>`, then the run's own record, or the events above. `POST /api/runs/<id>/cancel` stops it. |

As a client, a tool call that comes back as an MCP task is followed to its end,
by notification where the server sends them and by polling where it does not, and
returned as the result it would have been. It is cancelled if the request is.

## Plugins

A plugin is a package that extends an app from `praecise.config.ts`:

```ts
import { defineConfig } from "@praecise/harness";
import { billing } from "@acme/praecise-billing";

export default defineConfig({ plugins: [billing] });
```

```ts
// in @acme/praecise-billing
export const billing = {
  name: "billing",
  app: { agents: { invoices: agent({ /* ... */ }) }, functions: { refund: fn({ /* ... */ }) } },
  drivers: [ledgerDriver],
  setup: () => registerReader("a ledger export", "application/vnd.acme.ledger", read),
  commands: { reconcile: { describe: "Reconcile the ledger.", run: () => 0 } },
};
```

`app` is a piece of an app: agents, workflows, tools, functions, prompts, resources,
stores and evals, keyed by name as a folder keys them by file. It is merged under
the app's own folder, so where both define a name the app's is used and the
collision is reported in the app's warnings. `drivers` are storage backends.
`setup` runs once before the app is planned, and is where a plugin registers a
request shape (`registerWire`) or a reader. `hooks` are asked after the app's own
`hooks.ts`, in the order the plugins are listed. `blobs` is where the app's blobs
are kept in place of a folder on disk. `commands` run as
`praecise <name> <command>`. Everything a plugin brings is checked by the rules
the folder is checked by.

## Running it

```sh
praecise dev                 # dashboard, chat, REST, MCP, traces — reloads on save
praecise run support "where is order 4021?"
praecise run handle message="I want a refund"
praecise list
praecise doctor              # everything wrong with this app, in one pass
praecise eval                # run the evals; non-zero if a case misses its bar
praecise capture support     # turn recorded exchanges, or a workflow's runs, into eval cases
praecise search refunds      # look through the app's registries for skills and plugins
praecise add refunds         # add a piece to the app, or a skill or plugin from a registry
praecise acp --agent support # serve an agent over stdio, for an editor
praecise ingest ./docs --store catalogue
```

`doctor` is the first thing to run when something is not working. It reports what
will stop the app, then what merely degrades it, then what is only worth knowing,
and exits non-zero only on the first kind — so CI can gate on it.

`run` also reads stdin, and takes `--json`.

`praecise --version` prints the version from 0.6.1; in 0.6.0 and earlier, use `praecise -v`.

While `dev` is up:

| | |
|---|---|
| `GET /` | dashboard |
| `GET /<agent>` | chat UI |
| `GET /w/<workflow>` | run form and history |
| `POST /api/agents/<name>` | `{ input, thread?, attachments? }` |
| `POST /api/workflows/<name>` | the workflow's inputs |
| `POST /api/events/<workflow>` | a CloudEvent; continues the run waiting for it, or starts one, once |
| `POST /api/events` | a CloudEvent, published to every workflow that declared its type |
| `POST /api/runs/<id>` | `{ approved, approver?, signature?, note? }` |
| `POST /api/runs/<id>/cancel` | stop a run; it is recorded as `cancelled` |
| `POST /api/ui/<service>` | what an MCP App's view asks of the service that brought it |
| `POST /v1/responses` | an agent through the Responses API; `model` is the agent's name |
| `POST /mcp` | every agent and workflow, as MCP tools |
| `POST /a2a` | the same app as an agent a peer delegates to (A2A 1.0, and 0.3 for a caller that speaks it) |
| `POST /a2a/message:send`, `POST /a2a/message:stream` | the same over A2A's HTTP+JSON binding |
| `GET /a2a/tasks`, `GET /a2a/tasks/<id>` | a peer's tasks, and one of them |
| `POST /a2a/tasks/<id>:cancel`, `POST /a2a/tasks/<id>:subscribe` | stop a task, or follow it as a stream |
| `/a2a/tasks/<id>/pushNotificationConfigs` | where a peer is told what a task does |
| `GET /asyncapi.json` | the events this app receives and sends, as AsyncAPI |
| `GET /.well-known/agent-card.json` | what a peer needs to know first |
| `GET /ask` | a natural-language question, answered from this app's own store |
| `GET /llms.txt` | a map of this app, for a model that arrived knowing nothing |
| `GET /ai.json` | the same, as JSON-LD |
| `GET /traces` | what the last few requests actually did |
| `GET /mcp/server-card` | what an MCP client needs before it connects |
| `GET /.well-known/ai-catalog.json` | everything this origin offers, from one address |

That MCP line means anything that speaks it — a chat app, an IDE, another agent —
can use this app without knowing it is one. The rest is the same idea for the
other kinds of caller: a peer agent (A2A), a person's front end (AG-UI, below), a
client written against the Responses API, an editor (the Agent Client Protocol),
and a machine that arrived at the URL knowing nothing (`llms.txt`).

### A peer agent

Beside JSON-RPC at `/a2a`, the same methods are served in A2A's HTTP+JSON binding
under the same address, as the routes above; there are no tenant-prefixed paths.
gRPC is not offered and is not listed on the card.

**Push notifications.** A peer speaking 1.0 may register a webhook for a task
(`CreateTaskPushNotificationConfig`, and `Get`, `List` and `Delete` beside it, or
`taskPushNotificationConfig` on the message that starts the task). Each change is
posted to it as `application/a2a+json`. The address must be `https` and not a
private or loopback one unless its host is allowed:

```ts
await serve({ root, a2a: { push: { allowHosts: ["hooks.internal.example"] } } });
```

A peer speaking 0.3 is refused push, and registrations are not kept across a
restart.

**Signed cards.** With `botAuth` set, the agent card is signed (JWS over the
card's canonical JSON form). Before believing a peer's card:

```ts
import { fetchAgentCard } from "@praecise/harness";

const { card } = await fetchAgentCard("https://peer.example", { keys, unsigned: "refuse" });
```

`keys` is a key set already held for that agent, and `trust` names origins whose
key sets are believed; the card's own origin is always among them. A card that is
unsigned or cannot be verified is returned marked `unverified`, or refused with
`unsigned: "refuse"`. `verifyAgentCard` checks a card already in hand.

### An interface the agent describes

When a request says which A2UI catalogs its renderer can draw
(`a2uiRendererCapabilities`), the agent gets a `show_surface` tool. What it
sends is checked as an A2UI 1.0 envelope and returned beside the answer: over
A2A as a data part of type `application/a2ui+json`, over AG-UI as an
`ACTIVITY_SNAPSHOT`, and over HTTP as `a2ui` on the response. What the person
does on the surface comes back as `a2ui` input on the next request. Component
contents are not checked against a catalog, and there is no renderer here: that
is the front end's.

### In an editor

```sh
praecise acp --agent support
```

serves one agent over stdin and stdout in the Agent Client Protocol, for an
editor that launches it. A prompt streams the agent's words and tool calls; a
call the authority wants a person for is put to the editor as a permission
request; and where the editor offers to read files or run a terminal, those are
lent to the agent as tools for that session. Sessions can be created, loaded and
cancelled. MCP servers an editor names when it creates a session are not
connected, and plans, modes, listing sessions, authentication and audio are not
offered.

### As a Responses endpoint

`POST /v1/responses` answers in the shape of the Responses API, so a client
written against that API can call an agent by putting its name in `model`:

```sh
curl "$URL/v1/responses" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"support","input":"where is order 4021?"}'
```

`input` is a string or a list of items, `stream: true` streams the events, and
`previous_response_id` continues the conversation. A client's own function tools
are offered to the agent: a call comes back as a `function_call` item and the
client answers with `function_call_output`. Errors use the API's envelope.
Refused by name, not ignored: `background`, a structured `text.format`,
`tool_choice` other than `auto` or `none`, item references, file inputs, image
URLs, the WebSocket transport and `/compact`.

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

A workflow streams too: `POST /api/workflows/<name>?protocol=ag-ui` with
`Accept: text/event-stream`. A run that stops at an approval gate ends its stream
with `RUN_FINISHED` carrying an interrupt, and is continued by a request whose
`resume` answers it, under the same rules as `POST /api/runs/<id>`.

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

**Everything is persisted in plaintext unless you seal it.** Prompts, inputs, outputs and
conversations go to `<root>/.praecise/`, owner-only (`0700`/`0600`), with no retention
policy. Three things can be sealed at rest, each with a cipher of your own:
workflow runs (`runCipher`), conversations (`threads`) and what agents remember
into files (`memory`):

```ts
const app = await App.load({ root, runCipher: cipher, threads: cipher, memory: cipher });
```

`threads` and `memory` also take a backend in place of a cipher (`Conversations`,
`Recollection`), to keep them somewhere else altogether. Still plain: procedures,
the routing record, recordings, the ingest cache and source cursors. Credentials quoted by an exception are redacted before anything is
written. If you process personal data, this directory is your record and `app.redact()`
is your erasure mechanism.

**Limits are enforced, not declared.** A budget counts planning and judging, not just
the obvious calls; concurrency is bounded across the whole run rather than per step, so
nesting cannot multiply it; and every model call has a timeout.

**The app has the last word on spending.** A `meter` is asked before every model
call the runtime makes: each rung tried, each sample, a climb, a summary, advice,
a transcription, and the calls of an agent asked on the way.

```ts
const app = await App.load({
  root,
  meter: {
    reserve: (call) => (spent(call.caller) > allowance ? "This account has used its allowance." : undefined),
    settle: (call, usage) => record(call.caller, usage),
  },
});
```

`reserve` is handed the agent, the rung, the caller, the context and an
estimate. A sentence back refuses the call and ends the request with
`MeterRefused`; a refusal is never answered by climbing to another model.
`settle` is told what the call took. Live sessions and embeddings are not
metered, and a permission classifier is only when it is passed the same meter.

## Acting under someone else's rules

An agent that pays, signs or moves anything usually answers to rules the app does not
write: a mandate, a policy service, a signed delegation. Five seams carry that, all off
until passed to `App.load`:

```ts
const app = await App.load({
  root,
  authority, // check(attempt) -> { allow } | { refuse } | { stepUp, digest }
  journal: { sink, signer }, // every acting step sealed, chained, signed, delivered
  payer, // a 402 paid once per step, status before pay
  botAuth, // every outbound request signed (Web Bot Auth), key directory served
  sandbox, // snapshot per step, restore before recovery
  runCipher, // runs sealed at rest
});
```

A function says what it does as an `action`, computed from the arguments it was actually
given, and whether its output can be trusted:

```ts
export default fn({
  input: { to: "who", amount: "how much" },
  effect: "write",
  action: ({ to, amount }) => ({ operation: "pay", counterparty: String(to), amount: String(amount) }),
  run: async ({ to, amount }, { fetch }) => (await fetch(`https://pay.example/${to}?amount=${amount}`)).json(),
});
```

The authority is asked after `guard.ts` on every path: the model's tool loop, workflow
steps, HTTP, MCP and the CLI. A refusal goes back to the model as the tool's result. A
`stepUp` on a workflow step pauses the run at `<step>:approve`; the approval must be
signed over a claim that includes the action's `digest`, and the step is asked again
with the verified approver attached. Once untrusted output (a fetched page, an inbox)
has been read, every later action in that conversation or run is marked `tainted`, so
the authority can insist on a person for anything the text might have put there.

An authority can be a policy in prose, read against each call by a model:

```ts
import { permissionClassifier } from "@praecise/harness";

const authority = permissionClassifier({
  policy: "Refunds up to 100 are fine. Anything that sends email needs a person.",
  models: config.models,
  rung: "fast",
});
```

It answers allow, deny or ask, and ask becomes a `stepUp`. It is shown what the
person said and the calls the agent has made (`attempt.recent`), never what a
tool returned or what the model wrote, so text the agent merely read cannot
argue its own case. Identical calls are answered from memory. A classifier that
cannot be reached, or whose answer cannot be read, does not allow the call.

In a conversation, a `stepUp` can be answered mid-turn: `approve` on an ask is
handed the call and its digest, puts the question to a person, and returns the
approval once `app.approvalOf(asking, decision)` has verified it. The authority
is then asked again with the approval attached.

## Config

Optional. A project needs none.

```ts
// praecise.config.ts
import { defineConfig } from "@praecise/harness";

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

An agent can also say what a catalogue should show about it:

```ts
export default agent({
  role: "Review the ledger and flag anything unusual.",
  description: "Audits transactions for a named account.",
  meta: { version: "2.1.0", tags: ["finance", "ledger"], languages: ["en", "pt-BR"], examples: ["Review account 4021 for March."] },
});
```

`meta` is read by every surface that lists the agent: its skill on the A2A agent
card (where `tags` replace the group it is published in, and `inputModes` and
`outputModes` are stated), its MCP tool's `_meta["com.praecise/meta"]`,
`llms.txt` and the JSON-LD. It is never shown to a model.

Nothing published can be undescribed. `praecise package` refuses an app whose
tools say only their own name back, because a caller reads the description and
nothing else before deciding — describe it, or mark it `internal` if it was
never meant to leave.

### Deciding call by call

`access` and `effect` settle what an agent may reach for. What it may do with a
particular call is a different question, and a `guard.ts` at the root answers it:

```ts
import { guard } from "@praecise/harness";

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

### After a tool, and before stopping

A guard speaks before a call. `hooks.ts` at the root speaks at the moments after:

```ts
import { hooks } from "@praecise/harness";

export default hooks({
  afterTool: ({ tool, result }) => (tool === "lookup" ? { result: withoutCardNumbers(result) } : undefined),
  beforeStop: ({ transcript }) => (ranTheTests(transcript) ? undefined : "Run the tests before answering."),
  beforeCompact: () => ({ keep: true }),
});
```

Each answers as a guard does: say nothing and what was going to happen happens.
`afterTool` sees every result before the model does, and may replace it
(`{ result }`) or withhold it with a sentence the model reads instead
(`{ reject }`). `beforeStop` is asked when an agent answers instead of calling a
tool; a sentence back sends it to work again with that as the reason, three
times in one conversation and no more. `beforeCompact` is asked before earlier
work is replaced by a summary: `{ keep: true }` forbids the summary and
`{ summary }` supplies one. `beforeRecord` decides
[what a self is sent](#an-agent-that-remembers-who-it-is).

## Deploying to Praecise Cloud

These commands are from 0.6.0. The version on the npm registry today is 0.5.0
and does not have them; install from this repository, or wait for the next
release, to use them.

The same command deploys a project on [Praecise Cloud](https://praecise.cloud),
shows what is live, and goes back to an earlier release:

```sh
praecise login               # paste a token; it is checked, then kept for next time
praecise deploy --wait       # deploy the project and stay until it is live
praecise releases            # the releases that are kept, and which one is live
praecise rollback            # serve the previous release again
praecise rollback 20261108-080000
praecise status              # one project, or every project the token can see
praecise logs -n 100
praecise whoami              # who the token is, and what it may do
```

`deploy` asks Praecise Cloud to build and release the project from the source it
is set up with; it does not upload this folder. Without `--wait` it returns as
soon as the deploy has started. With it, the build log is printed as it grows and
the command exits 0 when the release is live, 1 when it is not.

`rollback` answers once the earlier release is serving and healthy, which can
take a few minutes. The releases it can go back to are the ones `releases` lists.

**The token.** Create one on the Account page of the console
(<https://console.praecise.cloud>), where you choose
what it may do (read, deploy, roll back), which project it is for, and when it
stops working. `praecise login` keeps it in `~/.config/praecise/cloud.json`,
readable only by you. On a build machine, set `PRAECISE_CLOUD_TOKEN` instead and
skip `login`. The token is never printed.

**The project.** A command takes it from the first of these that is there: the
name on the command line (`praecise deploy shop`), `--project shop`,
`PRAECISE_PROJECT`, or a `praecise.json` in the folder:

```json
{ "project": "shop" }
```

`rollback` takes the release on the command line, so name its project one of the
other three ways.

**In a script.** Every command takes `--json` and prints what the service
answered, a refusal included, as `{ "error": "...", "code": "..." }`. The exit
code says which kind of outcome it was:

| | |
|---|---|
| `0` | done |
| `1` | the deploy or rollback failed, or the service could not be reached |
| `2` | the command, or what it asked for, was not valid |
| `3` | not signed in, or the token may not do that |
| `4` | no such project, release or deploy |
| `5` | a deploy is already running for the project |

`deploy` and `rollback` send a key with the request, so a request that is sent
twice does the work once. To make a re-run of the same step safe as well, name
the key yourself: `praecise deploy --wait --key build-4021`.

| | |
|---|---|
| `PRAECISE_CLOUD_TOKEN` | the token, instead of the one `login` kept |
| `PRAECISE_PROJECT` | the project, when it is not named on the command line |
| `PRAECISE_CLOUD_URL` | the address of the service, when it is not `https://console.praecise.cloud` |

An agent can do the same without the command line: the service speaks MCP at
`https://console.praecise.cloud/mcp`, with the same token as the bearer.

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

Every name exported from `@praecise/harness` is listed in [API.md](API.md), grouped by
the task it belongs to. From 1.0 that list is what semantic versioning covers.

The framework's own moving parts — the project loader, the planner, the provider
wire formats, the packager, the CLI entry point — live at `@praecise/harness/internal`,
which is deliberately **not** covered: names there may change or disappear in any
release, patch releases included. Nothing was deleted to draw that line; it
moved, so that needing one of those names never means forking the framework.
Changes to either surface are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

Apache-2.0
