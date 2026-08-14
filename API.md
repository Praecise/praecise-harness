# The public API

Everything exported from `praecise` is listed here. From 1.0 onwards this list
is what semantic versioning covers: a name on this page will not be removed, and
its shape will not change incompatibly, without a major release.

Anything **not** on this page is not part of the promise, even if you can reach
it. In particular:

> **`praecise/internal` is unstable and unversioned.** Every name behind that
> subpath may change, be renamed, or disappear in any release, including a patch
> release. There is no deprecation period. It exists so that needing one of the
> framework's own moving parts does not force you to fork the framework — not as
> a second API. If something you genuinely need is only reachable there, please
> open an issue; that is a gap in the surface below.

Deep imports (`praecise/dist/...`) are not reachable at all. The package's
`exports` map has exactly three entries: `.`, `./internal`, and
`./package.json`.

---

## Authoring — writing the app

A folder of these calls *is* the app. This is the only part most apps ever use.

| Name | What it is |
| --- | --- |
| `agent` | Declare an agent: a role, what it knows, what it may act through. |
| `workflow` | Declare a sequence or graph of steps, with a declared outcome. |
| `tool` | Declare an external service the app may call. |
| `fn` | Declare a local function an agent may call. |
| `prompt` | Declare a named, parameterised prompt. |
| `resource` | Declare a readable resource addressed by URI. |
| `store` | Declare a backing store (`sql`, `vector`, `document`, `timeseries`; `graph` needs a brought backend — see [Storage](#storage-and-extending-it)). |
| `guard` | Declare a check that runs before a call and may refuse it. |
| `middleware` | Wrap every call the app makes. |
| `knowledge` | Declare a document the app knows, in code rather than in `memory/`. |
| `blueprint` | Declare a set of files that scaffolds a whole app. |
| `template` | Declare a set of files that scaffolds one part of one. |
| `defineConfig` | The contents of `praecise.config.ts`. |
| `QUALITIES` | The ladder rungs, in order: `fast`, `balanced`, `best`. |

**Narrowing a step.** A `Step` is a union; these tell you which arm you have.

`isAsk` · `isUse` · `isApprove` · `isPlan` · `isEach` · `isRepeat` · `isWhen`

**Types.** One `*Spec` per kind (what the call returns) and one `*Input` per kind
(what you pass it):

`AgentSpec`/`AgentInput` · `WorkflowSpec`/`WorkflowInput` ·
`ToolSpec`/`ToolInput` · `FunctionSpec`/`FunctionInput` ·
`PromptSpec`/`PromptInput` · `ResourceSpec`/`ResourceInput` ·
`StoreSpec`/`StoreInput` · `GuardSpec`/`GuardInput` ·
`MiddlewareSpec`/`MiddlewareInput` · `KnowledgeSpec`/`KnowledgeInput` ·
`BlueprintSpec`/`BlueprintInput` · `TemplateSpec`/`TemplateInput`

Supporting types:

| Type | What it describes |
| --- | --- |
| `Published` | What every published thing declares: `access`, `effect`, `group`. |
| `Access` | Who may reach it: `"open"`, `"gated"`, `"internal"`. |
| `Effect` | What calling it does: `"read"`, `"write"`, `"destructive"`. |
| `Step` | The step union, and its arms `AskStep`, `UseStep`, `ApproveStep`, `EachStep`, `WhenStep`, `RepeatStep`, `PlanStep`. |
| `Check` | What a `repeat` runs until, and what a workflow's `outcome` asserts. |
| `Ref` | A reference into the run's scope, written as text. |
| `Returns` | A declared output shape: field name to plain-English hint. |
| `Quality` | One rung of the ladder. |
| `Limits` | Ceilings a run inherits: depth, concurrency, timeout. |
| `MemorySpec` | What an agent remembers, and where. |
| `AppConfig` | The `praecise.config.ts` shape. |
| `Provider`, `ModelProvider` | An endpoint the app may call. |
| `Call`, `Reply`, `Attempt` | What middleware and guards are handed. |
| `FileContents` | One file a blueprint or template writes. |
| `StoreKind` | Which kind of store a `store()` declares. |

## Running — loading a folder and driving it

| Name | What it does |
| --- | --- |
| `App` | Load a folder into a running app. `App.load({ root })`. |
| `AppOptions` | What `App.load` accepts: root, env, fetch, drivers, telemetry sink. |
| `startRun` | Start a workflow run. |
| `resumeRun` | Resume one that stopped at a human approval gate. |
| `recoverRun` | Re-drive a run that was interrupted, refusing where exactly-once cannot be proven. |
| `RunStore` | Where runs are persisted, and how they are listed and loaded. |
| `serve` | Bring up the dev server: chat UI, REST, and an MCP endpoint. |
| `serveStdio` | Serve the app over MCP on stdio, for an editor or another agent. |
| `followRun` | Async-iterate a run's events, from the start and then as they arrive. |
| `provenanceOf` | Build the graph of what a run derived from what. |

Types: `Run`, `RunStatus`, `RunEvent`, `PlanVersion`, `Outcome`, `ProvGraph`,
`WorkflowDeps`, `ProvisionRequest`, `ProvisionResult`, `ApprovalClaim`,
`ApprovalDecision`, `VerifyResult`, `DevServer`, `ServeOptions`,
`StdioServer`, `StdioOptions`, `Project`, `Doc`, `AgentPlan`, `LocalTool`,
`ResolvedService`, `Rung`.

`Project` and `Doc` are what `App.project` is. `AgentPlan` is what an agent was
compiled into — the composed instructions, the rungs to try, the tools it may
call — and is what a custom `WorkflowDeps.planFor` must return.

`ApprovalClaim` is exactly what an approval signature covers; implement
`WorkflowDeps.sign`/`verify` against it. With no signer, nothing is
synthesised — the ledger records the approval as unsigned rather than inventing
a signature.

## The harness — models, memory, and adapters

| Name | What it is |
| --- | --- |
| `BuiltinHarness` | The harness that ships with the framework. |
| `resolveHarness` | Pick a harness from config and credentials. |
| `Harness` | The interface a harness satisfies. Implement it to replace ours. |
| `ChatAdapter` | `(request: ChatRequest) => Promise<ChatResponse>` — one provider. |
| `ProviderError` | What an adapter throws when a provider refuses or fails. Throwing this rather than a bare `Error` is what lets the ladder tell a retryable failure from a fatal one. |
| `Memory`, `StoredMemory` | Episodic memory, on files or in a declared store. |
| `SkillBook`, `usableProcedures`, `renderSkills` | Procedural memory: what the app has learned how to do, and what of it is worth putting in context now. |
| `Ledger` | The record of routing decisions, and what they cost. |
| `verifyMarginFor` | How much margin a verified answer had over the alternative. |

Types: `ChatRequest`, `ChatResponse`, `Message`, `ToolCall`, `ToolSchema`,
`Answer`, `AskOptions`, `Progress`, `Usage`, `Routing`, `Episode`,
`Recollection`.

`PROTOCOL_VERSION` is the MCP protocol revision this framework speaks.

## Storage, and extending it

Using a store:

| Name | What it does |
| --- | --- |
| `Stores` | Every store the app declared, opened on demand. |
| `openStore` | Open one store from a URL. |
| `Kept` | A store's write side, as handed to app code. |

Writing a new backend:

| Name | What it does |
| --- | --- |
| `memoryDriver` | The in-process driver. Useful as the reference implementation. |
| `sqliteDriver` | The SQLite driver. Loads `node:sqlite` lazily, on first use. |
| `postgresDriver` | The Postgres driver. |
| `conform` | Run the conformance suite against a driver you wrote. |
| `conformanceReport` | The same, rendered for a human. |
| `Wire` | The Postgres wire framing, reusable by a driver that speaks it. |
| `wireOptionsFrom` | Turn a connection URL into wire options. |

Types: `Driver`, `Store`, `Connection`, `ConnectOptions`, `Capabilities`,
`Item`, `Keep`, `Found`, `Query`, `Window`, `Ranked`, `ResultSet`, `Promised`,
`Conformance`, `StoresOptions`, `WireOptions`, `WireResult`, `Held`.

A driver only has to implement the capabilities it actually has; `conform`
checks what it claims, not a fixed list.

### Which family a store actually gets

`of` declares one of five families. What ships serves four — `sql`, `document`,
`timeseries` and `vector` — over one table of text, json, a time and an optional
vector. `graph` is not served by anything here and is **refused when the store
is opened**, naming what is served. That refusal is the honest half of a
declaration that used to be accepted and then quietly ignored.

`Capabilities` carries three fields for reading the choice back:

| Name | What it says |
| --- | --- |
| `serves` | The families this backend will answer for. Absent means the driver makes no claim, and a driver that makes none is held to none — a backend written before this existed is not refused for having no opinion. |
| `vectorSearch` | `"index"` where the database orders by distance, `"scan"` where every vector is read and compared in this process. `vectors` still means *can it hold them*; this is what asking costs. |
| `detail` | What was settled at connect, phrased as the thing to do about it. |

`ConnectOptions` carries two more: `of`, so a driver can shape itself to what it
is holding, and `extension`, a native extension path an operator named. The
SQLite driver reads the second from `PRAECISE_SQLITE_EXTENSION` and loads
nothing without it.

### Extensions, and what each costs

| Extension | To install | What it buys |
| --- | --- | --- |
| pgvector | `CREATE EXTENSION vector` — one statement, no restart | A real `vector(n)` column, an HNSW index, and `<=>` doing the ordering. Needs `dimensions`. |
| TimescaleDB | `shared_preload_libraries` plus **a restart** | A `timeseries` store becomes a hypertable in weekly chunks. Only `create_hypertable` is used — the Apache-2.0 subset. Compression, continuous aggregates, retention and the job scheduler are source-available and are not touched. |
| sqlite-vec | A build on disk, named in `PRAECISE_SQLITE_EXTENSION` | vec0 answers nearest-vector queries over an unnarrowed window. Never loaded unless asked for. |
| Apache AGE | `CREATE EXTENSION age`, plus `LOAD 'age'` and a `search_path` per session | Nothing here uses it. Reachable through `query()`. |

Whatever is installed is reachable through `Store.query()` regardless — the
author's door, not the agent's. An existing table is never migrated underneath
an adopter: a `bytea` vector column keeps the in-process comparison and says so
in `detail`.

## Dialect and latent transport

Two halves of one idea: the framework ships the **mechanism**, and each app
declares its own **vocabulary** on top. A vocabulary is a property of your
domain, so hard-coding one here would make every app speak the same language
whether or not it meant the same things.

**The codec.** A versioned, field-typed wire format built from a table of
message specs.

| Name | What it is |
| --- | --- |
| `defineDialect` | Build a dialect from a version string and a table of message specs. |
| `str`, `num`, `bool`, `list`, `fixed2` | Field codecs. `fixed2` fixes a number to two decimal places, so a value round-trips identically. |
| `Dialect`, `MessageSpec`, `Field`, `FieldCodec` | The types involved. |

**The transport.** An intermediate representation passed between steps without
being rendered back to text.

| Name | What it is |
| --- | --- |
| `latent` | Wrap a vector as a payload, with its source and dimensions. |
| `isLatent` | Type guard for one. |
| `latentRef` | Name a payload without carrying it. |
| `createRefs` | A ref table, so a payload travels once and is referred to after. |
| `latentChannel` | Move payloads between steps. |
| `probe` | Read a named scalar off a payload. |
| `LatentPayload`, `LatentRef`, `LatentChannel`, `Refs`, `Probe` | The types involved. |

`probe` is not optional decoration. An opaque vector nobody can measure is not
something to put in a pipeline; probes are what keep latent traffic auditable
after the fact.

## Observability

There is no telemetry dependency and no exporter. The framework produces the
standard shape and the app wires the sink:

- `AppOptions.emit` and `WorkflowDeps.emit` take `(span: GenAiSpan) => void`.
- `GenAiSpan` follows the OpenTelemetry GenAI semantic conventions
  (`invoke_agent` / `execute_tool` / `plan` / `invoke_workflow`), so a run is
  legible to Phoenix, LangSmith, Datadog or a plain collector without adding a
  dependency here.
- `Ledger` records routing decisions and spend.
- `provenanceOf(run)` answers what a run derived from what.
- `followRun(runs, id, signal)` streams `RunEvent`s live.

---

## `praecise/internal`

Unstable. Unversioned. May change or vanish in any release, patch releases
included. Documented here only so you know what it holds and why you should not
reach for it:

- **Loading** — `loadProject`, `resolveKnows`, `findCycle`, `Importer`,
  `LoadOptions`
- **Ingest** — `ingestFile`, `canConvert`, `converterFor`, `Converted`,
  `Converter`, `ConvertRequest`, `IngestOptions`, `ConverterOptions`
- **Compiling** — `planProject`, `planAgent`, `planWorkflowAgent`, `schemaFor`,
  `PlanOptions`
- **Harness internals** — `adapterFor`, `chatWire`, `contentsWire`,
  `messagesWire`, `stateDirFor`, `stream`, `trim`
- **Store internals** — `urlFor`, `asObjects`
- **Workflow internals** — `checkSteps`, `provisioner`, `runCommand`,
  `splitCommand`, `Manifest`, `ProvisionerDeps`
- **Server internals** — `handleMcp`, `callPublished`, `toolsOf`, `promptsOf`,
  `resourcesOf`, `groupsOf`, `noticesOf`, `openChannel`, `Caller`, `McpTool`,
  `Channel`
- **Packaging** — `buildPackage`, `manifestFor`, `apiModule`, `apiTypes`,
  `faultsIn`, `hintsIn`, `PackageManifest`, `PackageOptions`, `PackageResult`,
  `Describable`
- **CLI** — `cli`. The supported way to run this is the `praecise` binary.
