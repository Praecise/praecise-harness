# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
from 1.0.0 onwards. Before 1.0.0, the shape of the public API is still being
settled; that is what the entry below is.

## [Unreleased]

### Added

**Protocols.** The current MCP revision, `2026-07-28`, on both the client and the
server, with no dual-era fallback — it is a stateless protocol, so the
`initialize` handshake, session header, standalone GET stream, `ping`,
`logging/setLevel` and SSE resumability are gone, and every request carries its
own version, capabilities and identity. A2A 1.0 publishes the app as an agent a
peer can delegate to, with an agent card at `/.well-known/agent-card.json`.
AG-UI streams to whoever is watching: `?protocol=ag-ui` on any agent endpoint,
with `?stream=` selecting `messages`, `tools`, `updates`, `custom` or `values`.

**OAuth 2.1** for MCP servers that are protected resources, with the parts that
exist because of an attack rather than a feature: resource indicators (RFC 8707)
on both the authorization and token request, byte-exact issuer validation
(RFC 9207), PKCE, and registrations keyed by issuer so one is never presented to
a server that did not mint it.

**OpenAPI descriptions become tools.** `tool({ openapi })` is a third kind of
service alongside `url` and `command`; operations are flattened into the single
object a model produces, and the location of each value is remembered rather
than guessed at call time.

**An SDK door.** `createApp` takes an app as a value rather than reading a
folder, for shipping agents in a package, running where there is no filesystem to
scan, or assembling an app from parts. `mergeApps` composes definitions and
reports collisions instead of letting one silently disappear. Both doors build the
same project and run the same checks.

**A TypeScript build step.** Every `.ts` file is compiled into `.praecise/build`
before anything is imported, using the compiler in your own project, so a
TypeScript app runs on a Node that cannot read TypeScript. One broken file costs
you that file rather than the whole app.

**Discovery, for machines.** `/llms.txt`, JSON-LD at `/ai.json`, a `robots.txt`
inverted for an app where there is little to index and much that costs a model
call, and `/ask` — an NLWeb-shaped endpoint that answers a natural-language
question from the app's own store, at a rung the operator caps.

**An ingestion pipeline.** `praecise ingest <dir> --store <name>` reads PDFs,
Word, Excel, PowerPoint, CSV, images and source into a store; `--fields` asks a
model to pull named values out of each chunk. Idempotent on content, so running
it twice does not double the catalogue.

**Tracing, forking, and a page to look at them.** OpenTelemetry GenAI spans, with
no OpenTelemetry dependency — the convention is in the data and the transport is
yours. Trace context crosses into MCP via `traceparent`. `forkRun` branches a run
from a past step, optionally patching an earlier output, recording who did it.
`praecise dev` serves `/traces`, a timeline of what the last few requests did.

**`praecise doctor`** says everything wrong with an app in one pass, ranked by
whether it stops the app running, and exits non-zero only on the blocking kind.

### Changed

- `fn`, `workflow` and `prompt` infer from what they declare. `run`'s arguments
  come from `input`, `after` only accepts step ids that exist, and a prompt's
  `{{placeholders}}` must name declared fields. Each of these was previously a
  silent runtime failure: an undeclared field arrived as `undefined`, a mistyped
  `after` produced a step that was never ready, and a mistyped placeholder
  interpolated to nothing and sent the model a sentence with a hole in it.
- `AskOptions.ceiling` caps how expensive a request may get, trimming an agent's
  ladder so escalation still works below it.

### Fixed

- `App.load` crashed with a raw `TypeError` when an agent had no `role` — the
  loader recorded the fault and then the planner destroyed the report describing it.
- `clientFor` and `collectTools` both tested for an API key alone, making stdio
  MCP servers unreachable by construction.
- The interactions wire computed a warning about silently-dropped sampling
  parameters and put it on a type nobody holds.
- `praecise init` wrote a `.ts` app that the runtime could not load.
- Store errors, resource reads, and protocol refusals now carry `cause` or a
  named error rather than a flattened string.


### Changed

- **Breaking (shape of the public API), ahead of 1.0.** The package root now
  exports the public API and nothing else. It previously exported 98 values and
  122 types, most of which were the framework's own moving parts — a planner, a
  loader, provider wire formats, MCP request handlers, the packager, the CLI
  entry point. Tagging 1.0 would have semver-locked every one of them, which
  would either be a promise the project could not keep or a freeze on its own
  insides.

  Nothing was deleted. 38 values and 16 types moved to the new
  `praecise/internal` subpath (see *Added*), so every current import keeps
  working after a one-line change to the specifier, and nobody has to fork the
  framework to reach something they genuinely need.

  Moved to `praecise/internal`: `findCycle`, `loadProject`, `resolveKnows`,
  `canConvert`, `ingestFile`, `converterFor`, `planAgent`, `planProject`,
  `planWorkflowAgent`, `schemaFor`, `adapterFor`, `chatWire`, `contentsWire`,
  `messagesWire`, `stateDirFor`, `stream`, `trim`, `asObjects`, `urlFor`,
  `checkSteps`, `provisioner`, `runCommand`, `splitCommand`, `openChannel`,
  `callPublished`, `groupsOf`, `handleMcp`, `noticesOf`, `promptsOf`,
  `resourcesOf`, `toolsOf`, `apiModule`, `apiTypes`, `faultsIn`, `hintsIn`,
  `buildPackage`, `manifestFor`, `cli`; and the types `Importer`,
  `LoadOptions`, `Converted`, `Converter`, `ConvertRequest`, `IngestOptions`,
  `PlanOptions`, `Manifest`, `ProvisionerDeps`, `Channel`, `Caller`, `McpTool`,
  `Describable`, `PackageManifest`, `PackageOptions`, `PackageResult`.

  The authoring surface, the running surface, the harness contract, the store
  and driver surface, and the dialect codec and latent transport are all
  unchanged and stay at the root.

- The `api.js` module generated by `buildPackage` now imports `callPublished`
  from `praecise/internal` rather than from the root. It is regenerated on every
  build, so it tracks whichever version of praecise built it.

### Added

- **`praecise/internal`**, a second entry point holding everything demoted
  above. It is explicitly **not covered by semantic versioning**: names there
  may change, be renamed, or disappear in any release, patch releases included,
  with no deprecation period. It exists so that necessity does not force a fork,
  not as a second API.

- **`API.md`**, the written-down public API, grouped by task — authoring,
  running, the harness, storage and driver extension, dialect and latent
  transport, observability — with one line per name and a plain statement of
  what `praecise/internal` does and does not promise.

- **`CHANGELOG.md`** (this file).

- Types that exported types already referred to but which could not be imported.
  `AgentSpec.access` is an `Access`, `WorkflowSpec.outcome` is a `Check`, and
  every published spec extends `Published`, yet none of the three were exported;
  their sibling `Effect` was, which is what makes it an oversight rather than a
  decision. Now exported: `Access`, `Check`, `Published`.

- `ProviderError`. The documented `ChatAdapter` contract says an adapter should
  throw it, and an adapter author outside this repository could not reach it.

- `ApprovalClaim` and `ApprovalDecision`, for the same reason: `WorkflowDeps`
  asks for `sign(claim: ApprovalClaim)` and `verify`, and neither type was
  importable.

- `Wire` and `wireOptionsFrom`, with their types `WireOptions`, `WireResult` and
  `Held`. They were exported from the stores barrel but omitted from the root,
  so a driver author could not reuse the Postgres wire framing.

- `Project` and `Doc` are now documented as public rather than incidental: they
  are the type of `App.project`.

- `LocalTool` and `ResolvedService` join `AgentPlan` and `Rung` at the root, so
  an `AgentPlan` — which a custom `WorkflowDeps.planFor` has to return — can be
  written down without unnameable fields.
