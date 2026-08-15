import type { Tracer } from "./trace.js";
/**
 * Where an app gets its runtime. One implementation, built in and complete;
 * everything above is written against `Harness` rather than against it.
 */

import { join } from "node:path";

import type { AppConfig, GuardSpec } from "../define.js";
import type { Store } from "../stores/types.js";
import { BuiltinHarness } from "./builtin.js";
import type { Threads } from "./threads.js";
import type { Harness } from "./types.js";

export interface ResolveHarnessOptions {
  root: string;
  config?: AppConfig;
  fetch?: typeof fetch;
  stores?: { open(name: string): Promise<Store> };
  /** The app's `guard.ts`, asked before every tool call. */
  guard?: GuardSpec;
  /** Where conversations are kept, made once by whoever is assembling the app. */
  threads?: Threads;
  /** Read for `PRAECISE_STRICT`. Defaults to the process environment. */
  env?: Record<string, string | undefined>;
  /**
   * Where the exploration coin comes from, when `config.explore` is set.
   *
   * Injectable for the same reason `fetch` is: a setting whose only observable effect is
   * random cannot be shown to be connected to anything, and a dial connected to nothing
   * is worse than no dial.
   */
  random?: () => number;
  /** Where finished spans go. The dev server supplies one; production supplies its own. */
  tracer?: Tracer;
}

export function stateDirFor(root: string, config?: AppConfig): string {
  return join(root, config?.stateDir ?? ".praecise");
}

/**
 * Whether this app refuses where the framework would otherwise be friendly.
 *
 * The app's own setting wins outright: an author who wrote `strict: false` meant
 * it, and an environment variable that could override it would make the file
 * lying about the app it configures. Where the app says nothing, the environment
 * decides — which is what lets one deployment of an app insist on it.
 */
function strictly(options: ResolveHarnessOptions): boolean {
  if (typeof options.config?.strict === "boolean") return options.config.strict;
  const flag = (options.env ?? process.env).PRAECISE_STRICT;
  return flag !== undefined && !["", "0", "false", "no", "off"].includes(flag.toLowerCase());
}

export async function resolveHarness(options: ResolveHarnessOptions): Promise<Harness> {
  return new BuiltinHarness({
    stateDir: stateDirFor(options.root, options.config),
    fetch: options.fetch,
    stores: options.stores,
    guard: options.guard,
    threads: options.threads,
    strict: strictly(options),
    preference: options.config?.preference,
    explore: options.config?.explore,
    random: options.random,
    tracer: options.tracer,
  });
}

export { BuiltinHarness } from "./builtin.js";
export { Memory, StoredMemory } from "./memory.js";
export { collectResources,
  mcpRequest,
  mcpHeaders,
  Unauthorized } from "./mcp.js";
export type {
  McpResource, McpResourceContents, McpPrompt, McpPromptResult,
  McpProgress, McpRequestOptions, McpCallOptions, McpCompletion,
} from "./mcp.js";
export { authorityOf, settle } from "./consolidate.js";
export type { Origin, Note } from "./consolidate.js";
export { SkillBook, usableProcedures, renderSkills } from "./procedure.js";
export type { Procedure, ProcedureCandidate, Skills } from "./procedure.js";
export type { Episode, Recollection } from "./memory.js";
export { McpClient, collectTools, splitToolName, toolName } from "./mcp.js";
export {
  EXPLORATION,
  Ledger,
  barFor,
  consensusOf,
  difficultyOf,
  divergence,
  ladderFrom,
  riskOf,
  route,
  verifyMarginFor,
} from "./routing.js";
export type { Consensus, Decision, Exploration, Reading, Shape } from "./routing.js";
export { stream } from "./stream.js";
export { trim } from "./budget.js";
/**
 * The wires, reachable from outside.
 *
 * `Harness` is the seam an app replaces the runtime at, and a seam that hands
 * over the whole request also hands over the endpoint formats — so a runtime
 * written against it either reimplements them or is not much of an
 * alternative. Reimplementing them is the worse outcome, because the copy is
 * where a format quietly drifts: this directory has already had one wire that
 * carried no tools at all while its two siblings carried them.
 */
export { adapterFor, chatWire, contentsWire, messagesWire, registerWire, knownWires, responsesWire, interactionsWire } from "./wire/index.js";
export type { SystemAs } from "./wire/index.js";
export { Folder, Threads, carry } from "./threads.js";
export type { Conversations, Thread, ThreadSummary, Turn } from "./threads.js";
export * from "./types.js";
