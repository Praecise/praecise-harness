/**
 * `import { agent } from "praecise"`.
 *
 * This module IS the public API. Every name below is covered by semantic
 * versioning from 1.0 onwards: it will not be removed or changed in shape
 * without a major release. `API.md` at the repository root groups the same
 * names by the task they belong to.
 *
 * Machinery the framework needs but an app never types — planners, wire
 * formats, the loader, the packager, the CLI entry point — lives at
 * `praecise/internal`, which carries no such promise. Nothing was deleted to
 * get here; it moved, so that needing one of those names never means forking.
 */

// ── Authoring ──────────────────────────────────────────────────────────────
// What an app is written against: a folder of these calls is the app.

export {
  agent,
  workflow,
  knowledge,
  tool,
  fn,
  prompt,
  resource,
  store,
  blueprint,
  template,
  middleware,
  guard,
  defineConfig,
  isApprove,
  isAsk,
  isEach,
  isPlan,
  isRepeat,
  isUse,
  isWhen,
  QUALITIES,
} from "./define.js";

export type {
  Access,
  AgentInput,
  AgentSpec,
  AppConfig,
  Preference,
  ApproveStep,
  AskStep,
  Attempt,
  BlueprintInput,
  BlueprintSpec,
  Call,
  Check,
  EachStep,
  Effect,
  FileContents,
  FunctionInput,
  FunctionSpec,
  GuardInput,
  GuardSpec,
  KnowledgeInput,
  KnowledgeSpec,
  Limits,
  MemorySpec,
  MiddlewareInput,
  MiddlewareSpec,
  ModelProvider,
  PlanStep,
  PromptInput,
  PromptSpec,
  Provider,
  Published,
  Quality,
  Ref,
  RepeatStep,
  Reply,
  ResourceInput,
  ResourceSpec,
  Returns,
  Step,
  StoreInput,
  StoreKind,
  StoreSpec,
  TemplateInput,
  TemplateSpec,
  ToolInput,
  ToolSpec,
  UseStep,
  WhenStep,
  WorkflowInput,
  WorkflowSpec,
} from "./define.js";

// ── Running an app ─────────────────────────────────────────────────────────
// Load a folder, ask it something, run a workflow, follow what it did.

export { App } from "./app.js";
// `Approvals` is the shape of AppOptions.approvals — an app cannot type its own signer
// or verifier without it, and a governance seam whose type is unimportable is not a seam.
export type { AppOptions, Approvals } from "./app.js";

/** What `App.project` is: the loaded folder, and one document within it. */
export type { Doc, Project } from "./project/load.js";

/** What an agent was compiled into — read by anything observing a run. */
export type { AgentPlan, LocalTool, ResolvedService, Rung } from "./compile/plan.js";

export { recoverRun, resumeRun, startRun } from "./workflow/run.js";
export type {
  ApprovalClaim,
  ApprovalDecision,
  GenAiSpan,
  ProvisionRequest,
  ProvisionResult,
  WorkflowDeps,
} from "./workflow/run.js";

export { RunStore } from "./workflow/store.js";
export type { Outcome, PlanVersion, Run, RunEvent, RunStatus } from "./workflow/store.js";
export type { VerifyResult } from "./workflow/verify.js";

export { provenanceOf } from "./workflow/provenance.js";
export type { ProvGraph } from "./workflow/provenance.js";

// ── The harness ────────────────────────────────────────────────────────────
// Models, memory, procedural skills, and the contract an adapter implements.

export {
  BuiltinHarness,
  Ledger,
  Memory,
  authorityOf,
  settle,
  // The endpoint registry. Exported because the whole point of opening it was that a
  // vendor outside the shipped shapes should not require a fork — and a registry that
  // cannot be reached from the package root leaves exactly that fork in place.
  registerWire,
  knownWires,
  adapterFor,
  chatWire,
  contentsWire,
  messagesWire,
  responsesWire,
  interactionsWire,
  // Reading what an MCP server publishes, not only calling what it exposes. The
  // framework served resources and prompts long before it could consume one.
  collectResources,
  mcpRequest,
  mcpHeaders,
  Unauthorized,
  SkillBook,
  StoredMemory,
  ProviderError,
  renderSkills,
  resolveHarness,
  usableProcedures,
  verifyMarginFor,
  // The routing corrections, reachable because an operator has to be able to see them.
  // `riskOf` is the term that used to be miscounted as difficulty; `ladderFrom` is the
  // depth ladder a request climbs before any model switch; `EXPLORATION` is what an
  // operator sets `explore` to when they want the routing record to be worth fitting.
  EXPLORATION,
  ladderFrom,
  riskOf,
} from "./harness/index.js";
export type {
  Answer,
  AskOptions,
  ChatAdapter,
  ChatRequest,
  ChatResponse,
  Episode,
  // `Origin` types `Episode.origin`, a PUBLIC field — a consumer that sets it must be
  // able to name it. `Note` and the two functions over it are what an app needs to
  // resolve two memories that contradict each other: `settle` cannot be called by the
  // framework itself because deciding whether two statements conflict is domain
  // knowledge, so it is exported rather than left as machinery nothing can reach.
  Origin,
  Note,
  McpResource,
  McpResourceContents,
  McpPrompt,
  McpPromptResult,
  McpProgress,
  McpRequestOptions,
  McpCallOptions,
  McpCompletion,
  Harness,
  Message,
  Progress,
  Recollection,
  Routing,
  ToolCall,
  ToolSchema,
  Usage,
} from "./harness/index.js";

// ── Serving ────────────────────────────────────────────────────────────────

export { serve } from "./server/index.js";
export type { DevServer, ServeOptions } from "./server/index.js";
export { serveStdio } from "./server/stdio.js";
export type { StdioOptions, StdioServer } from "./server/stdio.js";
export { followRun } from "./server/events.js";
// OAuth 2.1 for MCP servers that are protected resources. The flow is split where a
// human has to act: the framework owns the retry, the application owns the browser and
// wherever tokens are kept.
export {
  OAuthClient,
  canonicalResource,
  challengeFor,
  expired,
  expiryOf,
  metadataUrls,
  parseChallenge,
  randomString,
  stepUpScopes,
} from "./harness/oauth.js";
export type {
  AuthorizationServerMetadata,
  Challenge,
  ClientRegistration,
  DiscoveryResult,
  OAuthOptions,
  PendingAuthorization,
  ProtectedResourceMetadata,
  Tokens,
} from "./harness/oauth.js";

// An OpenAPI description, turned into tools. Most APIs worth reaching already have one
// and do not have an MCP server; without this, using one means restating a description
// that already exists and is already accurate.
export {
  baseUrlOf,
  callOperation,
  operationName,
  operationsFrom,
  requestFor,
  resolveRefs,
  toolsFrom,
} from "./harness/openapi.js";
export type { Operation, Where } from "./harness/openapi.js";
export { ApiClient } from "./harness/mcp.js";
export type { ToolSource } from "./harness/mcp.js";

// The SDK door: an app as a value you import, rather than a folder somebody scans.
// Same core, same checks — see src/sdk.ts for why two doors are safe.
export { createApp, defineApp, mergeApps } from "./sdk.js";
export type { AppDefinition } from "./sdk.js";

// Discovery: how a machine finds out what this app is and what it can do.
export { LLMS_TXT_PATH, llmsTxt, jsonLd, jsonLdScript, robotsTxt } from "./server/discovery.js";
// Ask: a page generated for the question, at a rung the operator chose.
export { ask, compact, edgeFirst, fromStore, qualityFor, modeFor, rank, termsOf } from "./server/ask.js";
export type { AskAnswer, AskMode, AskPolicy, AskResult, Compacted } from "./server/ask.js";

export { PROTOCOL_VERSION, handleMcp, toolsOf } from "./server/mcp.js";

// A2A: the app published as an agent a peer delegates to, rather than as tools a model
// picks from. Same access rules, same execution seam, different unit of work.
export {
  A2A_VERSION,
  AGENT_CARD_PATH,
  agentCard,
  handleA2A,
  TaskStore,
} from "./server/a2a.js";
export type { Task, TaskState, TaskStatus, A2AMessage, Part } from "./server/a2a.js";

// ── Storage, and extending it ──────────────────────────────────────────────
// `Stores`/`openStore` use a store; the drivers, `conform` and `Wire` are for
// writing a new backend and proving it behaves like the others.

export {
  Kept,
  Stores,
  conform,
  conformanceReport,
  memoryDriver,
  openStore,
  postgresDriver,
  sqliteDriver,
  Wire,
  wireOptionsFrom,
} from "./stores/index.js";
export type {
  Capabilities,
  Conformance,
  ConnectOptions,
  Connection,
  Driver,
  Found,
  Held,
  Item,
  Keep,
  Promised,
  Query,
  Ranked,
  ResultSet,
  Store,
  StoresOptions,
  Window,
  WireOptions,
  WireResult,
} from "./stores/index.js";

// ── Dialect codec and latent transport ─────────────────────────────────────
/**
 * A deliberate framework mechanism, not an accident of the export list.
 *
 * `defineDialect` builds a versioned, field-typed wire format from a table of
 * message specs, and `str`/`num`/`bool`/`list`/`fixed2` are the field codecs it
 * is built out of. The framework ships the ENGINE; each app declares its own
 * vocabulary on top of it, because a vocabulary is a property of the app's
 * domain and hard-coding one here would make every app speak the same language
 * whether or not it means the same things.
 *
 * `latent` and friends are the transport for the other half: an intermediate
 * representation passed between steps without being rendered back to text.
 * `latentRef`/`createRefs` name a payload without carrying it, `latentChannel`
 * moves them, `probe` reads a scalar off one so the traffic stays auditable —
 * an opaque vector nobody can measure is not something to put in a pipeline.
 *
 * Both are explained in `API.md` (§ Dialect and latent transport) and in the
 * README's "speaking a dialect" section.
 */
export { defineDialect, str, num, fixed2, bool, list } from "./codec.js";
export type { Dialect, MessageSpec, Field, FieldCodec } from "./codec.js";
export { createRefs, isLatent, latent, latentChannel, latentRef, probe } from "./transport.js";
export type { LatentChannel, LatentPayload, LatentRef, Probe, Refs } from "./transport.js";
