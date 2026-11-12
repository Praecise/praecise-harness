# Gaps found while designing a library of agents on the harness

Written 12 November 2026 while designing a library of agents for Cultural Layers
(github.com/Praecise/cultural-layers), a booking platform whose agents are to run on this harness. The design
has many people, each of whom turns on some agents from a shared library; every agent reads only what that
person granted it, spends against that person's and that agent's limits, and answers with typed data.

The first list was written from the documentation at 0.5.0. Each item was then checked against the source at
0.6.1 (`f8b82f1`). "In the code" is what was read there. Nothing in the harness is changed by this page, and
nothing here asks the harness for a feature of that product: each need is stated as a general capability, with
the product only as the case that surfaced it.

Items are in the order the product needs them. Items 1 to 4 decide whether its agents can run on the harness
at all.

## 1. The caller does not reach the guard, the authority or a function

- **In the code:** `AskOptions` carries `caller?: { person?: string }` and `surface?: string`
  (`src/harness/types.ts`). `Attempt`, which `guard.ts` and `authority` receive, has `agent`, `tool`, `origin`,
  `effect`, `args`, `via`, `at`, `action`, `tainted` and `approvals` (`src/define.ts`), and is built without the
  ask options (`src/harness/builtin.ts`, `this.refuse(args.agent, call.name, call.args, args.locals,
  args.taint.tainted)`). `FunctionRunOptions` has `idempotencyKey`, `run`, `step`, `fetch` and `approvals`, and
  in the tool loop a function is called with its arguments only (`src/compile/plan.ts`, `run: (args) =>
  spec.run(args)`). `caller.person` is read in one place, to choose a self.
- **Why it matters:** in an app with many people a tool must know whose rows to read, and a guard must know
  what this person allowed this agent. Today both have to be smuggled through the model's arguments, which the
  model can change.
- **Needed:** `caller` and an opaque, app-defined `context` passed from `ask` to `Attempt` and to a function's
  second argument, never shown to the model.

## 2. A request cannot narrow an agent's tools or knowledge

- **In the code:** `AskOptions` can set `ceiling` and `floor` for the model. Tools are resolved once per agent
  name (`builtin.ts`, `this.toolCache.get(plan.name)`), and `knows` is written into the instructions when the
  plan is compiled (`src/compile/plan.ts`). `Caller.groups` and `Caller.readOnly` (`src/server/mcp.ts`) filter
  what is published to a caller, not what one agent may use in one request.
- **Why it matters:** the same agent serves a person who granted it three kinds of data and a person who
  granted one. Without narrowing, each combination is a separate agent definition.
- **Needed:** `AskOptions.allow: { tools?: string[]; knows?: string[] }`, which can only remove.

## 3. No money, and nothing is asked before a model call

- **In the code:** `Limits.budget` is "Tokens one run may spend" (`src/define.ts`), enforced in workflows after
  each call (`src/workflow/run.ts`); `App.ask` has no budget. `Usage` is `inputTokens`, `outputTokens`,
  `cachedTokens` and `decidingTokens` (`src/harness/types.ts`): no cost. A model endpoint and a rung carry no
  price (`ModelProvider` in `src/define.ts`, `Rung` in `src/compile/models.ts`). `AppOptions` has no hook around
  a model call; `middleware.run` wraps a whole ask (`src/app.ts`). There is no per-request limit on model calls
  (the one constant is `MAX_TOOL_TURNS = 6` per rung).
- **What the router does, as read:** when a rung has depth left, a check is one more call at the next depth.
  On a rung capped at zero depth the check draws two or three samples at once (`builtin.ts`,
  `Promise.allSettled(Array.from({ length: wanted - 1 }, …))`; `src/harness/routing.ts`), and the fast rung is
  always capped at zero (`src/compile/models.ts`). An agent with tools is never checked. `preference: "cost"`
  starts one rung lower, always verifies below the top rung and turns exploration off (`routing.ts`).
- **Why it matters:** an app that must hold spending to a fixed amount a day, per person and per agent, cannot
  do so if calls it never sees are made on its behalf. The numbers are in `decidingTokens` afterwards, which is
  too late to refuse.
- **Needed:** a `meter` in `AppOptions` with `reserve(call) -> ok | refuse` and `settle(call, usage)`, asked
  before every model call, samples and climbs included, with the agent and the caller on it; an optional price
  per rung so `Usage` can carry a cost; and a per-request `maxCalls`.

## 4. `returns` cannot describe typed data

- **In the code:** `export type Returns = Record<string, string>` (`src/define.ts`). `schemaFromReturns` types
  every field as a string with the hint as its description (`src/compile/plan.ts`). The comment above it says an
  author "supplies a real schema, which is passed through untouched", but no such path was found: the answer
  path always calls `schemaFromReturns(plan.returns)` (`builtin.ts`). The answer is checked by `JSON.parse` only.
- **Why it matters:** an agent that returns a list of items, a choice between kinds, or a number cannot say so,
  and a malformed answer is accepted.
- **Needed:** accept a JSON Schema (or a standard-schema value) as `returns`, and an optional `read(data)`
  check whose refusal counts as a failed answer, so the router climbs a rung.

## 5. A request is text only

- **In the code:** `Message.content` is a string and `App.ask(agent, input: string, …)` takes a string
  (`src/harness/types.ts`, `src/app.ts`). The A2A endpoint accepts parts with `data`, `url` and `mediaType` but
  flattens them to text, and its card declares `text/plain` only (`src/server/a2a.ts`). Pictures are read only
  at ingestion, into text. Nothing for audio, video or a live session was found.
- **Why it matters:** an agent that is shown a picture or a clip, or that listens and speaks, cannot be a
  harness agent.
- **Needed:** content parts on `Message` (text, picture, audio, video, by bytes or by reference), carried by
  the wires that support them and refused clearly by those that do not. A live audio session is a larger piece
  of work and is noted here only so the part design leaves room for it.

## 6. No evaluation

- **In the code:** the commands are `init`, `dev`, `run`, `add`, `mcp`, `doctor`, `check`, `ingest`, `package`,
  `list`, `memory` and the Praecise Cloud ones (`src/cli/index.ts`). There is no case format and no grader. The
  scripted model the harness's own tests use, `stubModel(replies)`, is in `tests/helpers.ts` and is not
  published (`package.json`, `files`). `registerWire` and `AppOptions.fetch` are the seams an app can use to
  build its own.
- **Why it matters:** an agent that is offered to people should pass a stated set of cases first, and that
  check has to run without a paid model.
- **Needed:** a published scripted wire for tests; a case file per agent (input, what the answer must and must
  not contain, what must be refused, an optional judge); and an `eval` command that exits non-zero below a
  threshold.

## 7. An agent has no catalogue metadata

- **In the code:** `AgentSpec` has `name`, `role`, `description`, `knows`, `tools`, `code`, `quality`, `rules`,
  `memory`, `returns`, `examples`, `greeting`, `self`, and `access`, `effect`, `group` (`src/define.ts`). The
  version is the app's. In the agent card every skill carries the whole app's group list as its `tags` and
  `text/plain` as its modes (`src/server/a2a.ts`); the card is not signed. An MCP tool carries a name, a
  description, an input of one string and the hints derived from `effect` (`src/server/mcp.ts`).
- **Why it matters:** a client that lists agents for a person to choose from, or another assistant that routes
  to them, has only a name and a description to go on.
- **Needed:** a free `meta` record on `agent()` (version, tags, languages, input modes, example requests),
  carried into the card's skill and into MCP tool metadata; tags per skill instead of per app.

## 8. A self is sent the question and the answer

- **In the code:** after an answer the provider's `record` receives `{ task, answer, tools }`
  (`builtin.ts`), and the HTTP provider posts ``Asked: "…". Answered: …`` with the question cut to 300
  characters and the answer to 900 (`src/harness/selves.ts`). Two levers exist today: `AskOptions.task` replaces
  the question text, and `AppOptions.selves` lets an app wrap the provider. A handle may mix a literal with
  `{person}` (`"coach-{person}"` is the documented example), and `{person}` is filled with a digest, not the id.
- **Why it matters:** a self that belongs to an agent, not to a person, would collect many people's words.
- **Needed:** a documented `record` hook on the agent or the app that may shorten, replace or drop what is
  sent, so that wrapping the provider is not the only way.

## 9. Conversations and memory are stored unsealed

- **In the code:** threads are plain JSON under `.praecise/threads/` (mode 0600), written when a request names
  a thread; agent memory is plain JSON (`src/harness/threads.ts`, `src/harness/memory.ts`). `src/private.ts`
  says so: "There is no retention here and no encryption at rest". Only workflow runs take a cipher
  (`AppOptions.runCipher`). `Threads` accepts another backend, but `AppOptions` has no field for one
  (`src/app.ts` constructs `new Threads(join(stateDir, "threads"))`).
- **Corrected from the first list:** traces are kept in memory, not on disk, and the routing ledger holds
  counts and flags, no text.
- **Needed:** a `threads` (and memory) backend or cipher in `AppOptions`, as runs already have.

## 10. An agent cannot call another agent from its tool loop

- **In the code:** a name in `tools` is a function or an MCP service (`src/compile/plan.ts`); delegation is a
  workflow `ask` or `plan` step, or a call to another app over MCP or A2A.
- **Needed, later:** an agent named as a tool, run in its own context, with a depth limit and taint carried
  across. The product delegates in its own code for now.

## 11. Agents cannot be added to a running app

- **In the code:** "a file change is handled by building a whole new app rather than by patching a live one"
  (`src/app.ts`). `serve()` reloads the whole app on a file change. An app embedded in another server must
  build a new one and swap it itself.
- **Needed:** either say so in `API.md` with the recommended swap, or add `app.replace(agent)`.

## 12. Nothing records a choice between agents

- **In the code:** the router chooses a rung of one agent, and the ledger is per agent (`routing.ts`).
  `App.ask` takes the agent's name.
- **Minor.** An app that chooses among agents keeps its own record. A shared record format would let the
  harness learn from it later; nothing is asked for now.

## What Cultural Layers does in the meantime

Its agents run in its own server code, on its own model ladder and its own daily meter, with the person's
grant enforced in its database. Each agent definition is written so that it compiles to a harness `agent()`
once items 1 to 4 are closed; the harness scaffold in that repository stays as it is until then. Items 5 and 6
decide when agents that see, hear and speak, and the check that gates listing an agent, can move across.
