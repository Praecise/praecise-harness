/**
 * `import { agent } from "praecise"`.
 *
 * The first block is the whole authoring surface — what an app is written
 * against. Everything after it is for tooling and tests; an app never needs it.
 */

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
  AgentInput,
  AgentSpec,
  AppConfig,
  ApproveStep,
  AskStep,
  Attempt,
  BlueprintInput,
  BlueprintSpec,
  Call,
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

// ── Below the surface ──────────────────────────────────────────────────────

export { App } from "./app.js";
export type { AppOptions } from "./app.js";

export { findCycle, loadProject, resolveKnows } from "./project/load.js";
export type { Doc, Importer, LoadOptions, Project } from "./project/load.js";

export { canConvert, ingestFile } from "./ingest/index.js";
export type { Converted, Converter, ConvertRequest, IngestOptions } from "./ingest/index.js";
export { converterFor } from "./ingest/converter.js";

export { planAgent, planProject, planWorkflowAgent, schemaFor } from "./compile/plan.js";
export type { AgentPlan, LocalTool, PlanOptions, ResolvedService, Rung } from "./compile/plan.js";

export {
  BuiltinHarness,
  Ledger,
  Memory,
  StoredMemory,
  adapterFor,
  chatWire,
  contentsWire,
  messagesWire,
  resolveHarness,
  stateDirFor,
  stream,
  trim,
} from "./harness/index.js";
export type {
  Answer,
  AskOptions,
  ChatAdapter,
  ChatRequest,
  ChatResponse,
  Episode,
  Harness,
  Message,
  Progress,
  Recollection,
  Routing,
  ToolCall,
  ToolSchema,
  Usage,
} from "./harness/index.js";

export {
  Kept,
  Stores,
  asObjects,
  conform,
  conformanceReport,
  memoryDriver,
  openStore,
  postgresDriver,
  sqliteDriver,
  urlFor,
} from "./stores/index.js";
export type {
  Capabilities,
  Conformance,
  ConnectOptions,
  Connection,
  Driver,
  Found,
  Item,
  Keep,
  Promised,
  Query,
  Ranked,
  ResultSet,
  Store,
  StoresOptions,
  Window,
} from "./stores/index.js";

export { startRun, resumeRun } from "./workflow/run.js";
export type { ProvisionRequest, ProvisionResult, WorkflowDeps } from "./workflow/run.js";
export { checkSteps, provisioner } from "./workflow/provision.js";
export type { Manifest, ProvisionerDeps } from "./workflow/provision.js";
export { runCommand, splitCommand } from "./workflow/verify.js";
export { RunStore } from "./workflow/store.js";
export type { PlanVersion, Run, RunEvent, RunStatus } from "./workflow/store.js";

export { serve } from "./server/index.js";
export type { DevServer, ServeOptions } from "./server/index.js";
export { followRun, openChannel } from "./server/events.js";
export type { Channel } from "./server/events.js";
export {
  callPublished,
  groupsOf,
  handleMcp,
  noticesOf,
  promptsOf,
  resourcesOf,
  toolsOf,
  PROTOCOL_VERSION,
} from "./server/mcp.js";
export type { Caller, McpTool } from "./server/mcp.js";
export { serveStdio } from "./server/stdio.js";
export type { StdioOptions, StdioServer } from "./server/stdio.js";
export { apiModule, apiTypes } from "./package/api.js";
export { faultsIn, hintsIn } from "./package/describe.js";
export type { Describable } from "./package/describe.js";
export { buildPackage, manifestFor } from "./package/build.js";
export type { PackageManifest, PackageOptions, PackageResult } from "./package/build.js";

export { main as cli } from "./cli/index.js";

// Dialect codec (the engine) + latent transport — the neuralese MECHANISM. Apps
// define their own dialect vocabulary and audit discipline on top of these.
export { defineDialect, str, num, fixed2, bool, list } from "./codec.js";
export type { Dialect, MessageSpec, Field, FieldCodec } from "./codec.js";
export { latent, latentChannel, probe, createRefs } from "./transport.js";
export type { LatentPayload, LatentChannel, Probe, Refs } from "./transport.js";

export { provenanceOf } from "./workflow/provenance.js";
export type { ProvGraph } from "./workflow/provenance.js";
