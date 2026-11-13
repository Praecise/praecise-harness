# The public API

Everything exported from `@praecise/harness` is listed here. From 1.0 onwards this list
is what semantic versioning covers: a name on this page will not be removed, and
its shape will not change incompatibly, without a major release.

Anything **not** on this page is not part of the promise, even if you can reach
it. In particular:

> **`@praecise/harness/internal` is unstable and unversioned.** Every name behind that
> subpath may change, be renamed, or disappear in any release, including a patch
> release. There is no deprecation period. It exists so that needing one of the
> framework's own moving parts does not force you to fork the framework — not as
> a second API. If something you genuinely need is only reachable there, please
> open an issue; that is a gap in the surface below.

Deep imports (`@praecise/harness/dist/...`) are not reachable at all. The package's
`exports` map has exactly five entries: `.`, `./internal`, `./formats`,
`./testing`, and `./package.json`. `@praecise/harness/formats` and
`@praecise/harness/testing` are public and are listed [below](#praeciseharnessformats).

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
| `hooks` | Declare what happens after a tool runs, before an agent stops, before a transcript is summarised, and before a self is sent its record (`hooks.ts`). |
| `middleware` | Wrap every call the app makes. |
| `knowledge` | Declare a document the app knows, in code rather than in `memory/`. |
| `blueprint` | Declare a set of files that scaffolds a whole app. |
| `template` | Declare a set of files that scaffolds one part of one. |
| `evaluation` | Declare an eval suite: an agent or workflow, cases, and what a right answer looks like. |
| `defineConfig` | The contents of `praecise.config.ts`. |
| `QUALITIES` | The ladder rungs, in order: `fast`, `balanced`, `best`. Frozen. |

**Narrowing a step.** A `Step` is a union; these tell you which arm you have.

`isAsk` · `isUse` · `isApprove` · `isWait` · `isPlan` · `isEach` · `isRepeat` · `isWhen`

Each asks whether the step carries that discriminant as its OWN key with a value
that is not `undefined` — so `{ ask: cond ? "x" : undefined, use: "svc.fallback" }`
is a `use`, and a key inherited from a prototype does not classify anything.
`STEP_KINDS` is the same eight names in the order the runner dispatches them, and
`kindsOf(step)` returns the ones a step carries. A step carrying more than one is
refused when the workflow loads: nothing can tell which was meant, and guessing is
how a nested body came to be validated, reported, and never run.

**Types.** One `*Spec` per kind (what the call returns) and one `*Input` per kind
(what you pass it):

`AgentSpec`/`AgentInput` · `WorkflowSpec`/`WorkflowInput` ·
`ToolSpec`/`ToolInput` · `FunctionSpec`/`FunctionInput` ·
`PromptSpec`/`PromptInput` · `ResourceSpec`/`ResourceInput` ·
`StoreSpec`/`StoreInput` · `GuardSpec`/`GuardInput` ·
`MiddlewareSpec`/`MiddlewareInput` · `KnowledgeSpec`/`KnowledgeInput` ·
`BlueprintSpec`/`BlueprintInput` · `TemplateSpec`/`TemplateInput` ·
`EvaluationSpec`/`EvaluationInput` · `HooksSpec`/`HooksInput`

An authored skill (`skills/<name>/SKILL.md`) has no call of its own; in a
code-defined app it is `AuthoredSkillInput`, and loaded it is `AuthoredSkill`.

Supporting types:

| Type | What it describes |
| --- | --- |
| `Published` | What every published thing declares: `access`, `effect`, `group`. |
| `Access` | Who may reach it: `"open"`, `"gated"`, `"internal"`. |
| `Effect` | What calling it does: `"read"`, `"write"`, `"destructive"`. |
| `Step` | The step union, and its arms `AskStep`, `UseStep`, `ApproveStep`, `WaitStep`, `EachStep`, `WhenStep`, `RepeatStep`, `PlanStep`. A `WaitStep` stops a run until a CloudEvent of the `wait` type arrives, narrowed by `source` and `subject`, with a `timeout` in seconds and `onTimeout: "fail" \| "continue"`. |
| `Check` | What a `repeat` runs until, and what a workflow's `outcome` asserts. |
| `Ref` | A reference into the run's scope, written as text. |
| `Returns` | A declared output shape: field names to plain-English hints, a JSON Schema object, or a Standard Schema validator. `DataOf<Declared>` is what `answer.data` is for one. |
| `Quality` | One rung of the ladder. |
| `Limits` | Ceilings a run inherits: `depth`, `concurrency`, `timeout`, `budget`, `calls` (model calls one request may make), `spend` (a `Money` one run may spend, counted from declared `prices`), and how patient to be with an endpoint that is merely busy — `retries` (default 2) and `retryDelay` (default 200 ms, doubling with jitter). |
| `Money`, `Prices`, `Rates` | An amount in a named currency; what an endpoint charges per rung (`prices` on a model endpoint); and what a million tokens cost on one model (`input`, `output`, `cachedRead`, `cacheWrite`, `reasoning`). |
| `AgentMeta` | `meta` on an agent: `version`, `tags`, `languages`, `inputModes`, `outputModes`, `examples`, and anything else, for the surfaces that list the agent. |
| `FunctionRunOptions`, `Publish` | The second argument of a function's `run`: `idempotencyKey`, `run`, `step`, `fetch`, `approvals`, `signal`, `publish` (a `Publish`, which puts an event on the app's bus), `transcript`, `caller` and `context`. |
| `ToolOutcome`, `Stopping`, `Compacting`, `AfterTool`, `BeforeCompact` | What each hook is handed, and what `afterTool` and `beforeCompact` may answer. |
| `OnlineEval`, `RecordedRun`, `RecordedTool` | `online` on an eval suite (`sample`, `expect`, `threshold`), and the recorded run a captured case carries (`answer`, `data`, `tools`). |
| `ServiceOAuth` | `oauth` on a service: the `client_credentials` or `id-jag` grant its token is obtained with. |
| `RecordOf`, `RecordInputOf`, `TypedStoreSpec` | The record a store's `schema` describes, what it accepts on the way in, and a store declared with one. |
| `Recent` | One entry of `Attempt.recent`: something the person said, or a call the agent made. |
| `MemorySpec` | What an agent remembers, and where. |
| `AppConfig` | The `praecise.config.ts` shape. |
| `Provider`, `ModelProvider` | An endpoint the app may call: `url`, `credential`, and three fields for an endpoint with needs of its own — `credentialHeader` (the header the credential goes in, where a bearer is refused), `headers` (sent with every request, and applied last), and `body` (fields merged into the request that the protocol does not name; what the request itself asks for always wins). |
| `Call`, `Reply`, `Attempt` | What middleware and guards are handed. |
| `FileContents` | One file a blueprint or template writes. |
| `StoreKind` | Which kind of store a `store()` declares. |
| `StepKind` | One of `STEP_KINDS`. |
| `Preference` | `preference` in the config: `"cost"`, `"balanced"` (default) or `"quality"` — what the deployment values when cost and quality pull apart. Under `"quality"` the strongest rung answers and nothing is checked. |
| `EvalCase`, `Grader`, `GraderKind`, `GRADER_KINDS` | One case of an eval (`name`, `input`, `expect`, `budget` in tokens or money, `recorded`), the graders it may expect (`contains`, `excludes`, `matches`, `equals`, `fields`, `calls`, `avoids`, `judge`, `reference`, `check`), and their names. |
| `CodeModeSpec` | `code` on an agent: `silo`, `language` (`typescript`, `javascript`, `python`), `ttl` (seconds, default 1800) and `allow`. See [Code mode](#code-mode). |

## Running — loading a folder and driving it

| Name | What it does |
| --- | --- |
| `App` | Load a folder into a running app. `App.load({ root })`. |
| `AppOptions` | What `App.load` accepts: root, env, fetch, drivers, telemetry sink, and the seams listed on this page — `embedder`, `reranker`, `blobs`, `approvals`, `authority`, `journal`, `payer`, `botAuth`, `notify`, `runCipher`, `threads`, `memory`, `sandbox`, `tracer`, `recorder`, `selves`, `mcp`, `meter`, `WebSocket`. |
| `startRun` | Start a workflow run. |
| `resumeRun` | Resume one that stopped at a human approval gate. |
| `cancelRun` | Stop a run and record it as `cancelled`. `App.cancelWorkflow(id, { reason, by })` is the same over a loaded app. |
| `signalRun`, `timeoutRun`, `awaits` | Continue a run stopped at a `wait` step with the event it awaited, end a wait that ran out of time, and say whether a run is waiting for a given event. `App.signal(event)` and `App.expire()` are the same over a loaded app. |
| `subscriptionsOf` | The CloudEvent types a workflow's `on` names. `App.publish(event)` starts a run of every workflow that declared the type and continues every run waiting for it. |
| `clock`, `cronNext` | A `Source` that ticks every so many seconds or by a five-field cron expression in a time zone, for `App.follow`; and the next time an expression falls due. Types: `ClockOptions`, `Schedule`, `Tick`. |
| `recoverRun` | Re-drive a run that was interrupted, refusing where exactly-once cannot be proven. |
| `RunStore` | Where runs are persisted, and how they are listed and loaded. |
| `serve` | Bring up the dev server: chat UI, REST, and an MCP endpoint. |
| `serveStdio` | Serve the app over MCP on stdio, for an editor or another agent. |
| `followRun` | Async-iterate a run's events, from the start and then as they arrive. |
| `provenanceOf` | Build the graph of what a run derived from what. |
| `createApp` | An app described in code (`AppDefinition`) rather than a folder, ready to run. Refuses a faulted definition. |
| `defineApp` | The same definition checked into a `Project` without starting it, so `warnings` and `faults` can be read first. |
| `mergeApps` | Compose definitions; later ones win, and every collision is reported in `collisions`. |
| `cloudEvent`, `readCloudEvents`, `CLOUDEVENTS_JSON`, `CLOUDEVENTS_BATCH` | Mint a CloudEvents 1.0 event; read the events an HTTP request carries (structured, batched or binary), or a sentence saying why it carries none; and the two media types. `App.deliver(workflow, event)` continues the run of that workflow waiting for the event, or starts one, once per `source` + `id`. |
| `App.replace`, `App.add`, `App.remove` | Replace an agent of a running app, add one, or remove one by name. Requests under way finish on the plan they started with. |
| `App.askMany` | Many questions for one agent through the endpoint's batch API; a `Batched` (`{ answer }` or `{ error }`) per question, in order. |
| `App.open` | Open a live session with an agent (`OpenOptions`), returning a `Session`. |
| `App.capture`, `App.settled` | Eval cases from an agent's recordings or a workflow's runs; and a promise for the recording and scoring already begun. |
| `App.approvalOf` | Verify a person's decision on a `StepUp`, for `AskOptions.approve` to return. |
| `App.onRunChange` | Hear each `RunTransition` in this process; returns the function that stops listening. |
| `App.blobs`, `App.threads` | The app's `BlobStore` and its conversations. |
| `runEvaluation`, `runEvaluations` | Run one eval suite, or several, against anything that can ask an agent and run a workflow. `App.evaluate(suite?, options)` is the same over a loaded app. |
| `evaluationFaults` | What is wrong with an eval suite as written. |
| `renderReport` | An `EvalReport` as the table `praecise eval` prints. |
| `Recordings`, `casesFromRecordings`, `casesFromRuns`, `renderCapturedSuite` | Exchanges kept as they occurred (`record: true` in the config, or `AppOptions.recorder`), eval cases made from them or from a workflow's runs, and a suite file written from those cases. Types: `Recorder`, `Recording`, `ReferenceMode`. |
| `recordingTape`, `replayTape`, `redacted` | A `ToolTape` that writes a request's tool calls down, one that answers them from a recording, and a recording with credentials taken out. |
| `scoreAnswer`, `evaluationSpan`, `EVALUATION_EVENT` | Score one live answer with a suite's `online` graders (`OnlineScore`), the span that carries the score, and the name of its event, `gen_ai.evaluation.result`. |
| `EVAL_EVENT_TYPES`, `evalEvent`, `EvalNotice` | The notification sent when a live score falls below its threshold (`com.praecise.eval.below`), as a CloudEvent. |
| `DISCOVERY_SCHEMA`, `WELL_KNOWN_SKILLS`, `indexUrlOf`, `parseIndex`, `searchEntries` | Reading a registry: the discovery schema followed, the well-known path of an index, the index URL for a registry as configured, an index parsed into `RegistryEntry` rows, and a search over them. |
| `fetchSkill`, `installSkill`, `installCommand`, `recordPlugin`, `readRecordedPlugins`, `readRegistries`, `PLUGINS_FILE` | Installing from a registry: fetch a skill and check its digest (`FetchedSkill`), write it to `skills/<name>/`, the install command for a plugin, record a plugin in `praecise.plugins.json` (`RecordedPlugin`), and read that file and the configured registries. |
| `unpackArchive`, `safeRelativePath` | Unpack a skill archive within limits (`ArchiveFile`, `ArchiveLimits`), and refuse a path that would leave the folder it is written to. |

Types: `Run`, `RunStatus`, `RunEvent`, `PlanVersion`, `Outcome`, `ProvGraph`,
`WorkflowDeps`, `GenAiSpan`, `ProvisionRequest`, `ProvisionResult`, `ApprovalClaim`,
`ApprovalDecision`, `VerifyResult`, `DevServer`, `ServeOptions`,
`StdioServer`, `StdioOptions`, `Project`, `Doc`, `AgentPlan`, `LocalTool`,
`ResolvedService`, `Rung`, `AppDefinition`, `Approvals` (the shape of
`AppOptions.approvals`: the signer and verifier for gates), `EvalOptions`,
`EvalReport`, `SuiteReport`, `CaseReport`, `TrialReport`, `EvalTarget`,
`EvalJudge`, `CloudEvent`, `Plugin` (what `plugins` in the config takes:
`name`, `commands`, `app`, `hooks`, `drivers`, `blobs`, `setup`; `CliPlugin` is
its earlier name), `ToolContext` (what a `LocalTool`'s `run` is handed besides its
arguments: the transcript so far and the request's signal), `AwaitedEvent`
(what a run stopped at a `wait` step is waiting for).

`RunStatus` includes `cancelled`. `Span` carries `events` (`SpanEvent`).

An `AgentPlan` also carries `delegates` (other agents named in `tools`), `turns`
and `advisor`. A `Rung` carries `levels`, `output` and `cache` where the provider
declared them.

`Project` and `Doc` are what `App.project` is. `AgentPlan` is what an agent was
compiled into — the composed instructions, the rungs to try, the tools it may
call — and is what a custom `WorkflowDeps.planFor` must return.

`ApprovalClaim` is exactly what an approval signature covers; implement
`WorkflowDeps.sign`/`verify` against it. With no signer, nothing is
synthesised — the ledger records the approval as unsigned rather than inventing
a signature.

## Acting under rules — actions, authority, payments, journal

What an app needs when its agents act for someone under rules it does not write
itself. Every piece is optional and off until passed to `App.load`.

| Name | What it does |
| --- | --- |
| `Action` | A side effect in checkable terms: operation, counterparty, amount, asset, network, model, detail; `tainted` is set by the runtime. A function declares one with `action(args)`. |
| `Trust` | `"trusted"` or `"untrusted"` on a function (`trust`) or a service (`ToolSpec.trust`, default untrusted). Reading untrusted output taints every later action in that conversation or run. |
| `Authority`, `Verdict` | `AppOptions.authority`: `check(attempt)` answers a `Verdict` — `allow`, `refuse` or `stepUp` with a digest. Asked after the guard on every path to a tool. |
| `StepUpRequired` | What a direct call throws on `stepUp`. A workflow `use` step turns it into a gate named `<step>:approve` whose signed `ApprovalClaim` carries the `digest`; the call is asked again with the verified approval (subject, digest, signature) in `Attempt.approvals`, and a local function receives the same list as `opts.approvals` (`FunctionRunOptions`, each a `VerifiedApproval`) to present onward. In a conversation it is a refusal the model reads. |
| `Journal`, `Signer`, `JournalSink` | `AppOptions.journal`: every finished `ask` and `use` step is sealed as a `JournalEntry` (input and output digests, action, approvals, payments, evidence, sandbox snapshot), hash-chained, signed when a signer is given, recorded on the run, then delivered to the sink, which may return an anchor. A sink failure fails the run; recovery re-delivers. |
| `verifyJournal` | Check sealed entries: numbering, chain, hashes, and signatures when given a verifier. |
| `seal`, `SealedEntry` | Hash a `JournalEntry` and sign the hash when there is a signer. |
| `canonicalJson`, `digestOf` | JSON with keys sorted at every depth, and the digest over it, so equal values hash equally. |
| `Payer`, `payingFetch`, `withPaymentKey` | `AppOptions.payer`: a 402 met by the app's fetch is paid under a key derived from the step's idempotency key, asking `status(key, required)` first so a retried step reuses a settled payment, presented the way that server asked for it. Local functions receive the app's fetch as `opts.fetch`. Types: `PaymentRequired`, `Paid`, `PaymentStatus`, `PaymentRecord`. |
| `Sandbox` | `AppOptions.sandbox`: `snapshot` after each journalled step (named on the entry), `restore` of the latest before `recoverRun` drives a crashed run. |
| `RunCipher` | `AppOptions.runCipher`: run files sealed at rest; plaintext files are refused rather than read. |
| `StateCipher`, `isCipher` | The same two operations, for `AppOptions.threads` and `AppOptions.memory`: conversations and what agents remember into files, sealed at rest. |
| `Conversations`, `Threads`, `Folder` | Where conversations are kept: the interface a backend implements (`load`, `append`, `list`, `forget`), the app's own, and the one that keeps them as files. Types: `Thread`, `ThreadSummary`, `Turn`. |
| `permissionClassifier` | An `Authority` that reads a policy written in prose against each call by asking a model: allow, deny, or ask a person. Refuses when it cannot decide. Types: `ClassifierOptions`, `Classified`, `Decision`. |
| `Meter`, `MeterRefused`, `CallLimitReached`, `estimateOf` | `AppOptions.meter`: `reserve(call)` is asked before every model call and refuses with a sentence; `settle(call, usage)` is told what it took. `MeterRefused` is what a refused request ends in, `CallLimitReached` what one past `maxCalls` ends in. Types: `MeteredCall`, `MeteredUsage`, `CallPurpose`. |
| `AskCaller` | Who a request is for: `person`, and anything else the app adds. Carried with `context` to the guard, the authority, functions and the meter, and to no model. |
| `StepUp` | What `AskOptions.approve` is asked: the call the authority allows only with approval, and its `digest`. |
| `outboundFault`, `privateAddress` | Whether an address a caller supplied is one this process should request: `https`, and not private or loopback unless its host is allowed (`OutboundOptions`). |
| `postWithRetries` | The retrying POST webhooks are delivered with. |
| `Source`, `SourceEvent`, `App.follow` | Durable triggers: one run per event, the cursor stored after each (`CursorFile` keeps it between runs of the process), a re-delivered event finding the run it already started (`runIdFor`). |
| `CliPlugin` | `plugins` in the config: commands reached as `praecise <plugin> <command>`. |
| `ChatResponse.evidence` | A wire may return proof of what it ran; it is collected on `Answer.evidence` and carried into the journal. A wire that requires it refuses a reply without it. |

## The harness — models, memory, and adapters

| Name | What it is |
| --- | --- |
| `BuiltinHarness` | The harness that ships with the framework. |
| `resolveHarness` | Pick a harness from config and credentials. |
| `Harness` | The interface a harness satisfies. Implement it to replace ours. |
| `ChatAdapter` | `(request: ChatRequest) => Promise<ChatResponse>` — one provider. |
| `ProviderError` | What an adapter throws when a provider refuses or fails. Throwing this rather than a bare `Error` is what lets the ladder tell a retryable failure from a fatal one. |
| `Memory`, `StoredMemory` | Episodic memory, on files or in a declared store. |
| `Origin`, `Note`, `authorityOf`, `settle` | Where a memory came from (`user`, `tool`, `agent`, `external`), a durable note and the exchanges it was drawn from, the authority a derived note may carry (the minimum of its sources), and how two contradicting notes are settled: authority first, then recency. Deciding that two notes conflict is the app's call, which is why `settle` is exported. |
| `SkillBook`, `usableProcedures`, `renderSkills` | Procedural memory: what the app has learned how to do, and what of it is worth putting in context now. |
| `Ledger` | The record of routing decisions, and what they cost. Every row carries the `propensity` of the choice it records; without that the log answers "was this escalation worth it" and nothing else. |
| `route`, `difficultyOf` | Where a request starts and how hard it looked. Difficulty counts the conversation, the choice of tools, and how much has to be read — not the length of the question. |
| `riskOf` | How likely a request is to be got WRONG, which is a different axis from how hard it is. Question length lives here: it predicts failure after difficulty is controlled for, so it widens the margin at which an answer is checked instead of moving which model answers. |
| `verifyMarginFor` | How much band-headroom is close enough to be worth checking: `VERIFY_MARGIN` at rest, widening with risk and stakes. |
| `ladderFrom` | The depths to ask one rung for, in order, before crossing to another model. At most three, because that is how many an endpoint can tell apart. |
| `attach` | Return something other than text from a function: `attach(result, ...attachments)`. |
| `registerReader`, `knownReaders` | Teach the framework to show a kind of data to a model, by media type, and list the readers registered. A `Reader` is handed the attachment and its text, and returns what the model should read. Later registrations are asked first. |
| `embedderFor` | The `Embedder` for the first reachable endpoint in `models` that names an `embeds` model, or nothing. `AppOptions.embedder` takes your own. |
| `rerankerFor` | The `Reranker` for the first reachable endpoint that names a `reranks` model, or nothing. `AppOptions.reranker` takes your own. |
| `registerDecoder`, `knownDecoders`, `show` | Teach the framework to take apart media an endpoint cannot be sent (a `Decoder` answers a `Decoded`: stills and sound), list the decoders registered, and work out what a model is shown for a set of attachments (`Showing`). |
| `ffmpegDecoder` | The decoder that ships, for video, over an `ffmpeg` binary the app names. Types: `FfmpegOptions`, `FfmpegRun`. |
| `Uploads`, `registerUploader`, `knownUploaders`, `send`, `bearer` | The cache that uploads a large attachment once through an endpoint's files API, the registry of how each shape stores a file (`Uploader`), and the transport an uploader is written over. Types: `Endpoint`, `UploadSetting`, `Uploaded`, `Uploading`, `UploadsOptions`. |
| `Batcher`, `Seat`, `registerBatch`, `knownBatches`, `requestOf`, `replyOf` | What hands many requests to an endpoint's batch API, the registry of how each shape takes a batch (`BatchDriver`), and the request and reply of one item. Types: `Asking`, `Batch`, `Batched`, `BatchItem`, `BatchOptions`, `BatchResult`. |
| `LiveSession`, `registerSession`, `knownSessions`, `sessionFor`, `realtimeSession`, `liveSession` | A live session as `App.open` returns it, the registry of session protocols by name (`SessionOpener`), and the two that ship. `connect`, `Events`, `frameText` and `socketBase` are what an opener is written over. Types: `Session`, `SessionEvent`, `SessionInput`, `SessionAudio`, `SessionRequest`, `SessionFaculties`, `OpenOptions`, `WireSession`, `Line`, `Socket`, `SocketConstructor`. |
| `amountOf`, `priceFor` | Arithmetic over the prices an endpoint declared: what some usage cost, and the price of one model. Types: `Cost`, `Price`. |
| `composeHooks`, `SENT_BACK` | Several sets of hooks as one, and how many times `beforeStop` may send an agent back in one conversation. |
| `computer`, `computerTool`, `browserScreen` | A screen as a function an agent calls, the tool underneath it, and the screen that ships: a browser. Types: `Screen`, `BrowserScreen`, `BrowserScreenOptions`, `ComputerOptions`, `Button`, `ScreenPoint`, `ScreenRegion`, `NativeTool`. |
| `ToolTape` | `AskOptions.tape`: hears a request's tool calls, or answers them in place of the tools. |
| `EXPLORATION` | The share of routing decisions worth randomising (2%) so the record can be read back. Set it as `explore` in `praecise.config.ts`; off unless you do. |

Types: `ChatRequest`, `ChatResponse`, `Message`, `ToolCall`, `ToolSchema`,
`Answer`, `AskOptions`, `Progress`, `Usage`, `Routing`, `Episode`,
`Recollection`, `Attachment`, `Stop`, `Embedder`, `Delegate`, `Kind`, `Reader`,
`UiView`.

An `Attachment` may carry `fileId` (the name an endpoint gave bytes uploaded to
it) and `blob` (where the bytes are kept in the app's blob store). `Usage`
reports `cost`, by currency, where the endpoints that answered declared
`prices`, and `unpricedTokens` where some did not. `Answer` is generic in its
`data`, and carries `ui` (the `UiView`s tools brought with their results).
A `ModelProvider` may also declare `reranks`, `uploads`, `batch`, `realtime`,
`computer` and `prices`.

A `Message` of any role may carry `attachments`: what was sent with a question, or
what a tool returned with its result. `ChatResponse.attachments` and
`Answer.attachments` are what a model made that is not text. A model endpoint's
`takes` says which of `image`, `audio`, `video`, `document` it can be sent.
`McpCallOptions.media` is where an MCP tool result's images, audio and files are
handed over.

`Usage` reports `cacheWriteTokens` and `reasoningTokens` where an endpoint
reported them. `ChatResponse.stop` is why a reply ended in one vocabulary on every
wire (`end`, `tools`, `length`, `refusal`, `filter`, `paused`, `error`);
`finishReason` keeps the endpoint's own word. `ChatResponse.replay` and
`Message.replay` carry what an endpoint wants handed back with tool results (its
reasoning), opaque to everything but the wire that wrote it. `ChatRequest` gains
`levels`, `stable` (how much of the start of `system` is the same on every
request) and `cache`. `ProviderError.retryAfter` is how long the endpoint asked to
be left alone, in milliseconds.

**`AskOptions`**, what `App.ask(agent, input, options)` and `Harness.ask` take:

| Field | What it does |
| --- | --- |
| `task` | What the request is about when the input carries more than the question (grounding, retrieved passages). A self looks up its memory by it and records it as the work. Defaults to the input. |
| `history` | Prior turns, oldest first, when the caller keeps its own. |
| `thread` | The conversation this belongs to; naming one reads back what was said and adds what is said now. |
| `signal` | Cancels the request. |
| `onProgress` | Called with each `Progress` event as the work happens, which also lets the answer arrive in fragments where it can. |
| `ceiling` | The most expensive rung (`Quality`) this request may reach. It trims the agent's declared ladder and never raises it, so the router still escalates below it. Where it would leave nothing, the cheapest declared rung is kept. |
| `floor` | The cheapest rung this request may start on: for re-asking after a cheap answer was rejected, so that model is not asked again. It can only remove rungs the agent declared, never add one, and is clamped to the ceiling: a floor above the ceiling gets the ceiling, never an empty ladder. Where it would remove every remaining rung, the dearest one left is kept. |
| `trace` | The trace this request is already part of, so its spans join it. |
| `tainted` | Start the request already tainted: something untrusted was read before it began. |
| `caller`, `surface`, `background` | Who the request is for (`caller.person`), where it comes from, and whether nobody is waiting on it. Read by selves. `caller` is an `AskCaller` and may carry anything else the app wants its guard, authority, functions and meter to see. |
| `context` | Whatever else the app sends with the request. Never read by the framework, shown to a model, or written to a trace or a recording; handed on with `caller`. |
| `allow` | `{ tools?, knows? }`: narrow what the agent may call and what stays in its instructions, for this request. It only takes away, and a name the agent does not have is an error. |
| `maxCalls` | The most model calls the request may make, counting every one. Reaching it ends the request with `CallLimitReached`. Defaults to `limits.calls`. |
| `steer` | Called before each step the agent takes; what it returns is put to the agent as further turns of the caller's. |
| `tools` | `LocalTool`s that exist for this request only, beside the agent's own. |
| `approve` | Asked when the authority says a call needs a person's approval; answers with a `VerifiedApproval` or the sentence the model should read. |
| `tape` | A `ToolTape` that hears, or answers, this request's tool calls. |
| `attachments` | Images and documents sent with the question: `{ mime, data? , url?, name? }`. They belong to this request and are not kept with a named conversation. |
| `depth` | How many agents deep the request already is. Set by the runtime when one agent asks another. |

**Provider wires.** An endpoint's `speaks` names a request shape, and each shape is a
`ChatAdapter`:

| Name | What it is |
| --- | --- |
| `chatWire`, `messagesWire`, `contentsWire`, `responsesWire`, `interactionsWire` | The shapes that ship. |
| `adapterFor` | The adapter registered for a shape. |
| `registerWire`, `knownWires` | Teach the framework a new shape (replacing a built-in is refused), and list what is registered. |

A `chat` endpoint that ignores `stream: true` and answers with one buffered JSON
completion is read as such: the stream is parsed only when the response is
`text/event-stream`, and a streaming caller then receives the whole text at once.

**Clocks on every wire.** A streamed answer is watched between frames — the
clock starts again at every frame, so a long answer arriving steadily is never cut
off (`PRAECISE_WIRE_IDLE_MS`, default 45000). One that arrives in one piece is
watched as a whole (`PRAECISE_WIRE_TOTAL_MS`, default 240000). A timeout arrives as
a `ProviderError` with status `0`, so the ladder crosses to the next model rather
than asking the silent endpoint again, and a caller's own `signal` still cancels.
On the `chat` wire a stream that stops after some text has arrived keeps that text,
with `finishReason: "timeout"` and the reason in `notes`.

### Selves

| Name | What it is |
| --- | --- |
| `self` on `agent()` | The self an agent is: a handle, or `{ handle, surface?, template?, record? }`; `{person}` in a handle makes a self per person. `record` decides what the self is sent after an answer. |
| `selves` in `defineConfig` | Where selves live: `url`, `credential`, `adminCredential`, `ticketCredential`, `surface`, `required`, `timeoutMs`. |
| `selvesOverHttp` | The provider for the HTTP self protocol. |
| `SelfProvider` | The interface a provider satisfies: `context`, `record`, `outcome`. Pass one as `selves` in `AppOptions`. |
| `signTicket`, `openTicket` | Bind a ticket to a person, and check that binding. |
| `App.rate` | A verdict on an answer a self gave, with the ticket the answer carried, and optionally a mechanical `check`. |

Types: `SelfDeclaration`, `SelfTemplate`, `SelfContext`, `SelfVerdict`, `SelfCheck`,
`AnswerSelf`, `HttpSelvesOptions`, `RecordSelf`, `SelfWork`, `SelfRecording`.
`AskOptions` gains `caller`, `surface` and `background`; `Answer` gains `self`;
`Progress` gains `self`.

`PROTOCOL_VERSION` is the MCP protocol revision this framework speaks.

### Services: MCP, OpenAPI and code mode

| Name | What it is |
| --- | --- |
| `McpClient`, `mcpRequest`, `mcpHeaders` | A client for an MCP server, and the builders for a conforming request. |
| `collectResources` | Read the resources an agent's services were told to attach, rendered as knowledge. |
| `Unauthorized` | Thrown when a server will not answer without a token; it carries the challenge the OAuth flow starts from. |
| `ApiClient` | An OpenAPI-described HTTP API presented with the same shape as an MCP client. |
| `ToolSource` | What the harness needs from a service, whichever protocol it speaks. |
| `operationsFrom`, `toolsFrom`, `requestFor`, `callOperation` | Read a document into operations, turn them into tool schemas, build the request for one (to inspect or approve before it leaves), and call it. |
| `operationName`, `baseUrlOf`, `resolveRefs` | A stable tool name for an operation, a document's base URL (OpenAPI 3 and Swagger 2), and local `$ref` resolution. Remote refs are not fetched. |
| `McpHost`, `Elicit`, `clientCapabilities` | `AppOptions.mcp`: `elicit.form` and `elicit.url` answer a server that asks a person for something mid-call, and `apps` says a front end renders the views tools bring. `clientCapabilities` is what is declared to a server as a result. Types: `FormElicitation`, `UrlElicitation`, `ElicitResult`, `ElicitedValue`. |
| `InputRequired`, `elicitedFault` | What a call ends in when a server asks for input nothing can give, and what is wrong with an answer to a form. |
| `McpSubscription`, `McpSubscriptionFilter`, `McpNotification` | A `subscriptions/listen` stream: what `watch: true` on a service holds open, and how a task's changes arrive. |
| `collectSkills`, `serviceSkillTool`, `READ_SERVICE_SKILL` | The skills a service serves (`skills` on a service), and the `read_service_skill` tool an agent reads them with. Types: `McpSkill`, `McpSkillFile`, `OfferedSkill`. |
| `uiOf`, `UI_MIME`, `McpToolUi`, `McpToolResult` | The interactive view a tool declares, the media type of its page (`text/html;profile=mcp-app`), and a tool result as a service returned it. |
| `SKILLS_EXTENSION`, `UI_EXTENSION`, `CLIENT_CREDENTIALS_EXTENSION`, `ENTERPRISE_AUTH_EXTENSION` | The names of the MCP extensions spoken. |

Types: `McpResource`, `McpResourceContents`, `McpPrompt`, `McpPromptResult`,
`McpProgress`, `McpRequestOptions`, `McpCallOptions`, `McpCompletion`, `Operation`,
`Where`, `CollectOptions`.

#### Code mode

`code: true` (or a `CodeModeSpec`) on an agent replaces its per-operation tools with
one `code` tool. The agent's HTTP services are described to the model as a typed API
— an MCP server as `tools.<service>.<tool>(args)`, an OpenAPI service as
`tools.<service>.request({ method, path, query, body })` with its document in
`spec.<service>` — and the program runs in a Praecise Silo with the services bound in
and their credentials kept outside it. A service launched as a local program stays an
ordinary tool.

| Name | What it is |
| --- | --- |
| `CODE_TOOL` | The name of that tool: `"code"`. |
| `SiloExecutor` | The `code` tool's runner: one silo per agent, created on first use, kept for its `ttl`, created again once it expires. |
| `bindingsFor` | Which services can be bound into a silo, and how (`Binding`). |
| `typesFor`, `tsType` | The declarations the model reads, one namespace per bound service, and a TypeScript type for a JSON Schema. |
| `codeTool` | The `code` tool's schema, with those declarations in its description. |

`allow` narrows what a program may call, per service: tool names for an MCP server,
`"METHOD /path"` patterns (with `*`) for an OpenAPI service. A service not named may
be called for anything it offers. The silo enforces the rules and logs every call.
The silo is addressed by `silo`, else `PRAECISE_SILO`, else its local socket; an
`https://` address is reached with the token in `PRAECISE_SILO_TOKEN`.

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
| `redisDriver`, `Resp`, `RespError`, `respOptionsFrom` | The Redis and Valkey driver (`redis://`, `rediss://`, `valkey://`), and the RESP client it is written over, reusable by a driver that speaks it. Types: `RespOptions`, `RespReply`. |
| `fuse` | Several orders of the same rows made one by reciprocal rank, which is how `recall` joins what the words found to what the vector found. |
| `SchemaError` | What `remember` throws when a store with a `schema` is given a record outside it; `issues` (`SchemaIssue`) name each row, path and message. |
| `diskBlobs`, `memoryBlobs`, `detach`, `inline`, `sweepBlobs`, `addressOf`, `isBlobAddress`, `blobsIn` | Blobs: a `BlobStore` on disk or in memory, an attachment's bytes moved into one and put back, the sweep that removes what nothing names (`SweepOptions`, `Swept`), the address of some bytes (`sha256:` and the digest), the test for one, and every address a value mentions. Types: `BlobStore`, `BlobInfo`. |
| `Values`, `Facts`, `Series` | What `store.values`, `store.facts` and `store.series` are: a value under a name with an optional lifetime; how two things are related and when that was true, with a walk of up to three steps; and readings in order of time, with windows and aggregates. Each is written over a `Connection`'s existing operations, so every backend has all three. |
| `conform` | Run the conformance suite against a driver you wrote. |
| `conformanceReport` | The same, rendered for a human. |
| `Wire` | The Postgres wire framing, reusable by a driver that speaks it. |
| `wireOptionsFrom` | Turn a connection URL into wire options. |

Types: `Driver`, `Store`, `Connection`, `ConnectOptions`, `Capabilities`,
`Item`, `Keep`, `Found`, `Query`, `Window`, `Ranked`, `ResultSet`, `Promised`,
`Conformance`, `StoresOptions`, `WireOptions`, `WireResult`, `Held`, `Asked`,
`RecallQuery`, `Reranker`, `Meta`, `Extras`, `Faster`, `Walk`, `WalkStep`,
`Bucket`, `Buckets`, `Entry`, `Namespace`, `Fact`, `FactOptions`, `FactQuery`,
`Neighbour`, `Point`, `RangeOptions`, `Aggregate`.

`Store.recall` takes text, a vector, or both (`Asked`), and `RecallQuery.rerank`
set false leaves the store's reranker out of one question.
`Capabilities.faster` lists what a backend does itself instead of leaving it to
this process: `walk`, `buckets`, `ids`, `validity`.

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
standard shape and the app wires the sink.

**`AppOptions.tracer`** takes `(span: Span) => void` and is the one to use. `Span`
is an OpenTelemetry span: `traceId`, `spanId`, `parentSpanId`, `startTime`,
`endTime`, `status`, and attributes in the GenAI semantic convention
(`gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`,
`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `error.type`). Model
calls and tool calls are instrumented, a call that threw still produces a span,
and trace context crosses into MCP as `traceparent` so a tool server's work joins
the same trace.

**`AppOptions.emit` and `WorkflowDeps.emit`** take `(span: GenAiSpan) => void` and
predate the above. `GenAiSpan` is a flat event — `operation`, `name`, `step`,
`durationMs`, `at` — describing what a WORKFLOW did (`plan`, `invoke_agent`,
`invoke_workflow`, `execute_tool`). It carries no trace ids, so nothing emitted
through it can be joined to anything else.

Both are live and they are bridged: when a `tracer` is wired, workflow events
reach it as conformant spans keyed on the run, so a workflow and the model calls
its steps made appear as one trace rather than two unrelated records of the same
work. Prefer `tracer` in new code; `emit` remains for anything already using it.

- `Tracer` is the type of `AppOptions.tracer`, and `GenAiOperation` the operations a
  span can name (`chat`, `execute_tool`, `embeddings`). `traced(...)` times one call
  and hands the span over, including when the call throws.
- `TraceContext` is where in a trace a call sits; `traceparentOf` and
  `parseTraceparent` write and read a W3C `traceparent` header, `traceMeta` gives the
  `_meta` keys MCP reserves for it, and `newTraceId`/`newSpanId` mint ids.
- `TraceLog` is a bounded in-memory collector — what `praecise dev` installs to
  render `/traces`. `laneOf(span, trace)` places a span in its trace's timeline; `Trace` is
  one trace assembled from its spans.
- `COST_ATTRIBUTE` and `COST_CURRENCY_ATTRIBUTE` are the span attributes a priced
  call carries: `praecise.usage.cost` and `praecise.usage.cost.currency`.
- `Ledger` records routing decisions and spend.
- `provenanceOf(run)` answers what a run derived from what.
- `followRun(runs, id, signal)` streams `RunEvent`s live.
- `forkRun(id, spec, deps, { after, patch, by })` branches a run from a past step,
  optionally editing an earlier output. The original is untouched and every patch
  is recorded as a `patched` event naming who made it.

---

## Protocols

Everything an app publishes is reachable four ways, from one declaration.

- **MCP `2026-07-28`** — `handleMcp(app, message, caller)` serves it and
  `toolsOf(app, caller)` lists the tools that caller may see; `McpClient`
  consumes it. Stateless: every request carries its own version, capabilities and
  identity in `_meta`. `mcpRequest(method, params)` and `mcpHeaders(...)` build a
  conforming request, which is worth using rather than assembling by hand.
- **A2A 1.0** — `agentCard(app, caller, baseUrl)` and `handleA2A(app, message,
  caller, tasks)`. `TaskStore` holds what `SendMessage` created so `GetTask`
  can find it. `streamsA2A(message)` says whether a request is one of the two that
  answer as a stream (`SendStreamingMessage`, `SubscribeToTask`), and
  `streamA2A(...)` yields its events. `A2A_VERSION` is the revision spoken
  (`"1.0"`, the form the header and the card use) and `AGENT_CARD_PATH` where the
  card is served. A caller that sends `A2A-Version: 0.3`, or uses a 0.3 method
  name, is answered in the 0.3 shapes. `restA2A(...)` serves the HTTP+JSON
  binding under the same address (`A2ARestRequest`, `A2ARestAnswer`), and
  `tasksOf` is the task store an app's A2A endpoint uses, made on first use. `A2AOptions.push` (`ServeOptions.a2a`) says
  which hosts a push notification may be sent to (`PushConfig`). Types: `Task`,
  `TaskState`, `TaskStatus`, `A2AMessage`, `Part`, `A2AVersion`, `TaskEvent`.
- **Signed agent cards** — `signAgentCard`, `cardSignerFor`, `cardPayload` and
  `jcs` sign a card over its canonical JSON form; `verifyAgentCard(card, jwks)`
  checks one and `fetchAgentCard(address, { keys, trust, unsigned })` fetches a
  peer's and says whether it verified. Types: `AgentCardSignature`, `CardSigner`,
  `CardVerification`, `FetchAgentCardOptions`, `FetchedAgentCard`.
- **MCP Tasks** — the server answers a workflow call from a client that declares
  `io.modelcontextprotocol/tasks` with a task, serves `tasks/get` and
  `tasks/cancel` (which stops the run), and sends `notifications/tasks` to a
  client that names the task in `subscriptions/listen`; `McpClient.call` follows
  a task it is handed to its end. `McpStream` is what a streamed MCP answer is.
- **Skills over MCP** — `listSkills`, `getSkill`, `readSkillDirectory`,
  `readSkillFile` and `renderSkillFile` serve the app's authored skills
  (`skills/list`, `skills/get`, `skill://` resources). Type: `ServedSkill`.
- **MCP Apps** — `ui` on a function, agent or workflow names a `ui://` resource
  to show beside its result; `handleView(...)` answers what a view asks of the
  service that brought it, which is what `POST /api/ui/<service>` serves.
  `MCP_APPS_ACTIVITY` is the AG-UI activity type a view is sent as.
- **A2UI 1.0** — `surfaceTool` (`SURFACE_TOOL`, `show_surface`) is the tool an
  agent sends a surface with; `validateA2ui` and `validateA2uiEvents` check an
  envelope and a renderer's events (`A2uiFault`); `rendererCatalogs` reads the
  catalogs a turn's renderer named; `a2uiTurn` reads what a turn carried from a
  renderer and `eventsText` puts its events into words for the agent. `A2UI_VERSION`, `A2UI_MEDIA_TYPE`, `A2UI_EXTENSION_URI`
  and `A2UI_ACTIVITY` are the constants. Types: `A2uiMessage`, `A2uiComponent`,
  `A2uiEvent`, `A2uiFunctionCall`, `A2uiFunctionResponse`.
- **Agent Client Protocol** — `serveAcp({ app, agent })` serves one agent over
  stdio for an editor; `ACP_PROTOCOL_VERSION` is the version spoken. Types:
  `AcpOptions`, `AcpServer`.
- **Responses API** — `handleResponses(...)` answers `POST /v1/responses`
  (`RESPONSES_PATH`), where `model` names an agent, and `responsesFrame` writes
  one stream event. Types: `ResponsesOptions`, `ResponsesAnswer`,
  `ResponsesError`, `ResponseResource`, `ResponseItem`, `ResponseEvent`.
- **AsyncAPI** — `asyncApi(app, caller, baseUrl)` describes the events the app
  receives and sends, served at `ASYNCAPI_PATH` (`ASYNCAPI_VERSION`).
- **Catalogue listings** — `listingOf` works out what a published capability
  says about itself (`Listing`) from an agent's `meta`, and `META_KEY` is the
  `_meta` key it is carried under on an MCP tool.
- **Discovery** — `mcpServerCard(...)` at `MCP_SERVER_CARD_PATH` and
  `aiCatalog(...)` at `AI_CATALOG_PATH` (`AI_CATALOG_VERSION` marks the catalog's
  shape as provisional: the standard it follows is a draft).
- **Web Bot Auth** — `signingFetch(fetch, signer)` signs every request per RFC 9421
  with the `web-bot-auth` tag; `keyDirectory(keys)` is the body served at
  `KEY_DIRECTORY_PATH` (`KEY_DIRECTORY_TYPE`); `verifySignature(request, jwks)`
  checks one; `thumbprint(jwk)` and `signatureBase(...)` are the pieces.
  `AppOptions.botAuth` applies it to the app's outbound requests. Types:
  `BotSigner`, `Ed25519PublicJwk`, `SignatureParams`, `SignedRequest`,
  `Verification`.
- **Run notifications and webhooks** — `AppOptions.notify` (`Notify`) is told what
  runs do as CloudEvents (`RUN_EVENT_TYPES`, `runEvent`, `RunNotice`,
  `RunEventType`, `RunTransition`). `signWebhook`, `verifyWebhook` and
  `deliverWebhook` implement Standard Webhooks (`WebhookTarget`,
  `WebhookDelivery`, `DeliverWebhookOptions`).
- **AG-UI interrupts** — `interruptOf`, `answerInterrupts`, `followWork`,
  `AguiInterrupt`, `AguiResume`: a workflow stream that stops at a gate ends with
  an interrupt outcome and is resumed through the existing approval path.
- **AG-UI** — `AguiStream` translates praecise's `Progress` events into AG-UI's,
  keeping message boundaries. `modesFrom(...)` reads a `?stream=` selector,
  `modeOf(event)` says which `StreamMode` an event belongs to, `ALL_MODES` lists them,
  and `sseFrame(event)` writes one `AguiEvent` (of an `AguiType`) as an SSE frame.
- **OAuth 2.1** — `OAuthClient` for servers that are protected resources, plus
  `parseChallenge`, `canonicalResource`, `metadataUrls`, `stepUpScopes`,
  `challengeFor` (the S256 PKCE challenge), `randomString`, and `expiryOf`/`expired`
  for deciding when to refresh. `OAuthOptions.clientMetadataUrl` names a Client ID
  Metadata Document to use as the client id where the authorization server supports
  one, and `clientMetadataDocument(...)` builds that document. `authorizerFor`
  turns a `MachineGrant` (client credentials, or an identity assertion exchanged
  at an identity provider) into a function that finds a token, and
  `clientAssertion` signs the assertion a key-holding client presents. Types:
  `OAuthOptions`, `Challenge`, `Tokens`, `ClientRegistration`, `MachineGrant`,
  `PendingAuthorization`, `DiscoveryResult`, `ProtectedResourceMetadata`,
  `AuthorizationServerMetadata`, `ClientMetadataDocument`.

`llmsTxt(app, caller, baseUrl)` (served at `LLMS_TXT_PATH`), `jsonLd(...)`,
`jsonLdScript(...)` (the same, ready for a page's `<head>`) and `robotsTxt(...)` are the
discovery documents; `ask(app, request, caller, policy)` answers a natural-language
question from the app's own store, and `compact(results, budget)` is the layer
between a database and a prompt — supersede, deduplicate, fit, and reorder for
where a model actually reads. Around them: `fromStore` reads store rows as
schema.org objects, `rank` and `termsOf` rank what the app publishes against a
question, `edgeFirst` puts the best matches where a model reads, and `qualityFor` and
`modeFor` cap what was asked for at what the `AskPolicy` allows. Types: `AskAnswer`,
`AskMode`, `AskPolicy`, `AskResult`, `Compacted`.

---

## Ingestion

`ingestInto(dir, store, options)` reads a folder of documents into a store.
`chunk(text, size, overlap)` splits at the document's own paragraph boundaries,
`chunkId(source, text)` derives a stable id so re-running does not duplicate, and
`readFields(said, fields)` reads a model's extraction or refuses it, from the prompt
`extractionPrompt(text, fields)` builds. `ingestible(dir)` lists the files the pipeline
can read. `canConvert`, `isTextFormat` and `ingestFile` (with `Converted` and
`Converter`) are the conversion layer underneath. Types: `IngestPipelineOptions`,
`IngestReport`.

---

## Structured results

A declared `returns` is fields and hints, a JSON Schema, or a Standard Schema
validator.

- `returnsKind(returns)` says which (`ReturnsKind`); `isJsonSchema` and
  `isStandardSchema` are the tests.
- `validateJson(schema, value)` checks a value against a JSON Schema and answers
  with what is wrong. `CHECKED_KEYWORDS` are the keywords it checks,
  `UNCHECKED_KEYWORDS` the ones it does not, and `uncheckedIn(schema)` the
  unchecked ones a schema uses.
- `ShapeError` is what a request ends in when the strongest model's answer is
  still outside the shape; it carries `issues` and the `text`.
- Types: `StandardSchemaV1`, `StandardResult`, `StandardIssue`, `StandardOutput`,
  `DataOf`.

---

## `@praecise/harness/formats`

Readers for robotics, scene and array data, as a plugin. Public, and covered by
the same promise as the root.

| Name | What it is |
| --- | --- |
| `formats` | The plugin: `plugins: [formats()]`. `formats({ only })` and `formats({ except })` choose among the formats (`FormatsOptions`). |
| `registerFormats` | Register the same readers without a plugin. |
| `describeAttachment` | The rendering of one attachment, or nothing where no format here reads it. |
| `formatNames`, `FormatName` | The names `only` and `except` take. |
| `mcap`, `rosbag`, `rosbag2`, `lerobot`, `parquet`, `arrow`, `pcd`, `ply`, `splat`, `splatPly`, `usd`, `npy` | Each format on its own (`Format`). |

## `@praecise/harness/testing`

A model that says what a test tells it to. Public, and covered by the same
promise as the root.

| Name | What it is |
| --- | --- |
| `scriptedModel` | A model endpoint that answers from a list of replies. `models` goes in the config, `requests` is every request the app made, `push` adds replies, and `remaining` counts what is left. Types: `ScriptedModel`, `ScriptedModelOptions`, `Scripted`, `ScriptedReply`, `ScriptedCall`, `ScriptedRequest`. |
| `scriptedEndpoint` | The same one level down: a `fetch` that answers with the bodies it is given. Types: `ScriptedEndpoint`, `EndpointReply`. |
| `systemText` | The instructions of a request, as text. |

---

## `@praecise/harness/internal`

Unstable. Unversioned. May change or vanish in any release, patch releases
included. Documented here only so you know what it holds and why you should not
reach for it:

- **Loading** — `loadProject`, `resolveKnows`, `findCycle`, `Importer`,
  `LoadOptions`
- **Ingest** — `converterFor`, `ConvertRequest`, `IngestOptions`, `ConverterOptions`
- **Compiling** — `planProject`, `planAgent`, `planWorkflowAgent`, `schemaFor`,
  `PlanOptions`
- **Harness internals** — `stateDirFor`, `stream`, `trim`
- **Store internals** — `urlFor`, `asObjects`
- **Workflow internals** — `checkSteps`, `provisioner`, `runCommand`,
  `splitCommand`, `Manifest`, `ProvisionerDeps`
- **Server internals** — `callPublished`, `promptsOf`,
  `resourcesOf`, `groupsOf`, `noticesOf`, `openChannel`, `Caller`, `McpTool`,
  `Channel`
- **Packaging** — `buildPackage`, `manifestFor`, `apiModule`, `apiTypes`,
  `faultsIn`, `hintsIn`, `PackageManifest`, `PackageOptions`, `PackageResult`,
  `Describable`
- **CLI** — `cli`. The supported way to run this is the `praecise` binary.

`adapterFor`, `chatWire`, `contentsWire`, `messagesWire`, `handleMcp`, `toolsOf`,
`canConvert`, `ingestFile`, `Converted` and `Converter` are also reachable here, and
are public: they are exported from the root and documented above.
