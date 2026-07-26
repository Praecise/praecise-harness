/**
 * Turning a declaration into something open.
 *
 * A store is declared with a family and, usually, nothing else. Where it lives
 * is worked out here: an environment variable if one is named, an explicit url
 * if one is written, and otherwise a file under the app's own state directory —
 * so a store works the first time it is asked for, with nothing provisioned.
 *
 * Which backend answers is decided by the url and nothing else. One ships with
 * the framework; anything else is a `Driver` the app hands over, and the four
 * verbs run against it unchanged. That is the whole extension point, and it is
 * why the framework can speak to a database it does not depend on.
 *
 * Connections are opened once and shared, because opening one is the expensive
 * part and an app asking for the same store twice means the same store.
 */

import { join } from "node:path";

import type { StoreSpec } from "../define.js";
import { sqliteDriver } from "./sqlite.js";
import { Kept } from "./store.js";
import type { ConnectOptions, Driver, Store } from "./types.js";

export interface StoresOptions {
  /** Where a store with no url of its own is kept. */
  stateDir: string;
  env?: Record<string, string | undefined>;
  /** Backends this app brings. They take precedence over the built-in one. */
  drivers?: Driver[];
  /** Refuse anything that would change something. */
  readOnly?: boolean;
}

/** Schemes the built-in backend answers to, beyond its own name. */
const BUILTIN = new Set(["", "file", "sqlite"]);

function schemeOf(url: string): string {
  return /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase() ?? "";
}

function driverFor(url: string, brought: Driver[]): Driver {
  const scheme = schemeOf(url);
  const own = brought.find((driver) => driver.name.toLowerCase() === scheme);
  if (own) return own;
  if (BUILTIN.has(scheme)) return sqliteDriver;
  throw new Error(
    `nothing here can open a "${scheme}" store. The framework brings one backend and ` +
      `takes any other: implement \`Driver\`, name it "${scheme}", and pass it in.`,
  );
}

/** Where the store lives, in the order the author decides it. */
export function urlFor(
  name: string,
  spec: StoreSpec,
  options: StoresOptions,
): { url: string; problem?: string } {
  if (spec.credential) {
    const url = options.env?.[spec.credential];
    if (url?.trim()) return { url: url.trim() };
    return {
      url: "",
      problem: `store "${name}" needs ${spec.credential} to be set`,
    };
  }
  if (spec.url?.trim()) return { url: spec.url.trim() };
  return { url: join(options.stateDir, "stores", `${name.replace(/[^\w.-]/g, "_")}.db`) };
}

export async function openStore(
  name: string,
  spec: StoreSpec,
  options: StoresOptions,
): Promise<Store> {
  const { url, problem } = urlFor(name, spec, options);
  if (problem) throw new Error(problem);

  const connect: ConnectOptions = { url, readOnly: options.readOnly, dimensions: spec.dimensions };
  const connection = await driverFor(url, options.drivers ?? []).connect(connect);
  return new Kept(name, spec.of, connection);
}

/** Every store an app declared, opened on first use and closed with the app. */
export class Stores {
  private readonly opened = new Map<string, Promise<Store>>();

  constructor(
    private readonly specs: Record<string, StoreSpec>,
    private readonly options: StoresOptions,
  ) {}

  get names(): string[] {
    return Object.keys(this.specs).sort();
  }

  has(name: string): boolean {
    return name in this.specs;
  }

  open(name: string): Promise<Store> {
    const spec = this.specs[name];
    if (!spec) return Promise.reject(new Error(`no store named "${name}"`));

    let pending = this.opened.get(name);
    if (!pending) {
      // A failed open is not cached: a missing credential set a moment later
      // should work on the next ask rather than stay broken for the process.
      pending = openStore(name, spec, this.options).catch((error: unknown) => {
        this.opened.delete(name);
        throw error;
      });
      this.opened.set(name, pending);
    }
    return pending;
  }

  async close(): Promise<void> {
    const pending = [...this.opened.values()];
    this.opened.clear();
    await Promise.all(
      pending.map(async (opening) => {
        await opening.then((store) => store.close()).catch(() => undefined);
      }),
    );
  }
}

export { Kept } from "./store.js";
export { sqliteDriver } from "./sqlite.js";
export * from "./types.js";
