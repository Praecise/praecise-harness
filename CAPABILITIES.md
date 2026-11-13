# Capabilities

Everything the framework does, where it lives, and what it deliberately does not do.
Each row is either `built` or `declined`; a declined row gives the reason. When a
provider changes a request shape or a protocol publishes a revision, the row that
names it is the row to re-check.

## How anything is added

A capability goes in through a seam that already exists. If there is no seam for it,
the seam is the thing to build first.

| Seam | What goes through it |
| --- | --- |
| `ChatAdapter` + `registerWire` | A request shape. One file per shape; shared transport in `wire/http.ts`. |
| `registerSession`, `registerUploader`, `registerBatch` | A live-session protocol, a files API and a batch API, each beside the wire it belongs to. |
| `LocalTool` | Anything a model can call: your functions, and every tool the runtime itself contributes (`harness/faculties.ts`). The loop has no branch per capability. |
| `Attachment` + `registerReader` + `registerDecoder` | Anything sent or returned that is not text. The endpoint reads it, a reader renders it, a decoder takes it apart, or a note says it was left out. |
| `Harness` | The whole runtime. Replace it, or stand a test double in for it. |
| `Driver` + `conform` | A storage backend. Values, facts and series are verbs over a driver's existing operations, so a new backend has them without implementing them; a driver may declare faster paths, each held to the same answer. |
| `Embedder`, `Reranker`, `BlobStore` | Text to vectors, a second opinion on what was found, and where large bytes are kept. |
| `Source`, `CloudEvent`, `notify` | Events in (pulled and pushed) and out. |
| `guard`, `Authority`, `hooks`, `meter`, `middleware` | A check before a call, policy, the moments after a tool call and before stopping or summarising, a say before every model call, and a wrap around a request. |
| `Plugin` | A package's piece of an app: agents, functions, tools, drivers, blobs, hooks, commands, and a `setup` for registering wires and readers. |
| `SelfProvider`, `payer`, `botAuth`, `sandbox`, `tracer`, `Screen` | Identity and memory of a self, payment, request signing, isolation, telemetry, and a screen for computer use. |
| Folder kinds (`agents/`, `workflows/`, `functions/`, `tools/`, `stores/`, `memory/`, `skills/`, `evals/`) | What an app is made of. The same kinds are accepted in code by `createApp` and from a plugin. |

The framework ships no model ids, no base URLs and no prices. Provider coverage means
every shape a provider speaks is spoken correctly, not that a provider is named.

## 1. Model providers and wires

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 1.1 | Five request shapes: `chat`, `messages`, `responses`, `contents`, `interactions`; more by `registerWire` | built | `harness/wire/` |
| 1.2 | Per-endpoint credential header, extra headers, extra body fields | built | `define.ts` `Provider` |
| 1.3 | Constrained decoding from a schema on every wire that has it | built | each wire |
| 1.4 | No sampling parameters sent to endpoints that reject them | built | each wire |
| 1.5 | Idle and total clocks on every wire, composed with the caller's signal | built | `wire/http.ts` |
| 1.6 | `retry-after` honoured; spend-limit 429s not retried | built | `wire/http.ts`, `builtin.ts` |
| 1.7 | Reasoning handed back across tool turns: thinking blocks, encrypted reasoning items, `reasoning_content`/`reasoning`, thought steps, thought signatures | built | each wire, `Message.replay` |
| 1.8 | One vocabulary for why a reply ended; refusal and filter recognised on every wire; truncation reported | built | `stopOf`, `ChatResponse.stop` |
| 1.9 | Prompt caching where the endpoint must be told: stable system prefix and conversation breakpoint | built | `wire/messages.ts`, `ChatRequest.stable` |
| 1.10 | Cache reads and writes counted as input on every wire; cache-write and reasoning tokens reported | built | `Usage` |
| 1.11 | Depth words above `high` (`xhigh`, `max`), declared per endpoint | built | `ModelProvider.levels` |
| 1.12 | Output room declared per endpoint; thinking requests not starved by a small default | built | `ModelProvider.output` |
| 1.13 | Embeddings and reranking endpoints | built | `harness/embed.ts`, `harness/rerank.ts`, `ModelProvider.embeds` / `reranks` |
| 1.14 | Live sessions over a WebSocket: text and audio in and out, tool calls through the guard, interruption. Openers for the realtime protocol of `responses`/`chat` and the live protocol of `contents`/`interactions` | built | `wire/session.ts`, `wire/realtime.ts`, `wire/live.ts`, `App.open`. One endpoint per session, no failover or reconnect; no WebRTC; no opener for `messages`, which publishes no such protocol. |
| 1.15 | Large attachments uploaded once through the endpoint's files API and named after | built | `wire/files.ts`, `ModelProvider.uploads`. The cache is per process. |
| 1.16 | Batch APIs: many questions handed over together, tools run between batches | built | `wire/batch.ts`, `App.askMany`. No driver for `interactions`, whose batch API does not take it. |
| 1.17 | Server-side tools (provider web search, code execution), provider-hosted MCP connectors | declined | The app's tools go through `guard.ts` and the authority; a tool that runs on the provider's side does not. Reachable through `body` on an endpoint for an app that wants one. |
| 1.18 | Server-held conversations (`previous_response_id`, `thread`, `previous_interaction_id`) | declined | The framework keeps the transcript it replays (`store: false` is sent on purpose); a second copy on the provider is retention nobody asked for. |
| 1.19 | Provider-side context editing and compaction | declined | Done in the runtime (3.3, 3.4) so it works the same on every wire. |

## 2. Modalities and data types

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 2.1 | One content model: an attachment is a media type and bytes, a URL, an uploaded file's name or a blob address, on a question and on a tool result | built | `Attachment`, `Message.attachments` |
| 2.2 | Images and PDFs on every wire | built | each wire |
| 2.3 | Audio and video where the shape has a place: `contents`, `interactions`, and `chat` when the endpoint's `takes` says so | built | `ModelProvider.takes`, `harness/modality.ts` |
| 2.4 | Explicit degradation: what an endpoint cannot be sent is rendered or named in `answer.notes`, never dropped silently | built | `present`, `show` |
| 2.5 | Time series and sensor data: SenML (RFC 8428) rendered per channel with statistics and a downsample | built | reader in `modality.ts` |
| 2.6 | Robot state, action chunks, latents: tensors in the Open Inference Protocol JSON form | built | reader in `modality.ts` |
| 2.7 | Tables (CSV, TSV), scenes (glTF), text, JSON, XML, YAML | built | readers in `modality.ts` |
| 2.8 | Media in tool results on every wire: `attach()` from a function; MCP image, audio, embedded resource, resource link | built | `runTool`, `mediaIn`, each wire |
| 2.9 | Media out: images and audio a model returns, on `answer.attachments` | built | `contents`, `interactions`, `chat` |
| 2.10 | New kinds of data by registration, from an app or a plugin | built | `registerReader` |
| 2.11 | Documents into a store: PDF, Word, Excel, PowerPoint, CSV, images, source | built | `src/ingest/` |
| 2.12 | Dense latent payloads between steps, with probes | built | `transport.ts` |
| 2.13 | Recordings, tables, point clouds and scenes described to a model: MCAP, ROS 1 bags, LeRobot dataset metadata, Parquet, Arrow IPC, PCD, PLY, Gaussian splats, USD, NumPy | built | `@praecise/harness/formats`, a plugin that is off until listed. Structure, sizes, time range, topics or columns and a bounded sample; every rendering ends by naming what it did not read. |
| 2.14 | Video an endpoint cannot take, taken apart into stills and a transcript | built | `registerDecoder`, `ffmpegDecoder` over a binary the app names. With no decoder registered the video is named in a note. |
| 2.15 | Forecasting, vision-language-action and world models as callable models | declined as wires | They take and return tensors and media, not conversations. They are tools (an MCP service or a function) whose inputs and outputs are attachments; 2.6 and 2.8 are what makes that work. |

## 3. The agent loop

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 3.1 | Tool loop with guard and authority on every call, refusal returned to the model as the result | built | `builtin.ts` |
| 3.2 | Turn limit per agent (default 16); model-call limit per request | built | `AgentSpec.turns`, `AskOptions.maxCalls`, `Limits.calls` |
| 3.3 | Tool-result clearing when the transcript passes half the room, keeping the calls | built | `harness/context.ts` |
| 3.4 | Compaction: the model writes notes on the earlier work; the question is never rewritten | built | `harness/context.ts` |
| 3.5 | Long results kept whole and read by line or search | built | `Shelf`, `read_result` |
| 3.6 | Read-only calls in one turn run together | built | `builtin.ts` |
| 3.7 | Tool search: `find_tools` / `use_tool` when a list is too long; the guard sees the real tool | built | `harness/faculties.ts` |
| 3.8 | Code mode: one `code` tool over the agent's services, run in a microVM | built | `harness/codemode.ts` |
| 3.9 | Knowledge that overflows is outlined and read through a tool | built | `compile/outline.ts` |
| 3.10 | Authored skills (SKILL.md) with progressive disclosure | built | `project/skills.ts`, `compile/skills.ts` |
| 3.11 | Structured output: `returns` as fields and hints, a JSON Schema or a Standard Schema; the answer is checked, and one that fails sends the router up a rung | built | `schema.ts`, `AgentSpec.returns`, `AgentSpec.read`, `ShapeError` |
| 3.12 | Streaming that never takes back what it showed | built | `Progress` |
| 3.13 | Cancellation reaches tools as well as models | built | `runTool` |
| 3.14 | Hooks after a tool call (rewrite or withhold), before stopping (send back, bounded), before compaction (forbid or supply), and before a self is told (shorten or drop) | built | `harness/hooks.ts`, `hooks.ts` in a project, `Plugin.hooks` |
| 3.15 | A request carries who it is for and an app-defined context to the guard, the authority, functions and the meter, and never to a model | built | `AskOptions.caller`, `AskOptions.context`, `Attempt` |
| 3.16 | A request narrows an agent's tools and knowledge, and can only remove | built | `AskOptions.allow` |
| 3.17 | A request lends an agent tools of its own, and answers an approval mid-turn | built | `AskOptions.tools`, `AskOptions.approve` |
| 3.18 | Computer use: an action vocabulary over a `Screen`, screenshots as tool-result images, a browser driver over the DevTools Protocol, the endpoint's own tool type where it declares one | built | `harness/computer.ts`, `harness/browser.ts`, `ModelProvider.computer` |
| 3.19 | Built-in file and shell tools | declined | An app's tools are MCP services, functions or code mode. A framework that ships a shell ships a default nobody audited. |

## 4. Orchestration and long-running work

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 4.1 | Workflows: sequence, graph (`after`), `each`, `when`, `repeat`, `plan`, `approve`, `wait` | built | `workflow/run.ts` |
| 4.2 | Durable runs: journal, resume at a gate, recover after a crash, fork with a patch, idempotency keys | built | `workflow/` |
| 4.3 | Signed approvals with quorum | built | `workflow/verify.ts` |
| 4.4 | Sub-agents with isolated context, as tools; bounded depth; usage and taint carried up | built | `delegateTool`, `AgentPlan.delegates` |
| 4.5 | Background sub-agents: started without waiting, checked, steered, cancelled, collected | built | `Crew`, `AgentSpec.background`, `AskOptions.steer` |
| 4.6 | Work that outlives a connection, over MCP: the Tasks extension, server and client, with pushed task state | built | `server/mcp-tasks.ts`, `harness/mcp.ts` |
| 4.7 | Work that outlives a connection, over A2A: tasks, streaming, subscription, push notifications | built | `server/a2a.ts` |
| 4.8 | Cancelling a run that is under way: the call in flight is aborted and the run ends as `cancelled` | built | `App.cancelWorkflow`, `POST /api/runs/<id>/cancel`, MCP `tasks/cancel`, A2A `CancelTask` |
| 4.9 | A workflow step that waits for an outside event, continued once, with a timeout | built | `WaitStep`, `App.signal`. The timeout fires while a process holds the app; exactly-once holds within one process. |
| 4.10 | Scheduled runs: a clock is a source, by interval or cron expression, with a stated catch-up rule | built | `schedule.ts` `clock` |
| 4.11 | One agent replaced, added or removed in a running app; requests under way finish on the plan they started with | built | `App.replace`, `App.add`, `App.remove` |

## 5. Events

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 5.1 | Pulled: a `Source` with a stored cursor, at-least-once, one run per event | built | `sources.ts`, `App.follow` |
| 5.2 | Pushed: CloudEvents 1.0 over HTTP (structured, batched, binary), one run per `source` + `id` | built | `events.ts`, `POST /api/events/<workflow>`, `App.deliver` |
| 5.3 | Told: run lifecycle as CloudEvents to a function or a signed webhook (Standard Webhooks), retried, never failing the run | built | `notify.ts`, `webhooks.ts` |
| 5.4 | Run and answer streams over SSE; AG-UI | built | `server/events.ts`, `server/agui.ts` |
| 5.5 | A bus inside the app: a workflow subscribes to event types, a function or step publishes, a retried step republishes the same event | built | `WorkflowSpec.on`, `App.publish`, `POST /api/events`. In process, exact types only. |
| 5.6 | An AsyncAPI description of what the app receives and sends | built | `server/asyncapi.ts`, `GET /asyncapi.json` |

## 6. The model ladder and deciding

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 6.1 | Per-request routing from the shape of the request; cost/balanced/quality preference | built | `harness/routing.ts` |
| 6.2 | Self-consistency check near the edge of a rung; depth before another model | built | `builtin.ts` |
| 6.3 | Ladder across endpoints; transient failure retried in place, dead endpoint crossed | built | `compile/models.ts`, `builtin.ts` |
| 6.4 | Per-request `ceiling` and `floor` | built | `AskOptions` |
| 6.5 | Routing ledger with propensities and optional exploration | built | `Ledger` |
| 6.6 | Advisor: the strongest rung consulted while a cheaper one works | built | `consultTool`, `AgentSpec.advisor` |
| 6.7 | Budgets counted across planning and judging; concurrency bounded per run | built | `Limits` |
| 6.8 | Cost in money from prices the endpoint declares; a spending cap on a run; nothing priced that was not declared | built | `harness/cost.ts`, `ModelProvider.prices`, `Limits.spend` |
| 6.9 | A meter asked before every model call the runtime makes, and told what each took | built | `harness/meter.ts`, `AppOptions.meter`. Live sessions and embeddings are not metered. |

## 7. Memory and data

There is no ORM, and that is a decision. What makes an agent's data access safe is the
role its connection holds and bound parameters, not a type mapping. The framework
offers verbs (namespaced key-value, relationships with the time they were true, time
series, text and vector recall) and SQL, or the backend's own commands, as the door an
author opens on purpose.

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 7.1 | Text: `remember`, `recall` (relevance decayed by recency), `search`, `history`, `forget`, `redact` | built | `stores/store.ts` |
| 7.2 | Vectors: pgvector HNSW, sqlite-vec or Redis vector sets where installed, compared in process where not, and said which | built | `stores/` |
| 7.3 | Recall by words and by meaning at once, fused by rank, with an optional reranker | built | `fuse`, `Reranker` |
| 7.4 | SQL as the author's own door, bound parameters only | built | `Store.query`, `stores/wire.ts` |
| 7.5 | Key-value: namespaced `put`/`get`/`delete`/`list` with a lifetime | built | `stores/models.ts` `Values` |
| 7.6 | Relationships: bi-temporal facts, closed never deleted, `asOf`, a walk to three steps | built | `stores/models.ts` `Facts` |
| 7.7 | Time series: `append`, `range` with windows and aggregates, `last` | built | `stores/models.ts` `Series` |
| 7.8 | Walks and series buckets answered by the database where it can: recursive SQL, grouped aggregates, `time_bucket` where TimescaleDB is present | built | `stores/paths.ts`, `Capabilities.faster` |
| 7.9 | Typed records: a Standard Schema on a store, checked on the way in, typed on the way out | built | `StoreSpec.schema`, `SchemaError` |
| 7.10 | Blobs: bytes kept once under their SHA-256, on disk by default, carried by address from a row or an attachment; swept only when asked | built | `blobs.ts`, `App.blobs`, `Plugin.blobs` |
| 7.11 | Conversations by name; episodic memory; notes with provenance; accepted procedures; selves | built | `harness/threads.ts`, `memory.ts`, `consolidate.ts`, `procedure.ts`, `selves.ts` |
| 7.12 | Conversations and memory sealed at rest with a cipher, or kept in a backend the app supplies | built | `AppOptions.threads`, `AppOptions.memory` |
| 7.13 | Backends: memory, a file (SQLite), PostgreSQL over its own wire client, Redis and Valkey over their own; anything else a `Driver`, graded by `conform` | built | `stores/` |
| 7.14 | PostgreSQL 18: `uuidv7()` ids, a `WITHOUT OVERLAPS` key on a fact's validity where `btree_gist` is installed, protocol 3.2 on request | built | `stores/postgres.ts`, `stores/wire.ts`. Detected; older servers fall back and say so. |
| 7.15 | A graph engine as a store family (`of: "graph"`) | declined | Refused rather than pretended at. Relationships are 7.6 on any store; a graph query language is a backend an app brings. |
| 7.16 | Agent-editable memory files (a memory tool) | declined | Nothing an agent proposed about itself takes effect because it proposed it. |

## 8. Safety

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 8.1 | `guard.ts`, `authority`, `access`/`effect` on everything published | built | `define.ts`, `authority.ts` |
| 8.2 | Taint: untrusted output marks every later action; carried across a delegated agent | built | `Answer.tainted`, `builtin.ts` |
| 8.3 | Credentials outside the sandbox in code mode; allow rules enforced by the silo | built | `harness/codemode.ts` |
| 8.4 | Sealed, hash-chained, optionally signed journal | built | `journal.ts` |
| 8.5 | Dev server: token, loopback default, origin and host allowlists | built | `server/` |
| 8.6 | Attachment and resource-link URLs limited to `https:` and `data:`; webhook addresses refused when they resolve into a private network | built | `attachmentsIn`, `mediaIn`, `outbound.ts` |
| 8.7 | Outbound requests signed so a server can tell which agent is calling (Web Bot Auth, RFC 9421) | built | `botauth.ts`, `AppOptions.botAuth` |
| 8.8 | A gate is never approved by a peer's message (MCP task update, A2A message) | built | `server/mcp-tasks.ts`, `server/a2a.ts` |
| 8.9 | A permission classifier: an authority that puts each tool call to a model against the app's policy, and fails closed | built | `classifier.ts` `permissionClassifier` |

## 9. Evals and observability

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 9.1 | OpenTelemetry GenAI spans, trace context in and out | built | `harness/trace.ts` |
| 9.2 | Attribute names per the current registry (`cache_read`, `cache_write`, `reasoning`) | built | `builtin.ts` |
| 9.3 | Eval suites with code and model graders, repeated trials, `pass@k`/`pass^k`, CI exit code | built | `src/eval/`, `praecise eval` |
| 9.4 | Provenance graph of a run | built | `workflow/provenance.ts` |
| 9.5 | Eval cases captured from recorded exchanges and replayed against the tool results they met | built | `eval/replay.ts`, `praecise capture`. A workflow case is compared to its recorded result; its steps run again. |
| 9.6 | A sample of live answers scored after they are returned, reported on the trace and through `notify` | built | `eval/online.ts`, `EvaluationSpec.online` |
| 9.7 | A scripted model for an app's own tests, with no network | built | `@praecise/harness/testing` |

## 10. Protocols

Versions are the latest published as of 2026-11-13.

| # | Protocol | Version | Status | Where |
| --- | --- | --- | --- | --- |
| 10.1 | MCP, client and server: stateless, `server/discover`, `Mcp-Method`/`Mcp-Name`, `resultType`, `ttlMs`/`cacheScope` | 2026-07-28 | built | `harness/mcp.ts`, `server/mcp.ts` |
| 10.2 | MCP Tasks extension, with task state pushed over `subscriptions/listen` | 2026-07-28 | built | `server/mcp-tasks.ts`, `harness/mcp.ts` |
| 10.3 | MCP OAuth: PKCE, resource indicators, issuer validation, step-up; Client ID Metadata Documents with dynamic registration as fallback; client credentials; enterprise-managed authorization (identity assertion grant) | 2026-07-28 extensions | built | `harness/oauth.ts`. The identity assertion grant follows an IETF draft and serves one identity per service. |
| 10.4 | MCP elicitation, form and URL, answered by a handler the app supplies | 2026-07-28 | built | `AppOptions.mcp.elicit` |
| 10.5 | MCP tool lists re-read when a server says they changed | 2026-07-28 | built | `ToolSpec.watch` |
| 10.6 | Skills over MCP: an app serves its `skills/`, and reads a server's against its manifest | beta | built | `server/mcp-skills.ts`, `harness/mcp-skills.ts` |
| 10.7 | MCP Apps: a tool declares a view; as a host, views reach the front end and their calls go through the guard | 2026-01-26 | built | `server/mcp-apps.ts`. The sandboxed frame and the messages into it are the front end's. |
| 10.8 | MCP Server Card; AI Catalog | card beta, catalog draft | built | `server/discovery.ts`. The catalog's shape is provisional. |
| 10.9 | MCP roots, sampling and logging | deprecated in 2026-07-28 | declined | Not declared, so a conforming server does not ask. |
| 10.10 | MCP servers on earlier revisions | | declined | Stated in `harness/mcp.ts`. |
| 10.11 | A2A: JSON-RPC and HTTP+JSON bindings, streaming, `ListTasks`, input-required at a gate, push notifications, signed agent cards and their verification; 0.3 callers answered in 0.3 | 1.0.1 | built | `server/a2a.ts`, `server/a2a-card.ts` |
| 10.12 | A2A over gRPC | 1.0.1 | declined | Needs a second listener with TLS and a protobuf codec for the whole message set. Not listed on the card, so no client dials it. |
| 10.13 | AG-UI event names and fields; one terminal event per run; interrupts and resume for workflows | 1.0 | built | `server/agui.ts` |
| 10.14 | A2UI: an agent answers with an interface, validated and carried over A2A and AG-UI; what the person does comes back as input | 1.0 | built | `server/a2ui.ts`. No renderer; drawing is the front end's. |
| 10.15 | Agent Client Protocol: an agent served to an editor over stdin and stdout | protocol 1 | built | `server/acp.ts`, `praecise acp` |
| 10.16 | A Responses-compatible ingress: any Responses client calls an agent | 2026-04-24 | built | `server/responses.ts`, `POST /v1/responses` |
| 10.17 | CloudEvents; Standard Webhooks; AsyncAPI | 1.0.2; 1.0; 3.1.0 | built | `events.ts`, `webhooks.ts`, `server/asyncapi.ts` |
| 10.18 | Web Bot Auth | draft-01 | built | `botauth.ts` |
| 10.19 | Agent Skills (SKILL.md), and the skills discovery index | index 0.2.0 | built | `project/skills.ts`, `registry/` |
| 10.20 | Payment on 402 through a `payer`, idempotent per step | x402 v2 | built | `payments.ts` |
| 10.21 | `llms.txt`, `ai.json`, agent card discovery, with an agent's own catalogue metadata | | built | `server/discovery.ts`, `AgentSpec.meta` |
| 10.22 | OpenTelemetry GenAI conventions | Development | built | `harness/trace.ts` |

## 11. Extending an app

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 11.1 | Tools: MCP services over HTTP and stdio, OpenAPI documents, local functions, code mode | built | `tools/`, `functions/` |
| 11.2 | Composing apps in code: `mergeApps`, collisions reported | built | `sdk.ts` |
| 11.3 | Plugins from the config: a piece of an app, drivers, blobs, hooks, a `setup`, commands | built | `project/plugins.ts` |
| 11.4 | Packaging an app as an installable, importable package with its tool surface written down | built | `src/package/` |
| 11.5 | Skills and plugins found in an index anyone can host, checked against a digest, never run | built | `registry/`, `praecise search`, `praecise add`. No index is built in. |

## What tests do not cover

- No request has been sent from the test suite to a live model endpoint, a live
  session, a files API or a batch API: those are covered by tests against the shapes
  in the providers' documentation. `scripts/verify-wires.mjs` makes one real call per
  wire and is run by hand before a release.
- Redis and Valkey, and the PostgreSQL 18 paths, are tested against scripted servers.
  The PostgreSQL tests that need a server run where one is reachable.
- Computer use is tested against a scripted DevTools endpoint, the video decoder
  against a scripted `ffmpeg`, and the protocol servers (A2A, MCP, Agent Client
  Protocol, Responses) against their published schemas, not against other
  implementations.
- The MCP server card's endpoint field, the AI catalog's shape and the A2UI encoding
  over AG-UI follow documents that are still drafts or leave the detail open.
