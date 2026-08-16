/// <reference types="node" />
// Declared here rather than left to the consumer's tsconfig. This package's public types name
// `Buffer` and the `node:*` modules, and whether ambient node types are in scope is a decision
// the CONSUMER's config makes — so a published .d.ts that relies on it fails to typecheck for
// anyone who did not make it. The reference travels with the declaration and needs nothing.

/**
 * `praecise/internal` — NOT part of the public API. NOT covered by semver.
 *
 * Every name here may change shape, be renamed, or disappear in ANY release,
 * including a patch. There is no deprecation period and no migration note. If
 * you depend on something in this file, pin an exact version of `praecise` and
 * read the changelog before upgrading.
 *
 * It exists for one reason. These are the framework's own moving parts — the
 * project loader, the planner, the provider wire formats, the packager, the MCP
 * request handlers, the CLI entry point — and a stability promise that covered
 * them would either be a lie or would freeze the framework's insides forever.
 * Deleting them instead would mean that anyone who genuinely needs one has to
 * fork the whole framework to get it. So they moved here rather than vanishing:
 * reachable when necessity demands, and honestly labelled as unstable.
 *
 * Everything an app is actually written against is at the package root. If a
 * name you need is only available here, that is worth reporting as an issue —
 * it usually means the public surface has a gap.
 */

// ── Loading a project folder ───────────────────────────────────────────────

export { findCycle, loadProject, resolveKnows } from "./project/load.js";
export type { Importer, LoadOptions } from "./project/load.js";

// ── Reading documents into knowledge ───────────────────────────────────────

export { canConvert, ingestFile } from "./ingest/index.js";
export type { Converted, Converter, ConvertRequest, IngestOptions } from "./ingest/index.js";
export { converterFor } from "./ingest/converter.js";
export type { ConverterOptions } from "./ingest/converter.js";

// ── Compiling specs into plans ─────────────────────────────────────────────

export { planAgent, planProject, planWorkflowAgent, schemaFor } from "./compile/plan.js";
export type { PlanOptions } from "./compile/plan.js";

// ── Harness internals: provider wire formats, budgeting, streaming ─────────

export {
  adapterFor,
  chatWire,
  contentsWire,
  messagesWire,
  stateDirFor,
  stream,
  trim,
} from "./harness/index.js";

// ── Store internals ────────────────────────────────────────────────────────

export { asObjects, urlFor } from "./stores/index.js";

// ── Workflow internals: provisioning and command verification ──────────────

export { checkSteps, provisioner } from "./workflow/provision.js";
export type { Manifest, ProvisionerDeps } from "./workflow/provision.js";
export { runCommand, splitCommand } from "./workflow/verify.js";

// ── Server internals: SSE plumbing and the MCP request handlers ────────────

export { openChannel } from "./server/events.js";
export type { Channel } from "./server/events.js";
export {
  callPublished,
  groupsOf,
  handleMcp,
  noticesOf,
  promptsOf,
  resourcesOf,
  toolsOf,
} from "./server/mcp.js";
export type { Caller, McpTool } from "./server/mcp.js";

// ── Packaging an app for distribution ──────────────────────────────────────

export { apiModule, apiTypes } from "./package/api.js";
export { faultsIn, hintsIn } from "./package/describe.js";
export type { Describable } from "./package/describe.js";
export { buildPackage, manifestFor } from "./package/build.js";
export type { PackageManifest, PackageOptions, PackageResult } from "./package/build.js";

// ── The CLI, as a function ─────────────────────────────────────────────────
// The supported way to run this is the `praecise` binary, not an import.

export { main as cli } from "./cli/index.js";
