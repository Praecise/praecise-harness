/**
 * Where an app gets its runtime. One implementation, built in and complete;
 * everything above is written against `Harness` rather than against it.
 */

import { join } from "node:path";

import type { AppConfig, GuardSpec } from "../define.js";
import type { Store } from "../stores/types.js";
import { BuiltinHarness } from "./builtin.js";
import type { Harness } from "./types.js";

export interface ResolveHarnessOptions {
  root: string;
  config?: AppConfig;
  fetch?: typeof fetch;
  stores?: { open(name: string): Promise<Store> };
  /** The app's `guard.ts`, asked before every tool call. */
  guard?: GuardSpec;
}

export function stateDirFor(root: string, config?: AppConfig): string {
  return join(root, config?.stateDir ?? ".praecise");
}

export async function resolveHarness(options: ResolveHarnessOptions): Promise<Harness> {
  return new BuiltinHarness({
    stateDir: stateDirFor(options.root, options.config),
    fetch: options.fetch,
    stores: options.stores,
    guard: options.guard,
  });
}

export { BuiltinHarness } from "./builtin.js";
export { Memory, StoredMemory } from "./memory.js";
export type { Episode, Recollection } from "./memory.js";
export { McpClient, collectTools, splitToolName, toolName } from "./mcp.js";
export { Ledger, barFor, consensusOf, difficultyOf, divergence, route } from "./routing.js";
export type { Consensus, Decision, Reading, Shape } from "./routing.js";
export { stream } from "./stream.js";
export { Threads, carry } from "./threads.js";
export type { Thread, ThreadSummary, Turn } from "./threads.js";
export * from "./types.js";
