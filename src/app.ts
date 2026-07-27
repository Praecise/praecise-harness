/**
 * The app: a loaded project plus everything needed to answer with it.
 *
 * The CLI and the dev server both talk to this and nothing below it. Loading is
 * cheap and repeatable, so a file change is handled by building a whole new app
 * rather than by patching a live one.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { planProject, planWorkflowAgent, type AgentPlan } from "./compile/plan.js";
import { resolveServices } from "./compile/services.js";
import type { AppConfig, FileContents, WorkflowSpec } from "./define.js";
import { deriveFiles, writeFiles, type WriteResult } from "./project/install.js";
import { NoteBook, consolidate, type Candidate, type Note } from "./harness/consolidate.js";
import { resolveHarness, stateDirFor } from "./harness/index.js";
import { Memory, StoredMemory, type Episode, type Recollection } from "./harness/memory.js";
import { Threads } from "./harness/threads.js";
import { McpClient, collectTools, splitToolName } from "./harness/mcp.js";
import { stream } from "./harness/stream.js";
import type { Answer, AskOptions, Harness, Progress } from "./harness/types.js";
import { loadProject, type Project } from "./project/load.js";
import { Stores } from "./stores/index.js";
import type { Driver, Store } from "./stores/types.js";
import { provisioner, type Manifest } from "./workflow/provision.js";
import { resumeRun, startRun, type WorkflowDeps } from "./workflow/run.js";
import { RunStore, type Run } from "./workflow/store.js";

export interface AppOptions {
  root?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Cache-busting suffix so a reload re-imports changed modules. */
  revision?: string;
  /**
   * What the app is called and which version it is, when that cannot be read
   * from the folder. A packaged app is unpacked wherever the installer likes,
   * so it must carry its own identity rather than take the directory's.
   */
  name?: string;
  version?: string;
  /** Force a provider instead of using credential precedence. */
  prefer?: string;
  /**
   * Backends this app brings. One ships with the framework; a store whose url
   * names anything else is opened by whichever of these answers to its scheme.
   */
  drivers?: Driver[];
}

export class App {
  readonly root: string;
  readonly project: Project;
  readonly config: AppConfig;
  readonly plans: Record<string, AgentPlan>;
  readonly stateDir: string;
  readonly runs: RunStore;
  readonly stores: Stores;
  /** Conversations, which sit here between turns rather than with the caller. */
  readonly threads: Threads;

  private readonly harness: Harness;
  private readonly notes: NoteBook;
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: typeof fetch;
  private readonly clients = new Map<string, McpClient>();
  private stepPlans = new Map<string, Promise<AgentPlan>>();
  private described?: Promise<Manifest>;

  private readonly identity: { name?: string; version?: string };

  private constructor(init: {
    root: string;
    project: Project;
    plans: Record<string, AgentPlan>;
    harness: Harness;
    env: Record<string, string | undefined>;
    fetchImpl: typeof fetch;
    stores: Stores;
    threads: Threads;
    identity?: { name?: string; version?: string };
  }) {
    this.identity = init.identity ?? {};
    this.root = init.root;
    this.project = init.project;
    this.config = init.project.config;
    this.plans = init.plans;
    this.harness = init.harness;
    this.env = init.env;
    this.fetchImpl = init.fetchImpl;
    this.stateDir = stateDirFor(init.root, init.project.config);
    this.notes = new NoteBook(this.stateDir);
    this.runs = new RunStore(resolve(this.stateDir, "runs"));
    this.threads = init.threads;
    this.stores = init.stores;
  }

  static async load(options: AppOptions = {}): Promise<App> {
    const root = resolve(options.root ?? process.cwd());
    const env = options.env ?? process.env;
    const fetchImpl = options.fetch ?? fetch;

    const project = await loadProject(root, { version: options.revision });
    const plans = await planProject(project, { env, prefer: options.prefer });
    const stores = new Stores(project.stores, {
      stateDir: stateDirFor(root, project.config),
      env,
      drivers: options.drivers,
    });
    // Made here rather than in the runtime, so that what answers a request and
    // what lists the conversations are the same conversations.
    const threads = new Threads(join(stateDirFor(root, project.config), "threads"));

    const harness = await resolveHarness({
      root,
      config: project.config,
      fetch: fetchImpl,
      stores,
      guard: project.guard,
      threads,
    });

    return new App({
      root,
      project,
      plans,
      harness,
      env,
      fetchImpl,
      stores,
      threads,
      identity: { name: options.name, version: options.version },
    });
  }

  get name(): string {
    return this.identity.name ?? this.project.name;
  }

  /** What this app calls itself when published. */
  get version(): string {
    return this.identity.version ?? this.config.version ?? "0.1.0";
  }

  get agentNames(): string[] {
    return Object.keys(this.plans).sort();
  }

  get workflowNames(): string[] {
    return Object.keys(this.project.workflows).sort();
  }

  /** Everything that is wrong but not fatal: bad files, missing credentials. */
  get problems(): string[] {
    return [
      ...this.project.warnings,
      ...Object.values(this.plans).flatMap((plan) =>
        plan.problems.map((problem) => `${plan.name}: ${problem}`),
      ),
    ];
  }

  /**
   * Read back an agent's record and propose what it should carry forward.
   *
   * Nothing is adopted here. The proposal lands beside the record for someone
   * to look at, and the record itself is left exactly as it was.
   */
  async propose(agent: string): Promise<Candidate> {
    const plan = this.plans[agent];
    if (!plan) throw new Error(`no agent named "${agent}"`);

    const candidate = await consolidate(this.harness, plan, await this.remembering(plan).all(agent));
    await this.notes.propose(candidate);
    return candidate;
  }

  /** The record an agent kept, oldest first. What was said, not what it learned. */
  recorded(agent: string, limit?: number): Promise<Episode[]> {
    const plan = this.plans[agent];
    if (!plan) throw new Error(`no agent named "${agent}"`);
    return this.remembering(plan).all(agent, limit);
  }

  /**
   * Take one exchange back, leaving a note where it was.
   *
   * The record still shows that something happened and when. What it no longer
   * shows is what was said, and the agent will not answer from it again.
   */
  redact(agent: string, id: string, note: string): Promise<boolean> {
    const plan = this.plans[agent];
    if (!plan) throw new Error(`no agent named "${agent}"`);
    if (!note.trim()) throw new Error("redacting leaves a note behind: say what to leave");
    return this.remembering(plan).redact(agent, id, note);
  }

  /** Files unless the agent named a store — the rule the runtime follows too. */
  private remembering(plan: AgentPlan): Recollection {
    const name = plan.memoryStore;
    if (!name) return new Memory(this.stateDir);
    return new StoredMemory(() => this.stores.open(name));
  }

  /** The proposal waiting on an agent, if there is one. */
  pending(agent: string): Promise<Candidate | undefined> {
    return this.notes.pending(agent);
  }

  /** Adopt a proposal, in whole or by position. */
  accept(agent: string, keep?: number[]): Promise<Note[]> {
    return this.notes.accept(agent, keep);
  }

  /** Throw a proposal away. */
  reject(agent: string): Promise<void> {
    return this.notes.reject(agent);
  }

  /** What an agent currently carries into every conversation. */
  learned(agent: string): Promise<Note[]> {
    return this.notes.notes(agent);
  }

  /** Ask an agent. Recall and persistence happen inside the harness. */
  async ask(agent: string, input: string, options: AskOptions = {}): Promise<Answer> {
    const plan = this.plans[agent];
    if (!plan) throw new Error(`no agent named "${agent}"`);

    const wrapper = this.project.middleware;
    if (!wrapper) return this.harness.ask(plan, input, options);

    // Middleware may substitute the reply, so the answer is rebuilt around what
    // it returns while keeping the accounting from the call that really ran.
    let answer: Answer | undefined;
    const reply = await wrapper.run(
      { agent, input, quality: plan.quality },
      async () => {
        answer = await this.harness.ask(plan, input, options);
        return { text: answer.text, data: answer.data };
      },
    );

    if (!answer) {
      return {
        text: reply.text,
        data: reply.data,
        path: [],
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, decidingTokens: 0 },
        toolCalls: [],
        harness: "middleware",
      };
    }
    return { ...answer, text: reply.text, data: reply.data };
  }

  /**
   * Ask an agent and read what happens in order, ending in `done` or `failed`.
   *
   * Middleware may replace the text of a reply after the fact, and a fragment
   * already handed over cannot be replaced. So where one is installed the work
   * is still reported as it happens and only the answer waits until it is
   * final; without one, text arrives as it is written.
   */
  async *watch(agent: string, input: string, options: AskOptions = {}): AsyncGenerator<Progress> {
    const plan = this.plans[agent];
    if (!plan) throw new Error(`no agent named "${agent}"`);

    const held = Boolean(this.project.middleware);
    const through: Harness = {
      name: this.harness.name,
      ask: (_plan, text, opts) => this.ask(agent, text, opts),
    };

    for await (const event of stream(through, plan, input, options)) {
      if (held && event.kind === "text") continue;
      yield event;
    }
  }

  /** Call a local function or `service.tool` directly, as a `use` step does. */
  async callTool(ref: string, args: unknown): Promise<unknown> {
    const local = this.project.functions[ref];
    if (local) return local.run((args ?? {}) as Record<string, unknown>);

    const split = splitToolName(ref) ?? refParts(ref);
    if (!split) throw new Error(`no function or tool named "${ref}"`);

    const client = await this.clientFor(split.service);
    return client.call(split.tool, (args ?? {}) as Record<string, unknown>);
  }

  /** What a `plan` step may build from: every agent, function, and service tool. */
  private manifest(): Promise<Manifest> {
    return (this.described ??= this.describe());
  }

  private async describe(): Promise<Manifest> {
    const tools: Manifest["tools"] = Object.entries(this.project.functions).map(
      ([name, spec]) => ({ name, description: spec.description }),
    );
    for (const name of this.agentNames) {
      for (const tool of await this.toolsFor(name)) {
        if (!tools.some((known) => known.name === tool.name)) tools.push(tool);
      }
    }
    return {
      agents: this.agentNames.map((name) => ({
        name,
        description: this.plans[name]!.description,
      })),
      tools,
    };
  }

  private async clientFor(service: string): Promise<McpClient> {
    const existing = this.clients.get(service);
    if (existing) return existing;

    const { services, problems } = resolveServices([service], this.project.tools, this.env);
    const resolved = services[0];
    if (!resolved) throw new Error(problems[0] ?? `unknown service "${service}"`);
    if (!resolved.apiKey) {
      throw new Error(`service "${service}" needs ${resolved.credential} to be set`);
    }

    const client = new McpClient(resolved, this.fetchImpl);
    this.clients.set(service, client);
    return client;
  }

  private workflowDeps(spec: WorkflowSpec): WorkflowDeps {
    const planFor = (agent: string | undefined, quality?: AgentPlan["quality"]) =>
      this.planFor(spec, agent, quality);
    return {
      harness: this.harness,
      store: this.runs,
      limits: this.config.limits,
      callTool: (ref, args) => this.callTool(ref, args),
      planFor,
      provision: provisioner({
        harness: this.harness,
        // Laying out work is judgement, so it is asked at the workflow's own
        // quality rather than at the cheapest rung.
        planner: () => planFor(undefined, "best"),
        manifest: () => this.manifest(),
      }),
    };
  }

  /** The plan a step should run under. No agent named ⇒ a general-purpose one. */
  private planFor(
    spec: WorkflowSpec,
    agent: string | undefined,
    quality: AgentPlan["quality"] | undefined,
  ): Promise<AgentPlan> {
    if (agent) {
      const plan = this.plans[agent];
      if (!plan) return Promise.reject(new Error(`no agent named "${agent}"`));
      return Promise.resolve(plan);
    }

    const name = spec.name ?? "workflow";
    const key = `${name}:${quality ?? "-"}`;
    let pending = this.stepPlans.get(key);
    if (!pending) {
      pending = planWorkflowAgent(this.project, name, spec.knows, quality, { env: this.env });
      this.stepPlans.set(key, pending);
    }
    return pending;
  }

  private workflowSpec(name: string): WorkflowSpec {
    const spec = this.project.workflows[name];
    if (!spec) throw new Error(`no workflow named "${name}"`);
    return spec;
  }

  async startWorkflow(name: string, input: Record<string, unknown>): Promise<Run> {
    const spec = this.workflowSpec(name);
    return startRun(spec, input, this.workflowDeps(spec));
  }

  async resumeWorkflow(
    runId: string,
    decision: { approved: boolean; note?: string },
  ): Promise<Run> {
    const run = await this.runs.load(runId);
    if (!run) throw new Error(`no such run: ${runId}`);
    const spec = this.workflowSpec(run.workflow);
    return resumeRun(runId, decision, spec, this.workflowDeps(spec));
  }

  /**
   * Install a blueprint, writing whatever it produces as ordinary files.
   *
   * A blueprint that ships files is copied. One that only states an intent is
   * worked out against this app's own description, which is what makes it
   * possible at all: there is a known set of parts, not a blank page.
   */
  async add(
    name: string,
    options: { force?: boolean } = {},
  ): Promise<WriteResult & { notes: string[] }> {
    const spec = this.project.blueprints[name];
    if (!spec) throw new Error(`no blueprint named "${name}"`);

    const missing = (spec.needs ?? []).filter((need) => {
      const { services } = resolveServices([need], this.project.tools, this.env);
      return !services[0]?.apiKey;
    });

    let files = spec.files ?? [];
    const notes = missing.map((need) => `"${need}" will not work until its credential is set`);

    if (!files.length) {
      const derived = await deriveFiles(spec, {
        describes: await this.describeInProse(),
        examples: await this.styleExamples(),
        ask: async (question) => (await this.harness.ask(await this.blueprintPlan(), question)).text,
      });
      files = derived.files;
      notes.push(...derived.notes);
    }

    return { ...(await writeFiles(this.root, files, options)), notes };
  }

  private blueprintPlan(): Promise<AgentPlan> {
    return this.planFor(
      { kind: "workflow", name: "blueprint", steps: [] },
      undefined,
      "best",
    );
  }

  /** The app in prose, for a blueprint to build against. */
  private async describeInProse(): Promise<string> {
    const manifest = await this.manifest();
    const lines = [
      `The app is called "${this.name}".`,
      manifest.agents.length
        ? `Agents:\n${manifest.agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")}`
        : "It has no agents yet.",
      manifest.tools.length
        ? `Tools and functions:\n${manifest.tools.map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ""}`).join("\n")}`
        : "",
      this.workflowNames.length ? `Workflows: ${this.workflowNames.join(", ")}` : "",
      Object.keys(this.project.stores).length
        ? `Stores:\n${Object.entries(this.project.stores)
            .map(([name, spec]) => `- ${name}: a ${spec.of} store`)
            .join("\n")}`
        : "",
    ];
    return lines.filter(Boolean).join("\n\n");
  }

  /** One existing agent and one workflow, so generated code matches the house style. */
  private async styleExamples(): Promise<FileContents[]> {
    const picks = [
      this.agentNames[0] ? `agents/${this.agentNames[0]}.ts` : undefined,
      this.workflowNames[0] ? `workflows/${this.workflowNames[0]}.ts` : undefined,
    ].filter((path): path is string => Boolean(path));

    const files: FileContents[] = [];
    for (const path of picks) {
      const contents = await readFile(resolve(this.root, path), "utf8").catch(() => undefined);
      if (contents !== undefined) files.push({ path, contents });
    }
    return files;
  }

  /** Live tool schemas for an agent — used by the dashboard, not the ask path. */
  async toolsFor(agent: string): Promise<{ name: string; description?: string }[]> {
    const plan = this.plans[agent];
    if (!plan) return [];
    const { schemas } = await collectTools(plan.services, this.fetchImpl);
    return schemas.map(({ name, description }) => ({ name, description }));
  }

  /** A declared store, opened on first ask. */
  store(name: string): Promise<Store> {
    return this.stores.open(name);
  }

  async close(): Promise<void> {
    await this.harness.close?.();
    await this.stores.close();
  }
}

/** `service.tool_name` — the form a workflow author writes. */
function refParts(ref: string): { service: string; tool: string } | undefined {
  const at = ref.indexOf(".");
  if (at <= 0) return undefined;
  return { service: ref.slice(0, at), tool: ref.slice(at + 1) };
}
