/**
 * Environments: a platform, signed in to once, and everything an agent may do there.
 *
 * An environment equips an app for one platform and one kind of work on it. It is a
 * plugin, and it adds what a platform a person signs in to always needs:
 *
 *   a sign-in      one click in a browser, nothing pasted
 *   connections    what each sign-in returned, kept in a vault
 *   accounts       what each connection reaches, each with a name and a mode
 *   actions        calls that name an account; the environment finds the connection
 *   a guard        what each kind of action needs before it runs
 *   an intake      the platform calling back, as events
 *   a doctor       what is missing, in one list
 *
 * An agent is never shown a token or a platform id. It is shown names, and what each
 * named account allows.
 */

import { join } from "node:path";

import type { Authority, Verdict } from "../authority.js";
import { callDigest } from "../classifier.js";
import type { ResolvedService } from "../compile/services.js";
import type { Action, Attempt, FunctionInput, FunctionRunOptions, Plugin, PluginContext, Publish, Trust } from "../define.js";
import { McpClient } from "../harness/mcp.js";
import { readState, updateState } from "../private.js";
import { authorize, renew, type AuthorizationCode, type Grant, type SignInTools } from "./signin.js";
import { defaultVault, type Vault } from "./vault.js";

export { fileVault, keychainVault, memoryVault, secretCipher, type Vault } from "./vault.js";
export type { AuthorizationCode, Grant } from "./signin.js";

// ── What an environment is declared with ───────────────────────────────────

/** How far an account may be acted on. New accounts start at `read`. */
export type Mode = "read" | "draft" | "act";

/** The kind of thing an action does, which decides what it needs before it runs. */
export type ActionClass = "read" | "draft" | "publish" | "send" | "spend" | "destroy";

const MODES: readonly Mode[] = ["read", "draft", "act"];
const CLASSES: ReadonlySet<string> = new Set<ActionClass>(["read", "draft", "publish", "send", "spend", "destroy"]);

/** A credential that already lives on the machine: nothing to sign in to, only to find. */
export interface LocalSignIn {
  kind: "local";
  /** Say what is here, or nothing when it is absent. */
  find(tools: { env: Record<string, string | undefined> }): Promise<{ id: string; label: string } | undefined>;
}

/** A service identity whose token the operator placed in an environment variable. */
export interface TokenSignIn {
  kind: "token";
  /** The NAME of the variable. */
  variable: string;
}

export type SignIn = AuthorizationCode | LocalSignIn | TokenSignIn;

/** Something on the platform a sign-in is presented to: an MCP server, an API, or both. */
export interface Resource {
  /** The address of the platform's MCP server. */
  mcp?: string;
  /** The base address of the platform's API. */
  api?: string;
  /** For an MCP server: what each of its tools does. */
  classes?: Record<string, ActionClass>;
  /** What a tool not listed in `classes` is taken to do. `publish` unless said. */
  otherwise?: ActionClass;
  /**
   * Sign in to this resource by itself, for a platform that will not take the one
   * sign-in here. It follows the first in the same browser, so the person signs in once
   * and agrees twice.
   */
  separate?: boolean;
  /** What to ask for when it is signed in to by itself. */
  scopes?: string[];
}

/** Limits on one account, in that account's own unit. */
export interface AccountLimits {
  /** The most one action may commit. */
  perAction?: number;
  /** The most all actions may commit in one day. */
  perDay?: number;
  /** An amount at or under this needs no approval. Absent, every spend is approved. */
  approveAbove?: number;
}

/** One thing a connection reaches. */
export interface Account {
  kind: string;
  /** The platform's own id. Never shown to an agent. */
  id: string;
  name: string;
  /** The name agents and people use. */
  alias: string;
  parent?: string;
  mode: Mode;
  limits?: AccountLimits;
  /** Classes that need no approval on this account. `spend` and `destroy` cannot be waived. */
  waive?: ActionClass[];
  /** The connections that reach it. */
  routes: string[];
  /** Whatever else is worth showing an agent: a currency, a status. */
  facts?: Record<string, string>;
}

/** What `discover` returns for each thing found. */
export type FoundAccount = Pick<Account, "kind" | "id" | "name"> & {
  /** What it belongs to, as `kind:id`. Its name then starts with its parent's. */
  parent?: string;
  facts?: Record<string, string>;
};

/** A sign-in, as the environment remembers it. The secret part is in the vault. */
export interface ConnectionRecord {
  id: string;
  label: string;
  /** `app`, or the person it belongs to. */
  owner: string;
  scopes: string[];
  connectedAt: number;
  expiresAt?: number;
}

/** A connection, as an action or `discover` is handed it. */
export interface EnvironmentConnection extends ConnectionRecord {
  /** Call the platform's API with this connection. `path` is joined to the resource's `api`. */
  request(resource: string, path: string, init?: RequestInit): Promise<Response>;
  /** The platform's MCP server, with this connection. */
  mcp(resource: string): {
    tools(): Promise<{ name: string; description: string; inputSchema: Record<string, unknown> }[]>;
    call(tool: string, args: Record<string, unknown>): Promise<string>;
  };
  /**
   * The token itself, for a call nothing above can make. What it returns must not be
   * logged, returned from a function or shown to a model.
   */
  token(resource?: string): Promise<string>;
}

/** What an action is handed beside its arguments. */
export interface ActionContext extends FunctionRunOptions {
  /** The accounts its arguments named, by argument. */
  accounts: Record<string, Account>;
  /** The connection that reaches them for whoever this call is for. */
  connection: EnvironmentConnection;
}

/** One thing an agent can do in the environment. */
export interface ActionSpec {
  description: string;
  input?: Record<string, string>;
  schema?: Record<string, unknown>;
  /** Which arguments name an account, and of what kind. */
  accounts?: Record<string, string>;
  class: ActionClass;
  /** What the action commits, in the account's unit, for `spend`. */
  amount?(args: Record<string, unknown>): number | undefined;
  /** `untrusted` for anything that returns text written outside the app. */
  trust?: Trust;
  run(args: Record<string, unknown>, context: ActionContext): unknown | Promise<unknown>;
}

export interface EnvironmentCheck {
  name: string;
  run(environment: Environment): Promise<{ ok: boolean; detail?: string; fix?: string }>;
}

/** What the platform sent, read into events. */
export interface Arrived {
  /** Published as `<environment>.<type>`. */
  type: string;
  /** The platform's id of the account it concerns, where there is one. */
  account?: string;
  /** The platform's id for this delivery, so one sent twice is published once. */
  id?: string;
  data?: unknown;
}

export interface IntakeSpec {
  /** Answer the platform's subscription check, for a platform that makes one. */
  handshake?(url: URL, env: Record<string, string | undefined>): Response | undefined;
  /** Whether this delivery is the platform's. Anything but `true` is refused. */
  verify(request: Request, body: Uint8Array, env: Record<string, string | undefined>): boolean | Promise<boolean>;
  read(payload: unknown): Arrived[];
}

export interface EnvironmentSpec {
  /** Lower case, with dashes: `meta-marketing`. */
  name: string;
  /** One line on what the environment is for. */
  description?: string;
  signIn: SignIn;
  /** What to ask the platform for, by what the install is for. Higher modes include lower. */
  scopes?: Partial<Record<Mode, string[]>>;
  /** How far this install goes. `read` unless said. */
  profile?: Mode;
  resources?: Record<string, Resource>;
  /** What a connection reaches. */
  discover?(connection: EnvironmentConnection): Promise<FoundAccount[]>;
  actions?: Record<string, ActionSpec>;
  /** Make the platform itself hold an account to its mode and limits, where it can. */
  enforce?(account: Account, connection: EnvironmentConnection): Promise<void>;
  intake?: IntakeSpec;
  checks?: EnvironmentCheck[];
  /** Where sign-ins are kept. The keychain on a Mac, or a sealed file under `PRAECISE_VAULT_KEY`. */
  vault?: Vault;
  /** The skills, agents, workflows and anything else a plugin brings. */
  app?: Plugin["app"];
  hooks?: Plugin["hooks"];
  commands?: Plugin["commands"];
}

/** An environment: a plugin, and the means to use it from code. */
export interface Environment extends Plugin {
  readonly spec: EnvironmentSpec;
  /** Tell it where the app is. An app does this when it loads; code using it alone does it once. */
  use(context: Partial<PluginContext> & { root: string }): void;
  connect(options?: EnvironmentConnectOptions): Promise<ConnectionRecord>;
  disconnect(id: string): Promise<boolean>;
  connections(): Promise<ConnectionRecord[]>;
  /** Discover again and say what changed. */
  sync(): Promise<{ added: string[]; gone: string[]; total: number }>;
  accounts(filter?: { kind?: string; owner?: string }): Promise<Account[]>;
  setMode(alias: string, mode: Mode): Promise<Account>;
  setLimits(alias: string, limits: AccountLimits): Promise<Account>;
  rename(alias: string, to: string): Promise<Account>;
  /** Take a delivery from the platform and publish what it carried. */
  receive(request: Request, publish: Publish): Promise<Response>;
  doctor(): Promise<{ ok: boolean; name: string; detail?: string; fix?: string }[]>;
}

export interface EnvironmentConnectOptions {
  /** Who the connection belongs to. `app` unless said. */
  owner?: string;
  /** A name for it, where there will be several. */
  id?: string;
  open?: SignInTools["open"];
  out?: (line: string) => void;
  timeoutMs?: number;
}

// ── Small things ───────────────────────────────────────────────────────────

const atLeast = (mode: Mode, needed: Mode): boolean => MODES.indexOf(mode) >= MODES.indexOf(needed);

/** The mode an account must be in for a class of action. */
const needs = (kind: ActionClass): Mode => (kind === "read" ? "read" : kind === "draft" ? "draft" : "act");

const slug = (text: string): string =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unnamed";

const today = (): string => new Date().toISOString().slice(0, 10);

/** Join a path to a base address and refuse one that would leave it. */
function under(base: string, path: string): string {
  const root = new URL(base.endsWith("/") ? base : `${base}/`);
  const url = new URL(path.replace(/^\/+/, ""), root);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
    throw new Error(`"${path}" is not under ${root.origin}${root.pathname}`);
  }
  return url.toString();
}

interface Secret {
  grant: Grant;
  /** Grants for resources that are signed in to by themselves, by resource. */
  grants?: Record<string, Grant>;
}

type Ledger = Record<string, Record<string, number>>;

// ── The environment ────────────────────────────────────────────────────────

/** Declare an environment. What comes back is a plugin: list it in `plugins`. */
export function environment(spec: EnvironmentSpec): Environment {
  if (!/^[a-z][a-z0-9-]*$/.test(spec.name)) throw new Error(`an environment's name is lower case with dashes, and "${spec.name}" is not`);
  const prefix = spec.name.replace(/-/g, "_");
  const profile: Mode = spec.profile ?? "read";

  let where: { dir: string; env: Record<string, string | undefined>; fetch: typeof fetch } | undefined;
  let held: Vault | undefined;

  const at = (): NonNullable<typeof where> => {
    where ??= { dir: join(process.cwd(), ".praecise", "environments", spec.name), env: process.env, fetch };
    return where;
  };
  const vault = (): Vault => (held ??= spec.vault ?? defaultVault({ name: spec.name, dir: at().dir, env: at().env }));
  const file = (name: string): string => join(at().dir, name);

  const wanted = (): string[] => [
    ...new Set(MODES.filter((mode) => atLeast(profile, mode)).flatMap((mode) => spec.scopes?.[mode] ?? [])),
  ];

  // ── Connections ──

  const records = async (): Promise<ConnectionRecord[]> => (await readState<ConnectionRecord[]>(file("connections.json"))) ?? [];

  const grantOf = async (record: ConnectionRecord, resource?: string): Promise<Grant> => {
    if (spec.signIn.kind === "token") {
      const token = at().env[spec.signIn.variable];
      if (!token) throw new Error(`${spec.signIn.variable} is not set`);
      return { access_token: token };
    }
    if (spec.signIn.kind === "local") throw new Error(`the ${spec.name} environment's credential stays on this machine and is not a token`);
    const raw = await vault().get(record.id);
    if (!raw) throw new Error(`connection "${record.id}" has nothing in the vault; run: praecise ${spec.name} connect`);
    const secret = JSON.parse(raw) as Secret;
    const own = resource !== undefined && spec.resources?.[resource]?.separate === true;
    let grant = own ? secret.grants?.[resource] : secret.grant;
    if (!grant) throw new Error(`connection "${record.id}" has not signed in to ${resource}; run: praecise ${spec.name} connect`);
    const expiry = grant.expiresAt;
    if (expiry !== undefined && expiry - Date.now() < 60_000) {
      if (!grant.refresh_token) {
        throw new Error(`connection "${record.id}" has expired; run: praecise ${spec.name} connect`);
      }
      grant = await renew(spec.signIn, grant, at());
      const next: Secret = own ? { ...secret, grants: { ...secret.grants, [resource]: grant } } : { ...secret, grant };
      await vault().put(record.id, JSON.stringify(next));
      if (!own) {
        const until = grant.expiresAt;
        await updateState<ConnectionRecord[]>(file("connections.json"), undefined, () => [], (all) =>
          all.map((each) => (each.id === record.id ? { ...each, expiresAt: until } : each)),
        );
      }
    }
    return grant;
  };

  const handle = (record: ConnectionRecord): EnvironmentConnection => {
    const resource = (name: string): Resource => {
      const found = spec.resources?.[name];
      if (!found) throw new Error(`the ${spec.name} environment has no resource "${name}"`);
      return found;
    };
    const token = async (name?: string): Promise<string> => (await grantOf(record, name)).access_token;
    return {
      ...record,
      token,
      async request(name, path, init = {}) {
        const base = resource(name).api;
        if (!base) throw new Error(`resource "${name}" has no API address`);
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${await token(name)}`);
        return at().fetch(under(base, path), { ...init, headers });
      },
      mcp(name) {
        const url = resource(name).mcp;
        if (!url) throw new Error(`resource "${name}" has no MCP address`);
        const client = async (): Promise<McpClient> => {
          const service: ResolvedService = { name: `${spec.name}.${name}`, url, credential: "", auth: "bearer", apiKey: await token(name) };
          return new McpClient(service, at().fetch);
        };
        return {
          async tools() {
            const mcp = await client();
            try {
              return (await mcp.listTools()).map(({ name: tool, description, inputSchema }) => ({ name: tool, description, inputSchema }));
            } finally {
              mcp.close();
            }
          },
          async call(tool, args) {
            const mcp = await client();
            try {
              return await mcp.call(tool, args);
            } finally {
              mcp.close();
            }
          },
        };
      },
    };
  };

  const connect = async (options: EnvironmentConnectOptions = {}): Promise<ConnectionRecord> => {
    const owner = options.owner ?? "app";
    let id = options.id ?? (owner === "app" ? "default" : slug(owner));
    let label = id;
    let grant: Grant | undefined;
    if (spec.signIn.kind === "authorization_code") {
      const tools = { ...at(), open: options.open, out: options.out, timeoutMs: options.timeoutMs };
      grant = await authorize(spec.signIn, wanted(), tools);
      const grants: Record<string, Grant> = {};
      for (const [name, resource] of Object.entries(spec.resources ?? {})) {
        if (!resource.separate) continue;
        options.out?.(`One more page, for ${name}.`);
        grants[name] = await authorize(spec.signIn, resource.scopes ?? [], tools);
      }
      await vault().put(id, JSON.stringify({ grant, ...(Object.keys(grants).length ? { grants } : {}) } satisfies Secret));
    } else if (spec.signIn.kind === "token") {
      if (!at().env[spec.signIn.variable]) throw new Error(`${spec.signIn.variable} is not set`);
    } else {
      const found = await spec.signIn.find(at());
      if (!found) throw new Error(`nothing to connect: the ${spec.name} credential is not on this machine`);
      id = options.id ?? slug(found.id);
      label = found.label;
    }
    const record: ConnectionRecord = {
      id,
      label,
      owner,
      scopes: grant?.scope ?? wanted(),
      connectedAt: Date.now(),
      ...(grant?.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}),
    };
    await updateState<ConnectionRecord[]>(file("connections.json"), undefined, () => [], (all) => [
      ...all.filter((each) => each.id !== id),
      record,
    ]);
    return record;
  };

  const disconnect = async (id: string): Promise<boolean> => {
    let found = false;
    await updateState<ConnectionRecord[]>(file("connections.json"), undefined, () => [], (all) => {
      found = all.some((each) => each.id === id);
      return found ? all.filter((each) => each.id !== id) : undefined;
    });
    if (!found) return false;
    if (spec.signIn.kind === "authorization_code") await vault().delete(id);
    await updateState<Account[]>(file("accounts.json"), undefined, () => [], (all) =>
      all.map((each) => ({ ...each, routes: each.routes.filter((route) => route !== id) })).filter((each) => each.routes.length > 0),
    );
    return true;
  };

  // ── Accounts ──

  const everyAccount = async (): Promise<Account[]> => (await readState<Account[]>(file("accounts.json"))) ?? [];

  const accounts = async (filter: { kind?: string; owner?: string } = {}): Promise<Account[]> => {
    const all = await everyAccount();
    const owned = filter.owner === undefined ? undefined : new Set((await records()).filter((each) => each.owner === filter.owner).map((each) => each.id));
    return all.filter((each) => (!filter.kind || each.kind === filter.kind) && (!owned || each.routes.some((route) => owned.has(route))));
  };

  const sync = async (): Promise<{ added: string[]; gone: string[]; total: number }> => {
    if (!spec.discover) return { added: [], gone: [], total: (await everyAccount()).length };
    const found = new Map<string, FoundAccount & { routes: string[] }>();
    for (const record of await records()) {
      for (const each of await spec.discover(handle(record))) {
        const key = `${each.kind}:${each.id}`;
        const seen = found.get(key);
        if (seen) seen.routes.push(record.id);
        else found.set(key, { ...each, routes: [record.id] });
      }
    }
    const added: string[] = [];
    const gone: string[] = [];
    const next = await updateState<Account[]>(file("accounts.json"), undefined, () => [], (before) => {
      const known = new Map(before.map((each) => [`${each.kind}:${each.id}`, each]));
      const taken = new Set(before.map((each) => each.alias));
      const after: Account[] = [];
      const aliasOf = new Map<string, string>();
      // Parents first, so a child's name can start with its parent's.
      const ordered = [...found.entries()].sort(([, a], [, b]) => Number(Boolean(a.parent)) - Number(Boolean(b.parent)));
      for (const [key, each] of ordered) {
        const was = known.get(key);
        let alias = was?.alias;
        if (!alias) {
          const parent = each.parent ? aliasOf.get(each.parent) : undefined;
          const base = parent ? `${parent.split("/")[0]}/${slug(each.name)}` : slug(each.name);
          alias = base;
          for (let n = 2; taken.has(alias); n += 1) alias = `${base}-${n}`;
          taken.add(alias);
          added.push(alias);
        }
        aliasOf.set(key, alias);
        after.push({
          kind: each.kind,
          id: each.id,
          name: each.name,
          alias,
          ...(each.parent ? { parent: each.parent } : {}),
          mode: was?.mode ?? "read",
          ...(was?.limits ? { limits: was.limits } : {}),
          ...(was?.waive ? { waive: was.waive } : {}),
          routes: each.routes,
          ...(each.facts ? { facts: each.facts } : {}),
        });
      }
      for (const each of before) if (!found.has(`${each.kind}:${each.id}`)) gone.push(each.alias);
      return after;
    });
    return { added, gone, total: next.length };
  };

  const change = async (alias: string, edit: (account: Account, all: Account[]) => Account): Promise<Account> => {
    let changed: Account | undefined;
    await updateState<Account[]>(file("accounts.json"), undefined, () => [], (all) => {
      const index = all.findIndex((each) => each.alias === alias);
      const was = all[index];
      if (!was) throw new Error(`there is no account named "${alias}"`);
      changed = edit(was, all);
      return all.map((each, i) => (i === index ? changed! : each));
    });
    const account = changed!;
    if (spec.enforce) {
      const route = (await records()).find((each) => account.routes.includes(each.id));
      if (route) await spec.enforce(account, handle(route));
    }
    return account;
  };

  const setMode = (alias: string, mode: Mode): Promise<Account> => {
    if (!MODES.includes(mode)) throw new Error(`a mode is one of ${MODES.join(", ")}`);
    return change(alias, (account) => ({ ...account, mode }));
  };
  const setLimits = (alias: string, limits: AccountLimits): Promise<Account> =>
    change(alias, (account) => ({ ...account, limits: { ...account.limits, ...limits } }));
  const rename = (alias: string, to: string): Promise<Account> => {
    if (!/^[a-z0-9][a-z0-9/-]*$/.test(to)) throw new Error("a name is lower case letters, digits, dashes and slashes");
    return change(alias, (account, all) => {
      if (all.some((each) => each.alias === to)) throw new Error(`"${to}" already names an account`);
      return { ...account, alias: to };
    });
  };

  /** The accounts some arguments name, and the one connection that reaches them all for this caller. */
  const resolve = async (
    named: Record<string, string> | undefined,
    args: Record<string, unknown>,
    owner: string,
  ): Promise<{ accounts: Record<string, Account>; connection: EnvironmentConnection }> => {
    const all = await everyAccount();
    const mine = (await records()).filter((each) => each.owner === owner);
    if (mine.length === 0) {
      throw new Error(`Not connected: nobody has signed in to ${spec.name} for this request. Run: praecise ${spec.name} connect`);
    }
    const chosen: Record<string, Account> = {};
    let routes = mine.map((each) => each.id);
    for (const [argument, kind] of Object.entries(named ?? {})) {
      const value = args[argument];
      if (value === undefined || value === null || value === "") continue;
      const account = all.find((each) => each.alias === value && each.kind === kind);
      if (!account) {
        throw new Error(`Not allowed: "${String(value)}" is not the name of a ${kind} in ${spec.name}. List them with ${prefix}_accounts.`);
      }
      chosen[argument] = account;
      routes = routes.filter((route) => account.routes.includes(route));
    }
    const route = mine.find((each) => routes.includes(each.id));
    if (!route) throw new Error(`Not allowed: no connection of yours reaches ${Object.values(chosen).map((each) => each.alias).join(" and ")}`);
    return { accounts: chosen, connection: handle(route) };
  };

  /** The one connection of this owner's that reaches every one of some accounts. */
  const reaching = async (named: Account[], owner: string): Promise<EnvironmentConnection> => {
    const mine = (await records()).filter((each) => each.owner === owner);
    if (mine.length === 0) {
      throw new Error(`Not connected: nobody has signed in to ${spec.name} for this request. Run: praecise ${spec.name} connect`);
    }
    const route = mine.find((each) => named.every((account) => account.routes.includes(each.id)));
    if (!route) throw new Error(`Not allowed: no connection of yours reaches ${named.map((each) => each.alias).join(" and ")}`);
    return handle(route);
  };

  // ── The guard ──

  const spent = async (alias: string): Promise<number> => (await readState<Ledger>(file("ledger.json")))?.[alias]?.[today()] ?? 0;
  const record = async (alias: string, amount: number): Promise<void> => {
    await updateState<Ledger>(file("ledger.json"), undefined, () => ({}), (ledger) => {
      const day = today();
      return { ...ledger, [alias]: { [day]: (ledger[alias]?.[day] ?? 0) + amount } };
    });
  };

  const describe = (kind: ActionClass, aliases: string[], amount: number | undefined): Action => ({
    operation: kind,
    ...(aliases[0] ? { asset: aliases[0] } : {}),
    ...(amount !== undefined ? { amount: String(amount) } : {}),
    detail: { environment: spec.name, class: kind, accounts: aliases },
  });

  const authority: Authority = {
    async check(attempt: Attempt): Promise<Verdict> {
      const detail = attempt.action?.detail;
      if (!detail || detail.environment !== spec.name) return { allow: true };
      const kind = detail.class as ActionClass;
      if (!CLASSES.has(kind)) return { refuse: `Not allowed: ${attempt.tool} does not say what it does in ${spec.name}` };
      const all = await everyAccount();
      // An action says which accounts it names. A call to one of the platform's own tools
      // says every word it was given, and the accounts are the words that are names.
      const said = Array.isArray(detail.said) ? (detail.said as string[]) : undefined;
      const aliases = said ? all.filter((each) => said.includes(each.alias)).map((each) => each.alias) : Array.isArray(detail.accounts) ? (detail.accounts as string[]) : [];
      const amount = attempt.action?.amount !== undefined ? Number(attempt.action.amount) : undefined;
      const tainted = attempt.tainted === true || attempt.action?.tainted === true;
      let approval = kind === "destroy" || (tainted && kind !== "read" && kind !== "draft");

      if (aliases.length === 0 && kind !== "read") {
        return { refuse: `Not allowed: ${attempt.tool} names no account, and only reading is allowed without one` };
      }
      for (const alias of aliases) {
        const account = all.find((each) => each.alias === alias);
        if (!account) return { refuse: `Not allowed: there is no account named "${alias}" in ${spec.name}` };
        if (!atLeast(account.mode, needs(kind))) {
          return {
            refuse: `Not allowed: ${alias} is in ${account.mode} mode and this needs ${needs(kind)}. A person changes that with: praecise ${spec.name} mode ${alias} ${needs(kind)}`,
          };
        }
        if (kind === "spend") {
          if (amount === undefined || !Number.isFinite(amount) || amount < 0) {
            return { refuse: `Not allowed: ${attempt.tool} commits money on ${alias} and did not say how much` };
          }
          const limits = account.limits ?? {};
          if (limits.perAction !== undefined && amount > limits.perAction) {
            return { refuse: `Not allowed: ${amount} is over the limit of ${limits.perAction} for one action on ${alias}` };
          }
          if (limits.perDay !== undefined && (await spent(alias)) + amount > limits.perDay) {
            return { refuse: `Not allowed: this would pass the limit of ${limits.perDay} a day on ${alias}` };
          }
          if (limits.approveAbove === undefined || amount > limits.approveAbove) approval = true;
        }
        if ((kind === "publish" || kind === "send") && !account.waive?.includes(kind)) approval = true;
      }
      if (!approval) return { allow: true };
      const digest = callDigest(attempt);
      if (attempt.approvals?.some((each) => each.digest === digest)) return { allow: true };
      const what = `${kind} on ${aliases.join(", ")}${amount !== undefined ? ` of ${amount}` : ""}`;
      return { stepUp: `${spec.name}: ${what}`, digest };
    },
  };

  // ── Actions, as functions ──

  const ownerOf = (options: FunctionRunOptions | undefined): string => options?.caller?.person ?? "app";

  const functionFor = (name: string, action: ActionSpec): FunctionInput => {
    const named = Object.keys(action.accounts ?? {});
    const aliasesIn = (args: Record<string, unknown>): string[] =>
      named.map((argument) => args[argument]).filter((value): value is string => typeof value === "string" && value !== "");
    return {
      description: action.description,
      ...(action.input ? { input: action.input } : {}),
      ...(action.schema ? { schema: action.schema } : {}),
      effect: action.class === "read" ? "read" : action.class === "destroy" ? "destructive" : "write",
      ...(action.trust ? { trust: action.trust } : {}),
      ...(action.class === "read" ? {} : { action: (args: Record<string, unknown>) => describe(action.class, aliasesIn(args), action.amount?.(args)) }),
      async run(args: Record<string, unknown>, options?: FunctionRunOptions) {
        const resolved = await resolve(action.accounts, args, ownerOf(options));
        // Held here as well as by the authority, so an action used outside an app is still held to its account's mode.
        for (const account of Object.values(resolved.accounts)) {
          if (!atLeast(account.mode, needs(action.class))) {
            throw new Error(`Not allowed: ${account.alias} is in ${account.mode} mode and ${name} needs ${needs(action.class)}`);
          }
        }
        // The app's fetch where the call came through an app, and the environment's own otherwise.
        const result = await action.run(args, { ...options, fetch: options?.fetch ?? at().fetch, ...resolved });
        const amount = action.class === "spend" ? action.amount?.(args) : undefined;
        if (amount) for (const account of Object.values(resolved.accounts)) await record(account.alias, amount);
        return result;
      },
    } as FunctionInput;
  };

  const classOf = (resource: Resource, tool: string): ActionClass => resource.classes?.[tool] ?? resource.otherwise ?? "publish";

  /** The arguments an agent gave a platform tool, read from the text it gave them as. */
  const argumentsOf = (raw: unknown): Record<string, unknown> => {
    if (raw === undefined || raw === null || raw === "") return {};
    const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("arguments must be a JSON object");
    return value as Record<string, unknown>;
  };

  const mcpResources = Object.entries(spec.resources ?? {}).filter(([, resource]) => resource.mcp);

  const builtIn: Record<string, FunctionInput> = {
    [`${prefix}_accounts`]: {
      description: `List the ${spec.name} accounts this request can reach: each one's name, kind, mode and limits. Use the name wherever an account is asked for.`,
      input: { kind: "only this kind of account; leave empty for all" },
      effect: "read",
      async run(args: Record<string, unknown>, options?: FunctionRunOptions) {
        const kind = typeof args.kind === "string" && args.kind ? args.kind : undefined;
        return (await accounts({ kind, owner: ownerOf(options) })).map(({ alias, kind: of, name, mode, limits, facts }) => ({
          name: alias,
          kind: of,
          title: name,
          mode,
          ...(limits ? { limits } : {}),
          ...(facts ? { facts } : {}),
        }));
      },
    } as FunctionInput,
  };

  if (mcpResources.length > 0) {
    const names = mcpResources.map(([name]) => name).join(", ");
    builtIn[`${prefix}_tools`] = {
      description: `List what one of the ${spec.name} platform's own servers offers (${names}), with each tool's arguments.`,
      input: { server: `one of: ${names}` },
      effect: "read",
      async run(args: Record<string, unknown>, options?: FunctionRunOptions) {
        const server = String(args.server ?? "");
        const resource = spec.resources?.[server];
        if (!resource?.mcp) throw new Error(`there is no ${spec.name} server named "${server}"`);
        const connection = await reaching([], ownerOf(options));
        return (await connection.mcp(server).tools()).map((tool) => ({
          name: tool.name,
          does: classOf(resource, tool.name),
          description: tool.description,
          arguments: tool.inputSchema,
        }));
      },
    } as FunctionInput;

    /** Every piece of text anywhere in a tool's arguments. */
    const wordsIn = (value: unknown, found: string[] = []): string[] => {
      if (typeof value === "string") found.push(value);
      else if (Array.isArray(value)) for (const each of value) wordsIn(each, found);
      else if (typeof value === "object" && value !== null) for (const each of Object.values(value)) wordsIn(each, found);
      return found;
    };

    /** A tool's arguments with every account's name replaced by the platform's own id for it. */
    const withIds = (value: unknown, ids: Map<string, string>): unknown => {
      if (typeof value === "string") return ids.get(value) ?? value;
      if (Array.isArray(value)) return value.map((each) => withIds(each, ids));
      if (typeof value === "object" && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, withIds(each, ids)]));
      }
      return value;
    };

    /** An id long enough that it cannot be mistaken for a count or an amount. */
    const distinct = (id: string): boolean => id.length >= 6;

    /** What a platform's tool answered, with every account's id replaced by its name. */
    const withNames = (text: string, known: Account[]): string => {
      let out = text;
      for (const account of known) {
        if (!distinct(account.id)) continue;
        const id = account.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${id}(?![A-Za-z0-9_])`, "g"), account.alias);
      }
      return out;
    };

    const asked = (args: Record<string, unknown>): { server: string; resource: Resource; tool: string; given: Record<string, unknown> } => {
      const server = String(args.server ?? "");
      const resource = spec.resources?.[server];
      if (!resource?.mcp) throw new Error(`there is no ${spec.name} server named "${server}"`);
      return { server, resource, tool: String(args.tool ?? ""), given: argumentsOf(args.arguments) };
    };

    builtIn[`${prefix}_call`] = {
      description:
        `Call a tool on one of the ${spec.name} platform's own servers. Wherever a tool asks for an account, give the name ${prefix}_accounts lists for it, never an id. ` +
        `A call that changes anything must name the account it changes.`,
      input: {
        server: `one of: ${names}`,
        tool: `a tool name from ${prefix}_tools`,
        arguments: "the tool's arguments, as a JSON object",
      },
      effect: "write",
      trust: "untrusted",
      action: (args: Record<string, unknown>) => {
        const call = asked(args);
        const kind = classOf(call.resource, call.tool);
        // Reading asks for nothing, so it is described as nothing the guard has to weigh.
        if (kind === "read") return {} as Action;
        const amount = typeof call.given.amount === "number" ? call.given.amount : undefined;
        return {
          operation: kind,
          ...(amount !== undefined ? { amount: String(amount) } : {}),
          detail: { environment: spec.name, class: kind, said: wordsIn(call.given) },
        };
      },
      async run(args: Record<string, unknown>, options?: FunctionRunOptions) {
        const call = asked(args);
        const kind = classOf(call.resource, call.tool);
        const owner = ownerOf(options);
        const reachable = await accounts({ owner });
        const words = wordsIn(call.given);
        const byId = reachable.find((each) => distinct(each.id) && words.includes(each.id));
        if (byId) throw new Error(`Not allowed: name the account as "${byId.alias}", not by its id`);
        const named = reachable.filter((each) => words.includes(each.alias));
        if (kind !== "read" && named.length === 0) {
          throw new Error(`Not allowed: ${call.tool} changes something and names no account. Give the account's name from ${prefix}_accounts where the tool asks for one.`);
        }
        for (const account of named) {
          if (!atLeast(account.mode, needs(kind))) {
            throw new Error(`Not allowed: ${account.alias} is in ${account.mode} mode and ${call.tool} needs ${needs(kind)}`);
          }
        }
        const connection = await reaching(named, owner);
        const sent = withIds(call.given, new Map(named.map((each) => [each.alias, each.id]))) as Record<string, unknown>;
        return withNames(await connection.mcp(call.server).call(call.tool, sent), reachable);
      },
    } as FunctionInput;
  }

  const functions: Record<string, FunctionInput> = { ...builtIn };
  for (const [name, action] of Object.entries(spec.actions ?? {})) functions[name] = functionFor(name, action);

  // ── Intake ──

  const receive = async (request: Request, publish: Publish): Promise<Response> => {
    if (!spec.intake) return new Response("this environment takes no deliveries", { status: 404 });
    if (request.method === "GET") {
      return spec.intake.handshake?.(new URL(request.url), at().env) ?? new Response("nothing to check", { status: 404 });
    }
    if (request.method !== "POST") return new Response("POST a delivery", { status: 405 });
    const body = new Uint8Array(await request.arrayBuffer());
    let genuine = false;
    try {
      genuine = (await spec.intake.verify(request, body, at().env)) === true;
    } catch {
      genuine = false;
    }
    if (!genuine) return new Response("this delivery could not be verified", { status: 401 });
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return new Response("a delivery is JSON", { status: 400 });
    }
    const all = await everyAccount();
    for (const arrived of spec.intake.read(payload)) {
      const account = arrived.account ? all.find((each) => each.id === arrived.account) : undefined;
      await publish(`${spec.name}.${arrived.type}`, arrived.data, {
        ...(account ? { subject: account.alias } : {}),
        ...(arrived.id ? { id: `${spec.name}:${arrived.id}` } : {}),
      });
    }
    return new Response("ok");
  };

  // ── Doctor ──

  const doctor = async (): Promise<{ ok: boolean; name: string; detail?: string; fix?: string }[]> => {
    const lines: { ok: boolean; name: string; detail?: string; fix?: string }[] = [];
    const say = (ok: boolean, name: string, fix?: string, detail?: string): void =>
      void lines.push({ ok, name, ...(detail ? { detail } : {}), ...(ok || !fix ? {} : { fix }) });

    if (spec.signIn.kind === "authorization_code") {
      say(Boolean(spec.signIn.clientId), "a client id to sign in with", "give the environment its client id");
      let kind: string | undefined;
      try {
        kind = vault().kind;
      } catch {
        kind = undefined;
      }
      say(Boolean(kind), `somewhere safe to keep a sign-in${kind ? ` (${kind})` : ""}`, "set PRAECISE_VAULT_KEY");
    }
    const all = await records();
    say(all.length > 0, `signed in (${all.length} connection${all.length === 1 ? "" : "s"})`, `praecise ${spec.name} connect`);
    const want = wanted();
    for (const each of all) {
      const left = each.expiresAt === undefined ? undefined : each.expiresAt - Date.now();
      say(left === undefined || left > 7 * 86_400_000, `connection ${each.id} is good for more than a week`, `praecise ${spec.name} connect`,
        left === undefined ? undefined : left <= 0 ? "expired" : `${Math.floor(left / 86_400_000)} days left`);
      const missing = want.filter((scope) => !each.scopes.includes(scope));
      say(missing.length === 0, `connection ${each.id} was granted what this install asks for`, `praecise ${spec.name} connect`,
        missing.length ? `missing: ${missing.join(", ")}` : undefined);
    }
    if (spec.discover) {
      const known = await everyAccount();
      say(known.length > 0, `accounts found (${known.length})`, `praecise ${spec.name} sync`);
    }
    for (const check of spec.checks ?? []) {
      try {
        const said = await check.run(self);
        say(said.ok, check.name, said.fix, said.detail);
      } catch (err) {
        say(false, check.name, undefined, (err as Error).message);
      }
    }
    return lines;
  };

  // ── Commands ──

  type Run = NonNullable<Plugin["commands"]>[string]["run"];
  const inRoot = (run: Run): Run => (argv, ctx) => {
    where ??= { dir: join(ctx.root, ".praecise", "environments", spec.name), env: process.env, fetch };
    return run(argv, ctx);
  };
  const failing = (run: Run): Run => async (argv, ctx) => {
    try {
      return await run(argv, ctx);
    } catch (err) {
      ctx.out((err as Error).message);
      return 1;
    }
  };
  const command = (describeIt: string, run: Run): NonNullable<Plugin["commands"]>[string] => ({ describe: describeIt, run: inRoot(failing(run)) });
  const flag = (flags: Record<string, string | true>, name: string): string | undefined => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);

  const commands: NonNullable<Plugin["commands"]> = {
    connect: command(`Sign in to ${spec.name}.`, async (_argv, ctx) => {
      const made = await connect({ owner: flag(ctx.flags, "for"), id: flag(ctx.flags, "as"), out: ctx.out });
      ctx.out(`connected: ${made.id}${made.label !== made.id ? ` (${made.label})` : ""}`);
      if (spec.discover) {
        const found = await sync();
        ctx.out(`${found.total} account${found.total === 1 ? "" : "s"} found, all new ones in read mode`);
      }
      return 0;
    }),
    connections: command("List the sign-ins.", async (_argv, ctx) => {
      const all = await records();
      if (all.length === 0) ctx.out("none");
      for (const each of all) {
        const until = each.expiresAt === undefined ? "" : `  until ${new Date(each.expiresAt).toISOString().slice(0, 10)}`;
        ctx.out(`${each.id.padEnd(20)} ${each.owner.padEnd(16)}${until}`);
      }
      return 0;
    }),
    disconnect: command("Forget a sign-in and the accounts only it reached.", async (argv, ctx) => {
      const id = argv[0] ?? "default";
      const done = await disconnect(id);
      ctx.out(done ? `disconnected: ${id}` : `there is no connection named "${id}"`);
      return done ? 0 : 1;
    }),
    sync: command("Find what the sign-ins reach again.", async (_argv, ctx) => {
      const found = await sync();
      for (const alias of found.added) ctx.out(`new      ${alias}`);
      for (const alias of found.gone) ctx.out(`gone     ${alias}`);
      ctx.out(`${found.total} account${found.total === 1 ? "" : "s"}`);
      return 0;
    }),
    accounts: command("List the accounts, with each one's mode and limits.", async (_argv, ctx) => {
      const all = await accounts({ kind: flag(ctx.flags, "kind") });
      if (all.length === 0) ctx.out("none");
      for (const each of all) {
        const limits = each.limits ? `  ${Object.entries(each.limits).map(([key, value]) => `${key}=${value}`).join(" ")}` : "";
        ctx.out(`${each.alias.padEnd(32)} ${each.kind.padEnd(20)} ${each.mode.padEnd(6)}${limits}`);
      }
      return 0;
    }),
    mode: command("Set how far an account may be acted on: read, draft or act.", async (argv, ctx) => {
      const [alias, mode] = argv;
      if (!alias || !mode) {
        ctx.out(`usage: praecise ${spec.name} mode <account> <read|draft|act>`);
        return 1;
      }
      const account = await setMode(alias, mode as Mode);
      ctx.out(`${account.alias} is now in ${account.mode} mode`);
      return 0;
    }),
    limits: command("Set an account's limits: perAction=, perDay=, approveAbove=.", async (argv, ctx) => {
      const [alias, ...pairs] = argv;
      if (!alias || pairs.length === 0) {
        ctx.out(`usage: praecise ${spec.name} limits <account> perAction=100 perDay=500 approveAbove=50`);
        return 1;
      }
      const limits: AccountLimits = {};
      for (const pair of pairs) {
        const [key, value] = pair.split("=");
        if (key !== "perAction" && key !== "perDay" && key !== "approveAbove") throw new Error(`"${key}" is not a limit`);
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount < 0) throw new Error(`"${value}" is not an amount`);
        limits[key] = amount;
      }
      const account = await setLimits(alias, limits);
      ctx.out(`${account.alias}: ${Object.entries(account.limits ?? {}).map(([key, value]) => `${key}=${value}`).join(" ")}`);
      return 0;
    }),
    rename: command("Give an account a different name.", async (argv, ctx) => {
      const [alias, to] = argv;
      if (!alias || !to) {
        ctx.out(`usage: praecise ${spec.name} rename <account> <new name>`);
        return 1;
      }
      ctx.out(`${alias} is now ${(await rename(alias, to)).alias}`);
      return 0;
    }),
    doctor: command(`Say what is missing for ${spec.name}.`, async (_argv, ctx) => {
      const lines = await doctor();
      for (const line of lines) {
        ctx.out(`${line.ok ? "ok     " : "MISSING"}  ${line.name}${line.detail ? ` (${line.detail})` : ""}${line.fix ? `  ->  ${line.fix}` : ""}`);
      }
      const missing = lines.filter((line) => !line.ok).length;
      ctx.out(missing ? `${missing} missing` : "ready");
      return missing ? 1 : 0;
    }),
    ...spec.commands,
  };

  const self: Environment = {
    name: spec.name,
    spec,
    app: { ...spec.app, functions: { ...functions, ...spec.app?.functions } },
    ...(spec.hooks ? { hooks: spec.hooks } : {}),
    commands,
    authority,
    ...(spec.intake ? { deliveries: { [`/environments/${spec.name}/intake`]: (request: Request, publish: Publish) => receive(request, publish) } } : {}),
    setup(context) {
      where = { dir: join(context.stateDir, "environments", spec.name), env: context.env, fetch: context.fetch };
      held = undefined;
    },
    use(context) {
      where = {
        dir: join(context.stateDir ?? join(context.root, ".praecise"), "environments", spec.name),
        env: context.env ?? process.env,
        fetch: context.fetch ?? fetch,
      };
      held = undefined;
    },
    connect,
    disconnect,
    connections: records,
    sync,
    accounts,
    setMode,
    setLimits,
    rename,
    receive,
    doctor,
  };
  return self;
}
