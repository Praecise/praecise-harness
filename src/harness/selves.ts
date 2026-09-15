/**
 * Selves: an agent that remembers who it is.
 *
 * An agent is its role, its rules and its tools, and it starts every request
 * from them. A self is what persists around an agent: an identity, what it has
 * learned, what it has been reading, and what came of its earlier work. An
 * agent declares the self it is (`self: "design"`) and the harness does the
 * rest on every request, in whichever way the agent was reached:
 *
 *   before  the self's context for this request is read and placed after
 *           everything stable in the system prompt, as the self's own notes
 *   after   what was asked and answered is recorded against the ticket the
 *           context came with, so what comes of it later can be credited
 *
 * The provider is an interface, so where selves live is the app's choice.
 * `selvesOverHttp` speaks the self-provider protocol over HTTP:
 *
 *   PUT  {url}/selves/{handle}          ensure a self exists (admin credential)
 *   POST {url}/selves/{handle}/context  {surface, task, interactive} → {preamble, ticket, lessons}
 *   POST {url}/tickets/{ticket}/work    {brief}
 *   POST {url}/tickets/{ticket}/outcome {signal: -1..1, label, detail?, by?}
 *
 * A self is memory, not a dependency: if the provider cannot be reached the
 * agent answers as it would have without it and says so in a note, unless the
 * app declared `required: true`.
 *
 * Tickets that reach a browser are bound to the person they were issued to
 * with an HMAC, so a rating cannot be made on somebody else's answer.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** What an agent declares. A bare string is a handle. */
export type SelfDeclaration =
  | string
  | {
      /**
       * The self's handle. May contain `{person}`, filled from the caller, for a
       * self per person: `"coach-{person}"`.
       */
      handle: string;
      /** Where this agent is being asked, for the self's per-surface persona. Default: the app's `selves.surface`, else "agent". */
      surface?: string;
      /**
       * What to create the self from the first time it is asked for, when it does
       * not exist yet. Needs the admin credential. Left out, the self must already
       * exist.
       */
      template?: SelfTemplate;
    };

/** What a self is created from. The provider owns what each field means. */
export interface SelfTemplate {
  name: string;
  charter: { purpose: string; answersTo?: string; [key: string]: unknown };
  persona?: Record<string, unknown>;
  routine?: Record<string, unknown>;
  interests?: string[];
  identity?: Array<{ kind: string; key: string; value: unknown }>;
  /** Filled with the caller's person when the handle is per person. */
  subject?: string;
  orient?: boolean;
  [key: string]: unknown;
}

/** A declaration after planning: always an object, `perPerson` worked out. */
export interface SelfPlan {
  handle: string;
  surface?: string;
  template?: SelfTemplate;
  perPerson: boolean;
}

export function planSelf(declared: SelfDeclaration | undefined): SelfPlan | undefined {
  if (declared === undefined) return undefined;
  const d = typeof declared === "string" ? { handle: declared } : declared;
  return { handle: d.handle, surface: d.surface, template: d.template, perPerson: d.handle.includes("{person}") };
}

/** Problems with a declaration, for loading. Pure. */
export function selfFaults(declared: SelfDeclaration | undefined): string[] {
  if (declared === undefined) return [];
  const d = typeof declared === "string" ? { handle: declared } : declared;
  const faults: string[] = [];
  if (typeof d.handle !== "string" || !d.handle.trim()) faults.push("`self` needs a handle");
  else if (!/^[a-z0-9{][a-z0-9{}-]*$/.test(d.handle.replace("{person}", "p"))) faults.push("a self's handle is lowercase letters, digits and dashes, with {person} where it is per person");
  if (typeof declared === "object" && declared.template && !declared.template.charter?.purpose) faults.push("a self's template needs charter.purpose: a self must be for something");
  return faults;
}

/**
 * The handle for one request. A per-person handle needs a person; the person is
 * reduced to a stable digest so the handle does not reveal who they are.
 */
export function handleFor(plan: SelfPlan, person: string | undefined): string | undefined {
  if (!plan.perPerson) return plan.handle;
  if (!person) return undefined;
  const digest = createHmac("sha256", "praecise.self.person").update(person).digest("hex").slice(0, 12);
  return plan.handle.replace("{person}", digest);
}

/** What the harness receives before a request. */
export interface SelfContext {
  /** The self's notes, placed in the system prompt. */
  preamble: string;
  /** Present when the provider will accept work and outcomes for this request. */
  ticket?: string;
  /** What the self holds as learned, in plain words, for "what it drew on". */
  drewOn?: string[];
}

/** What an answer carries about the self that gave it. */
export interface AnswerSelf {
  handle: string;
  /**
   * What a verdict on this answer is given with. Bound to the caller's person when
   * the app has a ticket secret (`bound`), and then safe to hand to their browser;
   * otherwise the provider's own ticket, for the app's server alone.
   */
  ticket?: string;
  bound: boolean;
  drewOn: string[];
}

/** The provider and how the app depends on it, as the harness holds them. */
export interface SelvesRuntime {
  provider: SelfProvider;
  surface?: string;
  required?: boolean;
  /** Binds tickets to people. Without it, tickets are raw and must not reach a browser. */
  ticketSecret?: string;
}

/**
 * The runtime an app's config and environment describe, or undefined when they
 * describe none. An explicit provider wins over configuration.
 */
export function selvesFrom(
  config: { selves?: { url?: string; credential?: string; adminCredential?: string; ticketCredential?: string; surface?: string; required?: boolean; timeoutMs?: number } } | undefined,
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
  provider?: SelfProvider,
): SelvesRuntime | undefined {
  const declared = config?.selves;
  const secret = env[declared?.ticketCredential ?? "SELVES_TICKET_SECRET"] || undefined;
  if (provider) return { provider, surface: declared?.surface, required: declared?.required, ticketSecret: secret };
  const url = declared?.url ?? env.SELVES_URL;
  const key = env[declared?.credential ?? "SELVES_KEY"];
  if (!url || !key) return undefined;
  return {
    provider: selvesOverHttp({ url, key, adminKey: env[declared?.adminCredential ?? "SELVES_ADMIN_KEY"] || undefined, fetch: fetchImpl, timeoutMs: declared?.timeoutMs }),
    surface: declared?.surface,
    required: declared?.required,
    ticketSecret: secret,
  };
}

export interface SelfVerdict {
  /** From -1 (it did harm) to 1 (it helped). */
  signal: number;
  label: string;
  detail?: string;
  by?: string;
}

export interface SelfProvider {
  context(handle: string, request: { surface: string; task: string; interactive: boolean; template?: SelfTemplate }): Promise<SelfContext | undefined>;
  record(ticket: string, work: { task: string; answer: string; tools: string[] }): Promise<void>;
  outcome(ticket: string, verdict: SelfVerdict): Promise<void>;
}

/* ── Tickets bound to a person ─────────────────────────────────────────── */

export function signTicket(secret: string, ticket: string, person: string | undefined): string {
  const mac = createHmac("sha256", secret).update(`${ticket}.${person ?? ""}`).digest("base64url");
  return `${ticket}.${mac}`;
}

/** The raw ticket, if `signed` was issued to this person under this secret; otherwise undefined. */
export function openTicket(secret: string, signed: string, person: string | undefined): string | undefined {
  const cut = signed.lastIndexOf(".");
  if (cut <= 0 || !secret) return undefined;
  const ticket = signed.slice(0, cut);
  const want = createHmac("sha256", secret).update(`${ticket}.${person ?? ""}`).digest();
  const got = Buffer.from(signed.slice(cut + 1), "base64url");
  return got.length === want.length && timingSafeEqual(got, want) ? ticket : undefined;
}

/* ── The HTTP provider ─────────────────────────────────────────────────── */

export interface HttpSelvesOptions {
  url: string;
  /** Member credential: context, work, outcomes. */
  key: string;
  /** Admin credential: creating a self from a template on first use. Optional. */
  adminKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

class SelfProviderError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function selvesOverHttp(options: HttpSelvesOptions): SelfProvider {
  const base = options.url.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const timeout = options.timeoutMs ?? 8_000;
  const ensured = new Set<string>();

  const call = async (method: string, path: string, body: unknown, key = options.key): Promise<Record<string, unknown>> => {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new SelfProviderError(res.status, String(json.error ?? `the self provider answered ${res.status}`));
    return json;
  };

  return {
    async context(handle, request) {
      const path = `/selves/${encodeURIComponent(handle)}/context`;
      const body = { surface: request.surface, task: request.task.slice(0, 2000), interactive: request.interactive };
      let served: Record<string, unknown>;
      try {
        served = await call("POST", path, body);
      } catch (err) {
        // A self asked for by template that does not exist yet is created once, then asked again.
        if (!(err instanceof SelfProviderError && err.status === 404 && request.template && options.adminKey && !ensured.has(handle))) throw err;
        await call("PUT", `/selves/${encodeURIComponent(handle)}`, { orient: false, ...request.template }, options.adminKey);
        ensured.add(handle);
        served = await call("POST", path, body);
      }
      const lessons = Array.isArray(served.lessons) ? (served.lessons as Array<{ claim?: unknown; status?: unknown }>) : [];
      return {
        preamble: typeof served.preamble === "string" ? served.preamble : "",
        ticket: typeof served.ticket === "string" ? served.ticket : undefined,
        drewOn: lessons.filter((l) => l.status === "held" && typeof l.claim === "string").map((l) => String(l.claim)),
      };
    },
    async record(ticket, work) {
      const asked = work.task.replace(/\s+/g, " ").trim().slice(0, 300);
      const said = work.answer.replace(/\s+/g, " ").trim().slice(0, 900);
      await call("POST", `/tickets/${encodeURIComponent(ticket)}/work`, { brief: asked ? `Asked: “${asked}”. Answered: ${said}` : `Answered: ${said}` });
    },
    async outcome(ticket, verdict) {
      const signal = Math.max(-1, Math.min(1, Number(verdict.signal)));
      await call("POST", `/tickets/${encodeURIComponent(ticket)}/outcome`, { signal, label: verdict.label, detail: verdict.detail, by: verdict.by });
    },
  };
}

/** The self's notes as they are placed in a system prompt. Pure. */
export function renderSelf(context: SelfContext): string {
  const notes = context.preamble.trim();
  return notes ? `Your own notes, from earlier work (they are yours, not the person's words; your tools and sources outrank them):\n${notes}` : "";
}
