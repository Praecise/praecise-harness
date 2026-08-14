/**
 * Turning a declaration into something open.
 *
 * A store is declared with a family and, usually, nothing else. Where it lives
 * is worked out here: an environment variable if one is named, an explicit url
 * if one is written, and otherwise a file under the app's own state directory —
 * so a store works the first time it is asked for, with nothing provisioned.
 *
 * Which backend answers is decided by the url and nothing else. A few ship with
 * the framework; anything else is a `Driver` the app hands over, and the four
 * verbs run against it unchanged. That is the whole extension point, and it is
 * why the framework can speak to a database it does not depend on. What a
 * brought backend owes is not a matter of opinion either — `conform` runs the
 * promises against it and says which ones it is not keeping.
 *
 * Connections are opened once and shared, because opening one is the expensive
 * part and an app asking for the same store twice means the same store.
 *
 * The family a store declares is checked here, against what the backend the url
 * chose says it can serve. It used to be decoration: `of: "graph"` on a
 * `postgres://` url got the same table of text as everything else, and nothing
 * anywhere said so. A declaration that cannot be honoured is now refused at the
 * point it is opened, naming what is served and what is not, because the honest
 * answer to "give me a graph" from something holding rows is to say no rather
 * than to hand over rows and let an app find out later.
 */

import { join } from "node:path";

import type { StoreKind, StoreSpec } from "../define.js";
import { memoryDriver } from "./memory.js";
import { postgresDriver } from "./postgres.js";
import { sqliteDriver } from "./sqlite.js";
import { Kept } from "./store.js";
import type { Connection, ConnectOptions, Driver, Store } from "./types.js";

export interface StoresOptions {
  /** Where a store with no url of its own is kept. */
  stateDir: string;
  env?: Record<string, string | undefined>;
  /** Backends this app brings. They take precedence over the built-in one. */
  drivers?: Driver[];
  /** Refuse anything that would change something. */
  readOnly?: boolean;
}

/**
 * Which backend answers which url. A bare path is a file, because that is what
 * a store with nothing declared about it should be.
 */
const BUILTIN: Record<string, Driver> = {
  "": sqliteDriver,
  file: sqliteDriver,
  sqlite: sqliteDriver,
  postgres: postgresDriver,
  postgresql: postgresDriver,
  memory: memoryDriver,
};

function schemeOf(url: string): string {
  return /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase() ?? "";
}

function driverFor(url: string, brought: Driver[]): Driver {
  const scheme = schemeOf(url);
  const own = brought.find((driver) => driver.name.toLowerCase() === scheme);
  if (own) return own;
  const builtin = BUILTIN[scheme];
  if (builtin) return builtin;
  throw new Error(
    `nothing here can open a "${scheme}" store. A few backends ship and any other is ` +
      `brought: implement \`Driver\`, name it "${scheme}", pass it in, and run \`conform\` ` +
      `against it to find out what it still owes.`,
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

/**
 * Where an extension may be loaded from, for the one backend that can load one.
 *
 * It is an environment variable rather than anything in the app, because
 * loading a shared object is a property of the machine the app is running on:
 * the same declaration deployed twice can have sqlite-vec on one host and not
 * on the other, and neither of them is the app being wrong.
 */
export const EXTENSION_ENV = "PRAECISE_SQLITE_EXTENSION";

/**
 * What this backend cannot honour about the declaration, if anything.
 *
 * A driver that says nothing about what it serves is held to nothing — a
 * backend written before there was anything to say is not refused for not
 * having said it. What is checked is what a driver claims.
 */
function unserved(of: StoreKind, connection: Connection): string | undefined {
  const can = connection.capabilities;
  if (of === "vector" && can.vectors === false) return "holds no vectors at all";
  if (!can.serves || can.serves.includes(of)) return undefined;
  return `serves ${can.serves.join(", ")}`;
}

export async function openStore(
  name: string,
  spec: StoreSpec,
  options: StoresOptions,
): Promise<Store> {
  const { url, problem } = urlFor(name, spec, options);
  if (problem) throw new Error(problem);

  const driver = driverFor(url, options.drivers ?? []);
  const connect: ConnectOptions = {
    url,
    readOnly: options.readOnly,
    dimensions: spec.dimensions,
    of: spec.of,
    extension: driver === sqliteDriver ? options.env?.[EXTENSION_ENV] : undefined,
  };
  const connection = await driver.connect(connect);

  const missing = unserved(spec.of, connection);
  if (missing) {
    await connection.close().catch(() => undefined);
    throw new Error(
      `store "${name}" is declared \`of: "${spec.of}"\` and the ${driver.name} backend it was ` +
        `pointed at ${missing}. Declare the family this store is, or bring a backend that is ` +
        `one: a \`Driver\` matched by the scheme of its url — a graph over Neo4j's Query API, ` +
        `a document store over CouchDB — makes the same four verbs work against it unchanged.`,
    );
  }
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
export { conform, conformanceReport } from "./conform.js";
export type { Conformance, Promised } from "./conform.js";
export { memoryDriver } from "./memory.js";
export { postgresDriver } from "./postgres.js";
export { sqliteDriver } from "./sqlite.js";
export { Wire, wireOptionsFrom } from "./wire.js";
export type { Held, WireOptions, WireResult } from "./wire.js";
export * from "./types.js";
