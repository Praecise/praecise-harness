/**
 * The command line: make an app, try it, call it, see what is in it, and hand
 * it to someone else. Anything needing more than this belongs in the app.
 *
 * `mcp` writes nothing to stdout but protocol messages, so every line this
 * module prints goes through `out` and every line `mcp` prints goes to stderr.
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { App } from "../app.js";
import { buildPackage } from "../package/build.js";
import { serve } from "../server/index.js";
import { noticesOf } from "../server/mcp.js";
import { serveStdio } from "../server/stdio.js";
import { NEXT_STEPS, scaffold } from "./scaffold.js";
import { templates } from "./templates.js";

const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const code = (value: string) => (COLOR ? `\u001b[${value}m` : "");

const RESET = code("0");
const DIM = code("2");
const BOLD = code("1");
const PULSE = code("36");
const EMBER = code("33");

const out = (line = "") => process.stdout.write(`${line}\n`);
const dim = (text: string) => `${DIM}${text}${RESET}`;

const USAGE = `${BOLD}praecise${RESET} — agents from a folder

  ${PULSE}praecise init${RESET} [dir]        create a new app
  ${PULSE}praecise dev${RESET} [--port n]    run the dev server
  ${PULSE}praecise run${RESET} <name> [text] call an agent, workflow, or function
  ${PULSE}praecise add${RESET} <blueprint>   add a piece to this app
  ${PULSE}praecise list${RESET}              show what this app contains
  ${PULSE}praecise memory${RESET} <agent>    see what an agent has learned, and decide on it
  ${PULSE}praecise mcp${RESET}               serve this app over stdio, for an MCP client
  ${PULSE}praecise package${RESET} [out]     write a package someone else can run

Options
  --dir <path>       project directory (default: the working directory)
  --template <name>  start from a template; pass ${dim("--template")} alone to list them
  --force            overwrite files that already exist
  --json             machine-readable output for ${dim("run")} and ${dim("list")}
  --groups <a,b>     publish only these groups, for ${dim("mcp")} and ${dim("package")}
  --read-only        publish only what changes nothing
  --propose          read an agent's record and propose what to carry forward
  --accept [n,n]     keep a proposal, or only the positions named
  --reject           discard a proposal, leaving the record untouched
  --record           show the exchanges an agent kept, with their ids
  --redact <id>      take one back, leaving ${dim("--note")} where it was
  --note <text>      what to leave behind when redacting
  --hosted           package for a server others reach, not a local subprocess
`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let index = 0; index < argv.length; index++) {
    const item = argv[index]!;
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const [key, inline] = item.slice(2).split("=", 2);
    if (inline !== undefined) {
      flags[key!] = inline;
    } else if (argv[index + 1] && !argv[index + 1]!.startsWith("--")) {
      flags[key!] = argv[++index]!;
    } else {
      flags[key!] = true;
    }
  }

  return { command: positional.shift() ?? "", positional, flags };
}

/** `.env` in the project root, loaded the same way `next dev` does. */
function loadEnv(root: string): void {
  try {
    process.loadEnvFile(join(root, ".env"));
  } catch {
    // No .env is normal; keys may come from the shell.
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function init(args: Args): Promise<number> {
  const target = resolve(args.positional[0] ?? ".");
  const name = basename(target).replace(/[^\w-]/g, "-") || "app";
  const available = templates(name);

  const wanted = args.flags.template;
  if (wanted === true) {
    out(dim("templates"));
    for (const spec of available) out(`  ${spec.name!.padEnd(12)} ${spec.description}`);
    return 0;
  }

  const chosen = wanted ? available.find((spec) => spec.name === wanted) : undefined;
  if (wanted && !chosen) {
    out(`${EMBER}no template named${RESET} "${String(wanted)}"`);
    out(dim(`try: ${available.map((spec) => spec.name).join(", ")}`));
    return 1;
  }

  const files = chosen ? chosen.files : scaffold(name);
  const clashes: string[] = [];
  for (const file of files) {
    if (await exists(join(target, file.path))) clashes.push(file.path);
  }
  if (clashes.length && !args.flags.force) {
    out(`${EMBER}already exists:${RESET} ${clashes.join(", ")}`);
    out(dim("pass --force to overwrite"));
    return 1;
  }

  for (const file of files) {
    const path = join(target, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.contents, "utf8");
    out(`${dim("create")} ${file.path}`);
  }

  out();
  out(NEXT_STEPS);
  return 0;
}

/**
 * Serve the app on stdin and stdout for a client that launched us.
 *
 * Nothing may be printed to stdout here — it is the protocol channel — so the
 * usual banner goes to stderr, where a client shows it as server logs.
 */
async function mcp(args: Args): Promise<number> {
  const root = resolve(String(args.flags.dir ?? args.positional[0] ?? "."));
  loadEnv(root);

  const app = await App.load({ root });
  const caller = { identified: true, groups: groupsFlag(args), readOnly: !!args.flags["read-only"] };
  process.stderr.write(`praecise: serving ${app.name} on stdio\n`);
  for (const problem of app.problems) process.stderr.write(`praecise: ${problem}\n`);
  for (const note of noticesOf(app, caller)) process.stderr.write(`praecise: ${note}\n`);

  await serveStdio({ app, caller }).done;
  await app.close();
  return 0;
}

/** `--groups a,b` as a list, or undefined for all of them. */
function groupsFlag(args: Args): string[] | undefined {
  if (typeof args.flags.groups !== "string") return undefined;
  return args.flags.groups.split(",").map((name) => name.trim()).filter(Boolean);
}

/** Write the app out as something someone else can install and run. */
async function pack(args: Args): Promise<number> {
  const root = resolve(String(args.flags.dir ?? "."));
  loadEnv(root);

  const app = await App.load({ root });

  const result = await buildPackage({
    app,
    out: args.positional[0] ? resolve(String(args.positional[0])) : undefined,
    groups: groupsFlag(args),
    readOnly: !!args.flags["read-only"],
    shape: args.flags.hosted ? "hosted" : "local",
  });
  await app.close();

  if (args.flags.json) {
    out(JSON.stringify(result.manifest, null, 2));
    return 0;
  }

  out();
  out(`${BOLD}${result.manifest.name}${RESET} ${dim(`v${result.manifest.version}`)}`);
  out(`  ${dim("out")}      ${result.out}`);
  out(`  ${dim("shape")}    ${result.manifest.shape}`);
  out(`  ${dim("protocol")} ${result.manifest.protocolVersion}`);
  for (const tool of result.manifest.tools) out(`  ${PULSE}${tool.name}${RESET} ${dim(tool.description)}`);
  if (!result.manifest.tools.length) {
    out(`  ${EMBER}!${RESET} this package publishes nothing — every part is internal`);
  }
  for (const note of result.notes) out(`  ${EMBER}!${RESET} ${note}`);
  out();
  out(dim(`  cd ${result.out} && npm install && npx ${result.manifest.name}`));
  out();
  return 0;
}

async function dev(args: Args): Promise<number> {
  const root = resolve(String(args.flags.dir ?? args.positional[0] ?? "."));
  loadEnv(root);

  const port = args.flags.port ? Number(args.flags.port) : undefined;
  const server = await serve({
    root,
    port,
    prefer: typeof args.flags.provider === "string" ? args.flags.provider : undefined,
    onReload: (app, error) => {
      if (error) out(`${EMBER}reload failed:${RESET} ${error.message}`);
      else out(dim(`reloaded · ${app.agentNames.length} agents · ${app.workflowNames.length} workflows`));
    },
  });

  const app = server.app();
  out();
  out(`${BOLD}${app.name}${RESET} ${dim("· praecise dev")}`);
  out(`  ${PULSE}${server.url}${RESET}`);
  for (const name of app.agentNames) out(`  ${dim("agent")}    ${server.url}/${name}`);
  for (const name of app.workflowNames) out(`  ${dim("workflow")} ${server.url}/w/${name}`);
  out(`  ${dim("mcp")}      ${server.url}/mcp`);
  for (const problem of app.problems) out(`  ${EMBER}!${RESET} ${problem}`);
  out();

  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  return new Promise<number>(() => {});
}

async function run(args: Args): Promise<number> {
  const root = resolve(String(args.flags.dir ?? "."));
  loadEnv(root);

  const name = args.positional[0];
  if (!name) {
    out(`${EMBER}run needs a name:${RESET} praecise run <agent|workflow> [input]`);
    return 1;
  }

  const app = await App.load({
    root,
    prefer: typeof args.flags.provider === "string" ? args.flags.provider : undefined,
  });

  try {
    if (app.plans[name]) {
      const input = args.positional.slice(1).join(" ") || (await readStdin());
      if (!input) {
        out(`${EMBER}nothing to ask.${RESET} Pass text, or pipe it in.`);
        return 1;
      }
      const answer = await app.ask(name, input);
      if (args.flags.json) out(JSON.stringify(answer, null, 2));
      else {
        out(answer.text);
        out();
        const bits = [answer.path.join(" → ")];
        if (answer.agreement !== undefined) bits.push(`agreed ${answer.agreement.toFixed(2)}`);
        if (answer.usage.decidingTokens) bits.push(`${answer.usage.decidingTokens} deciding`);
        if (answer.usage.cachedTokens) bits.push(`${answer.usage.cachedTokens} cached`);
        out(dim(bits.join(" · ")));
      }
      return 0;
    }

    if (app.project.workflows[name]) {
      const input = parseInput(args.positional.slice(1));
      const result = await app.startWorkflow(name, input);
      if (args.flags.json) out(JSON.stringify(result, null, 2));
      else {
        for (const event of result.events) {
          out(`${dim(event.kind.padEnd(8))} ${event.step}${event.detail ? ` ${dim(event.detail)}` : ""}`);
        }
        out();
        if (result.status === "waiting" && result.waitingFor) {
          out(`${EMBER}waiting for approval${RESET} · ${result.waitingFor.prompt}`);
          out(dim(`resume it at /w/${name} or POST /api/runs/${result.id}`));
        } else if (result.status === "failed") {
          out(`${EMBER}failed:${RESET} ${result.error}`);
        } else {
          out(
            typeof result.result === "string"
              ? result.result
              : JSON.stringify(result.result ?? null, null, 2),
          );
        }
      }
      return result.status === "failed" ? 1 : 0;
    }

    if (app.project.functions[name]) {
      const value = await app.callTool(name, parseInput(args.positional.slice(1)));
      out(typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2));
      return 0;
    }

    const known = [...app.agentNames, ...app.workflowNames, ...Object.keys(app.project.functions)];
    out(`${EMBER}nothing named${RESET} "${name}" in this app`);
    out(dim(`known: ${known.join(", ") || "nothing yet"}`));
    return 1;
  } finally {
    await app.close();
  }
}

async function add(args: Args): Promise<number> {
  const root = resolve(String(args.flags.dir ?? "."));
  loadEnv(root);
  const app = await App.load({ root });

  try {
    const name = args.positional[0];
    const known = Object.keys(app.project.blueprints);
    if (!name) {
      if (!known.length) {
        out(dim("no blueprints in this app — put one in blueprints/"));
        return 1;
      }
      out(dim("blueprints"));
      for (const key of known) {
        out(`  ${key.padEnd(16)} ${app.project.blueprints[key]!.description ?? ""}`);
      }
      return 0;
    }
    if (!app.project.blueprints[name]) {
      out(`${EMBER}no blueprint named${RESET} "${name}"`);
      out(dim(`known: ${known.join(", ") || "nothing yet"}`));
      return 1;
    }

    const result = await app.add(name, { force: Boolean(args.flags.force) });
    for (const path of result.written) out(`${dim("create")} ${path}`);
    for (const path of result.skipped) out(`${dim("skip")}   ${path} ${dim("(already exists)")}`);
    for (const note of result.notes) out(`  ${EMBER}!${RESET} ${note}`);
    if (!result.written.length) return 1;
    out();
    out(dim("read what it wrote, then `praecise dev`"));
    return 0;
  } finally {
    await app.close();
  }
}

async function list(args: Args): Promise<number> {
  const root = resolve(String(args.flags.dir ?? "."));
  loadEnv(root);
  const app = await App.load({ root });

  if (args.flags.json) {
    out(
      JSON.stringify(
        {
          name: app.name,
          agents: app.agentNames.map((name) => {
            const plan = app.plans[name]!;
            return {
              name,
              description: plan.description,
              quality: plan.quality,
              models: plan.rungs.map((rung) => `${rung.provider}/${rung.model}`),
              tools: plan.services.map((service) => service.name),
            };
          }),
          workflows: app.workflowNames.map((name) => ({
            name,
            steps: app.project.workflows[name]!.steps.length,
          })),
          functions: Object.keys(app.project.functions),
          prompts: Object.keys(app.project.prompts),
          resources: Object.keys(app.project.resources),
          stores: Object.entries(app.project.stores).map(([name, spec]) => ({
            name,
            of: spec.of,
          })),
          blueprints: Object.keys(app.project.blueprints),
          problems: app.problems,
        },
        null,
        2,
      ),
    );
    await app.close();
    return 0;
  }

  out(`${BOLD}${app.name}${RESET}`);
  out();
  if (app.agentNames.length) {
    out(dim("agents"));
    for (const name of app.agentNames) {
      const plan = app.plans[name]!;
      out(`  ${name.padEnd(16)} ${dim(plan.quality.padEnd(9))} ${plan.description}`);
      out(`  ${" ".repeat(16)} ${dim(plan.rungs.map((r) => `${r.provider}/${r.model}`).join(" → ") || "no model")}`);
    }
    out();
  }
  if (app.workflowNames.length) {
    out(dim("workflows"));
    for (const name of app.workflowNames) {
      const spec = app.project.workflows[name]!;
      out(`  ${name.padEnd(16)} ${dim(`${spec.steps.length} steps`.padEnd(9))} ${spec.description ?? ""}`);
    }
    out();
  }
  const rest: [string, string[]][] = [
    ["functions", Object.keys(app.project.functions)],
    ["prompts", Object.keys(app.project.prompts)],
    ["resources", Object.keys(app.project.resources)],
    ["stores", Object.entries(app.project.stores).map(([n, s]) => `${n} (${s.of})`)],
    ["blueprints", Object.keys(app.project.blueprints)],
  ];
  for (const [label, names] of rest) {
    if (names.length) out(`${dim(label.padEnd(11))} ${names.join(", ")}`);
  }
  if (rest.some(([, names]) => names.length)) out();

  if (!app.agentNames.length && !app.workflowNames.length) {
    out(dim("nothing here yet — try `praecise init`"));
    out();
  }
  for (const problem of app.problems) out(`${EMBER}!${RESET} ${problem}`);

  await app.close();
  return 0;
}

/**
 * Look at what an agent has learned, and decide whether it keeps it.
 *
 * Reading and adopting are two commands on purpose. A proposal that took effect
 * the moment it was written would be a memory that rewrites itself, which is
 * the thing this is built to avoid.
 */
async function learned(args: Args): Promise<number> {
  const root = resolve(String(args.flags.dir ?? "."));
  loadEnv(root);

  const name = args.positional[0];
  if (!name) {
    out(
      `${EMBER}memory needs an agent:${RESET} ` +
        `praecise memory <agent> [--record|--propose|--accept|--reject|--redact <id>]`,
    );
    return 1;
  }

  const app = await App.load({ root });
  try {
    if (typeof args.flags.redact === "string") {
      const note = typeof args.flags.note === "string" ? args.flags.note : "taken back";
      const done = await app.redact(name, args.flags.redact, note);
      out(
        done
          ? dim(`taken back; the record still shows it happened, and says "${note}"`)
          : `${EMBER}nothing kept under that id${RESET}`,
      );
      return done ? 0 : 1;
    }

    if (args.flags.record) {
      const kept = await app.recorded(name);
      out(`${BOLD}${name}${RESET} ${dim("kept")}`);
      if (!kept.length) out(dim("  nothing kept yet"));
      for (const episode of kept) {
        const when = new Date(episode.at).toISOString().slice(0, 16).replace("T", " ");
        out(`  ${dim(episode.id)} ${dim(when)}${episode.redactedAt ? ` ${EMBER}taken back${RESET}` : ""}`);
        out(`    ${episode.input.slice(0, 100)}`);
      }
      out();
      out(dim("`--redact <id> --note \"...\"` takes one back without pretending it never happened"));
      return 0;
    }

    if (args.flags.reject) {
      await app.reject(name);
      out(dim("proposal discarded; the record is untouched"));
      return 0;
    }

    if (args.flags.accept) {
      const kept = await app.accept(name, pick(args.flags.accept));
      out(`${PULSE}kept ${kept.length}${RESET} ${kept.length === 1 ? "note" : "notes"}`);
      for (const note of kept) out(`  - ${note.text}`);
      return 0;
    }

    if (args.flags.propose) {
      const candidate = await app.propose(name);
      out(dim(`read ${candidate.read.episodes} exchanges`));
      show(candidate.notes, candidate.problems);
      out();
      out(dim("nothing has changed yet — `--accept` to keep these, `--reject` to discard"));
      return 0;
    }

    const held = await app.learned(name);
    out(`${BOLD}${name}${RESET} ${dim("carries")}`);
    if (!held.length) out(dim("  nothing yet"));
    for (const note of held) out(`  - ${note.text}`);

    const waiting = await app.pending(name);
    if (waiting) {
      out();
      out(`${BOLD}proposed${RESET} ${dim(`from ${waiting.read.episodes} exchanges`)}`);
      show(waiting.notes, waiting.problems);
    }
    out();
    out(dim("`--propose` to read the record again, `--accept` to keep what is proposed"));
    return 0;
  } catch (err) {
    out(`${EMBER}${(err as Error).message}${RESET}`);
    return 1;
  } finally {
    await app.close();
  }
}

/** `--accept` alone takes everything; `--accept 0,2` takes those positions. */
function pick(flag: string | true): number[] | undefined {
  if (flag === true) return undefined;
  const chosen = flag
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((at) => Number.isInteger(at) && at >= 0);
  return chosen.length ? chosen : [];
}

function show(notes: { text: string; from: string[] }[], problems?: string[]): void {
  if (!notes.length) out(dim("  nothing worth carrying forward"));
  notes.forEach((note, at) => {
    out(`  ${dim(`[${at}]`)} ${note.text}`);
    out(`      ${dim(`from ${note.from.join(", ")}`)}`);
  });
  for (const problem of problems ?? []) out(`${EMBER}!${RESET} ${problem}`);
}

/** `key=value` pairs, or a single JSON object. */
function parseInput(parts: string[]): Record<string, unknown> {
  if (!parts.length) return {};
  const joined = parts.join(" ").trim();
  if (joined.startsWith("{")) {
    try {
      return JSON.parse(joined) as Record<string, unknown>;
    } catch {
      // Fall through and treat it as pairs.
    }
  }
  const input: Record<string, unknown> = {};
  for (const part of parts) {
    const at = part.indexOf("=");
    if (at > 0) input[part.slice(0, at)] = part.slice(at + 1);
  }
  return input;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);

  switch (args.command) {
    case "init":
      return init(args);
    case "dev":
      return dev(args);
    case "run":
      return run(args);
    case "add":
      return add(args);
    case "mcp":
      return mcp(args);
    case "package":
      return pack(args);
    case "list":
    case "ls":
      return list(args);
    case "memory":
      return learned(args);
    case "":
    case "help":
    case "--help":
    case "-h":
      out(USAGE);
      return 0;
    case "--version":
    case "-v":
      out("0.1.0");
      return 0;
    default:
      out(`${EMBER}unknown command:${RESET} ${args.command}`);
      out(USAGE);
      return 1;
  }
}
