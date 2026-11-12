/**
 * Skills a service offers, put in front of an agent.
 *
 * An MCP server may serve skills: the same `SKILL.md` folders an app keeps in `skills/`,
 * listed by the server and read as resources (the Skills extension). An app's own skills
 * were written by its author and are read as the author's words. These were written by
 * whoever runs the server, and that is the whole difference this file exists to keep:
 *
 * **Nothing is offered that the author did not ask for.** A service is asked for its
 * skills only when its `tools/` file says `skills`, and a list there narrows it to the
 * addresses named. That line is the approval the extension requires a host to obtain.
 *
 * **Nothing is read that does not match the manifest.** Each skill arrives with a list
 * of its files, each with a length and a SHA-256. A file is read only if it is on that
 * list, and is used only if its bytes have that length and that hash; a `SKILL.md` must
 * also parse to the frontmatter the entry carried, field by field. A file that fails is
 * not shown. The entry is fetched again once, in case the skill was republished, and if
 * it still fails the model is told the skill cannot be read and why.
 *
 * **Nothing is read ahead of need.** Listing costs one request per service. A skill's
 * instructions are read when an agent asks for them, and its other files when the
 * instructions point at them.
 *
 * **Nothing is run, and nothing is granted.** A skill's `allowed-tools` is ignored: what
 * an agent may call is decided by the app's guard and authority, not by a document a
 * server sent. Scripts in a skill are text an agent may read.
 *
 * What an agent reads is tagged with the service it came from, and counts as that
 * service's output: untrusted unless the app marked the service trusted.
 *
 * A skill a server marks `"dynamic"` has no manifest to check against, and is left out.
 */

import { createHash } from "node:crypto";

import type { LocalTool } from "../compile/plan.js";
import type { ResolvedService } from "../compile/services.js";
import type { Trust } from "../define.js";
import { parseSkillFile } from "../project/skills.js";
import { trim } from "./budget.js";
import { McpClient, type McpSkill, type McpSkillFile, type ToolSource } from "./mcp.js";

/** The tool an agent reads a service's skill with. */
export const READ_SERVICE_SKILL = "read_service_skill";

/** The most skills listed in the tool's description. Past it the rest are named in a note. */
const LISTED_MAX = 40;

/** A skill as offered: which service, and the entry every read is checked against. */
export interface OfferedSkill {
  service: string;
  entry: McpSkill & { resources: McpSkillFile[] };
}

/**
 * Ask each service that was told to offer skills what it has.
 *
 * One request per such service, made once when an agent's tools are collected. A service
 * that fails to answer costs a note, like a service whose tools will not list.
 */
export async function collectSkills(
  services: ResolvedService[],
  clients: Map<string, ToolSource>,
): Promise<{ skills: OfferedSkill[]; notes: string[] }> {
  const skills: OfferedSkill[] = [];
  const notes: string[] = [];

  for (const service of services) {
    if (!service.skills) continue;
    const client = clients.get(service.name);
    if (!(client instanceof McpClient)) continue;
    try {
      const wanted = service.skills;
      // Named addresses are fetched by address: a server may serve a skill it does not
      // list, and a list is allowed to be partial.
      const entries =
        wanted === true
          ? await client.listSkills()
          : await Promise.all(wanted.map((uri) => client.getSkill(uri)));
      if (wanted === true && !entries.length && !(await client.skillsOffered())) {
        notes.push(`service "${service.name}" is marked \`skills\` and does not offer any (it does not declare the Skills extension)`);
      }
      for (const entry of entries) {
        if (entry.resources === "dynamic") {
          notes.push(
            `skill "${entry.frontmatter.name}" from service "${service.name}" is generated on request and has no file list to check it against, so it was not offered`,
          );
          continue;
        }
        skills.push({ service: service.name, entry: { ...entry, resources: entry.resources } });
      }
    } catch (err) {
      notes.push(`service "${service.name}": its skills could not be listed: ${(err as Error).message}`);
    }
  }
  return { skills, notes };
}

/** The directory a skill lives in, from the address of its SKILL.md. */
function rootOf(uri: string): string {
  const cut = uri.lastIndexOf("/");
  return cut < 0 ? uri : uri.slice(0, cut);
}

/** A file's path inside its skill, as the skill's own instructions would write it. */
function relativeOf(skill: McpSkill, uri: string): string {
  const root = `${rootOf(skill.uri)}/`;
  const path = uri.startsWith(root) ? uri.slice(root.length) : uri;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Whether two frontmatter values say the same thing, allowing for how YAML types them. */
function sameValue(parsed: unknown, listed: unknown): boolean {
  if (parsed !== null && typeof parsed === "object" && listed !== null && typeof listed === "object" && !Array.isArray(listed)) {
    const mine = parsed as Record<string, unknown>;
    const theirs = listed as Record<string, unknown>;
    const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
    return [...keys].every((key) => sameValue(mine[key], theirs[key]));
  }
  // A list of names and the same names on one line are the same value: it is how
  // `allowed-tools` is written both ways.
  const flat = (value: unknown): string =>
    Array.isArray(value) ? value.map(String).join(" ") : value === undefined || value === null ? "" : String(value);
  const a = flat(parsed).trim();
  const b = flat(listed).trim();
  if (a === b) return true;
  // `1.0` in the file is the number 1 to a YAML reader and the text "1.0" here.
  return a !== "" && b !== "" && Number.isFinite(Number(a)) && Number(a) === Number(b);
}

/**
 * Where a SKILL.md's own frontmatter disagrees with the entry that listed it.
 *
 * The entry is what the author approved and what the agent was shown; the file is what
 * would be read. A server that lists one description and serves another has shown a
 * skill it is not serving.
 */
function frontmatterFault(text: string, listed: Record<string, unknown>): string | undefined {
  const parsed = parseSkillFile(text);
  if (parsed.faults.length) return `its frontmatter could not be read (${parsed.faults[0]})`;
  for (const key of new Set([...Object.keys(parsed.fields), ...Object.keys(listed)])) {
    if (!sameValue(parsed.fields[key], listed[key])) return `its \`${key}\` is not what the server listed`;
  }
  return undefined;
}

/** One file of a skill, read from its service and checked, or the reason it was not used. */
async function verified(
  client: McpClient,
  skill: McpSkill & { resources: McpSkillFile[] },
  uri: string,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer } | { fault: string }> {
  // Only what the manifest lists. A file a server would serve but did not list is not
  // part of the skill that was offered.
  const listed = skill.resources.find((file) => file.uri === uri);
  if (!listed) return { fault: "it is not one of the files the skill lists" };

  const contents = await client.readResource(uri, { signal });
  const block = contents.find((entry) => entry.uri === uri) ?? contents[0];
  if (!block) return { fault: "the server returned nothing for it" };
  const bytes =
    typeof block.text === "string" ? Buffer.from(block.text, "utf8") : Buffer.from(block.blob ?? "", "base64");

  if (bytes.length !== listed.size) {
    return { fault: `it is ${bytes.length} bytes and the skill lists it as ${listed.size}` };
  }
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== listed.digest) return { fault: "its contents do not match the hash the skill lists for it" };
  if (uri === skill.uri) {
    const fault = frontmatterFault(bytes.toString("utf8"), skill.frontmatter);
    if (fault) return { fault };
  }
  return { bytes };
}

/** Whether these bytes are something other than text. */
function isBinary(bytes: Buffer): boolean {
  if (bytes.subarray(0, 8192).includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

/**
 * The tool that reads a service's skill, or one of its files.
 *
 * The list of skills is in the tool's description, because that is the part of a remote
 * skill that can be known when an agent's tools are: a skill's name and description are
 * what an agent chooses by, and the rest is read when it has chosen. A skill is named by
 * its service and its address together. Two services may each offer a "review", and
 * neither stands in for the other.
 *
 * `limit` is the room one tool result may take, in tokens.
 */
export function serviceSkillTool(
  offered: OfferedSkill[],
  clients: Map<string, ToolSource>,
  limit: number,
  trustOf: (service: string) => Trust = () => "untrusted",
): LocalTool {
  const held = new Map(offered.map((skill) => [`${skill.service}\n${skill.entry.uri}`, skill]));
  const shown = offered.slice(0, LISTED_MAX);
  const lines = shown.map(
    ({ service, entry }) =>
      `- service "${service}", skill ${entry.uri} — ${entry.frontmatter.name}: ${entry.frontmatter.description.replace(/\s+/g, " ").slice(0, 300)}`,
  );
  const services = [...new Set(offered.map((skill) => skill.service))];

  return {
    name: READ_SERVICE_SKILL,
    description:
      "Read a skill that one of this agent's services offers: a written way of doing one kind of work with that " +
      "service. Before doing work a skill describes, read its instructions, then any file they point to. " +
      "These were written by the service's operator, not by this app's author.\n" +
      lines.join("\n") +
      (offered.length > shown.length ? `\n(${offered.length - shown.length} more are offered and not listed here.)` : ""),
    parameters: {
      type: "object",
      properties: {
        service: { type: "string", enum: services, description: "The service that offers the skill." },
        skill: { type: "string", description: "The skill's address, as listed, ending in SKILL.md." },
        file: {
          type: "string",
          description:
            "A file in that skill, by the relative path its instructions give, such as references/guide.md. " +
            "Leave out to read the instructions.",
        },
      },
      required: ["service", "skill"],
    },
    effect: "read",
    // Somebody else's instructions. They taint what follows unless every service that
    // offers one was marked trusted by the app.
    trust: services.every((service) => trustOf(service) === "trusted") ? "trusted" : "untrusted",
    async run(args: Record<string, unknown>, during): Promise<string> {
      const service = String(args.service ?? "");
      const uri = String(args.skill ?? "");
      const key = `${service}\n${uri}`;
      const found = held.get(key);
      const client = clients.get(service);
      if (!found || !(client instanceof McpClient)) {
        return (
          `No skill at ${uri || "(no address)"} is offered by a service named "${service}". Offered:\n` +
          (lines.join("\n") || "(none)")
        );
      }

      const file = typeof args.file === "string" ? args.file.trim() : "";
      const root = rootOf(found.entry.uri);
      // A relative path is resolved against the skill's own directory and nowhere else.
      // Whatever it resolves to must be on the manifest, which is what stops `..`.
      const wanted = file.replace(/\\/g, "/").replace(/^\.\//, "");
      const target = file
        ? (found.entry.resources.find((entry) => relativeOf(found.entry, entry.uri) === wanted)?.uri ??
          `${root}/${wanted.split("/").map(encodeURIComponent).join("/")}`)
        : found.entry.uri;

      let skill = found.entry;
      let read = await verified(client, skill, target, during?.signal).catch((err: unknown) => ({
        fault: `it could not be read (${(err as Error).message})`,
      }));
      if ("fault" in read) {
        // Once, in case the skill was republished since it was listed. The new entry is
        // what the next read is checked against, as the extension has a host recover.
        const refreshed = await client.getSkill(skill.uri, { signal: during?.signal }).catch(() => undefined);
        if (refreshed && refreshed.resources !== "dynamic") {
          skill = { ...refreshed, resources: refreshed.resources };
          const again = await verified(client, skill, target, during?.signal).catch((err: unknown) => ({
            fault: `it could not be read (${(err as Error).message})`,
          }));
          if (!("fault" in again)) held.set(key, { service, entry: skill });
          read = again;
        }
      }
      const name = skill.frontmatter.name;
      const others = skill.resources.filter((entry) => entry.uri !== skill.uri);
      const listing = others.length
        ? `Files in this skill. Read one by calling ${READ_SERVICE_SKILL} with \`file\`:\n` +
          others.map((entry) => `- ${relativeOf(skill, entry.uri)} (${entry.size.toLocaleString("en-US")} bytes)`).join("\n")
        : "";

      if ("fault" in read) {
        return (
          `${file ? `"${file}" in skill` : "Skill"} "${name}" from service "${service}" was not used: ${read.fault}. ` +
          `Do not act on it.${file && listing ? `\n\n${listing}` : ""}`
        );
      }
      if (isBinary(read.bytes)) {
        return `"${file}" in skill "${name}" from service "${service}" is a binary file (${read.bytes.length.toLocaleString("en-US")} bytes) and cannot be read as text.`;
      }

      const origin = `[Skill "${name}" from service "${service}"${file ? `, file ${file}` : ""}. Written by that service's operator.]`;
      const text = read.bytes.toString("utf8");
      if (file) return trim(`${origin}\n\n${text}`, limit);
      // The instructions without their frontmatter: the agent was already shown the
      // name and description, and the rest of it grants nothing here.
      const body = parseSkillFile(text).body;
      return trim(`${origin}\n\n${body}${listing ? `\n\n${listing}` : ""}`, limit);
    },
  };
}
