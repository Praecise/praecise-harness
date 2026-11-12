/**
 * Registries: an index anyone can host, a skill installed from one, a plugin written down.
 *
 * What is held to here is mostly what must NOT happen. Nothing is fetched by loading an
 * app. Nothing is written that did not match its digest. Nothing lands outside
 * `skills/<name>/`, whatever an archive calls its files. And nothing is run.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/index.js";
import { loadProject } from "../src/project/load.js";
import { archiveFormat, safeRelativePath, unpackArchive } from "../src/registry/archive.js";
import { DISCOVERY_SCHEMA, indexUrlOf, parseIndex, searchEntries, type RegistryEntry } from "../src/registry/format.js";
import { fetchSkill, installSkill, readRecordedPlugins, readRegistries, recordPlugin } from "../src/registry/install.js";
import { FRAMEWORK, cleanup, makeProject } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(cleanup));
});

const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

const SKILL = `---
name: log-triage
description: Summarise application logs and flag likely root causes.
---
Read the newest log first.

Then run scripts/tail.sh for the rest.
`;

/** A tar entry: a 512-byte header, the data, and padding to the next block. */
function tarEntry(name: string, data: string | Uint8Array, type = "0", linkTo = ""): Buffer {
  const body = Buffer.from(data);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000755\0", 100, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write(type, 156, "ascii");
  header.write(linkTo, 157, 100, "utf8");
  header.write("ustar\0", 257, "ascii");
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
const tarGz = (...entries: Buffer[]): Buffer => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

/** A zip of the given files, stored or deflated, with the Unix mode each claims. */
function zip(files: { name: string; data: string; deflate?: boolean; mode?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = Buffer.from(file.data);
    const packed = file.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(file.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.deflate ? 8 : 0, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(file.deflate ? 8 : 0, 10);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(((file.mode ?? 0o100644) << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    central.push(entry, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A stand-in for the network: URLs to bodies, and a list of what was asked for. */
function web(pages: Record<string, { body: Uint8Array | string; type?: string; status?: number }>) {
  const asked: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const page = pages[url];
    if (!page) return new Response("not found", { status: 404 });
    return new Response(page.body as BodyInit, { status: page.status ?? 200, headers: page.type ? { "content-type": page.type } : {} });
  }) as typeof fetch;
  return { fetch: impl, asked };
}

const INDEX = "https://skills.test/.well-known/agent-skills/index.json";
const skillEntry = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  kind: "skill",
  name: "log-triage",
  description: "Summarise logs.",
  source: "https://skills.test/.well-known/agent-skills/log-triage/SKILL.md",
  type: "skill-md",
  digest: sha(SKILL),
  registry: INDEX,
  ...over,
});

describe("the index format", () => {
  it("reads the Agent Skills discovery index as published, and a `plugins` list beside it", () => {
    const { entries, notes } = parseIndex(
      {
        $schema: DISCOVERY_SCHEMA,
        skills: [
          { name: "log-triage", type: "skill-md", description: "Summarise logs.", url: "log-triage/SKILL.md", digest: `sha256:${"a".repeat(64)}` },
          { name: "db-migrate", type: "archive", description: "Plan migrations.", url: "/files/db-migrate.tar.gz", digest: `sha256:${"b".repeat(64)}`, version: "2.1.0" },
          { name: "on-cdn", type: "skill-md", description: "Elsewhere.", url: "https://cdn.test/x/SKILL.md", digest: `sha256:${"c".repeat(64)}` },
        ],
        plugins: [
          { name: "crm", description: "A CRM.", version: "1.4.0", source: "@acme/praecise-crm", digest: `sha256:${"d".repeat(64)}` },
          { name: "ledger", description: "A ledger.", source: "git+https://git.test/acme/ledger.git", package: "praecise-ledger" },
        ],
      },
      INDEX,
    );
    expect(notes).toEqual([]);
    expect(entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(["skill:log-triage", "skill:db-migrate", "skill:on-cdn", "plugin:crm", "plugin:ledger"]);
    expect(entries[0]).toMatchObject({ source: "https://skills.test/.well-known/agent-skills/log-triage/SKILL.md", digest: "a".repeat(64), registry: INDEX });
    expect(entries[1]).toMatchObject({ source: "https://skills.test/files/db-migrate.tar.gz", type: "archive", version: "2.1.0" });
    expect(entries[2]!.source).toBe("https://cdn.test/x/SKILL.md");
    expect(entries[3]).toMatchObject({ source: "@acme/praecise-crm", package: "@acme/praecise-crm", version: "1.4.0", digest: "d".repeat(64) });
    expect(entries[4]).toMatchObject({ source: "git+https://git.test/acme/ledger.git", package: "praecise-ledger" });
  });

  it("leaves out what cannot be trusted to mean what it says, and names each one", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const { entries, notes } = parseIndex(
      {
        skills: [
          { name: "no-digest", type: "skill-md", description: "x", url: "a/SKILL.md" },
          { name: "upper-digest", type: "skill-md", description: "x", url: "a/SKILL.md", digest: `sha256:${"A".repeat(64)}` },
          { name: "plain-http", type: "skill-md", description: "x", url: "http://skills.test/a/SKILL.md", digest },
          { name: "a-file", type: "skill-md", description: "x", url: "file:///etc/passwd", digest },
          { name: "future", type: "bundle-v9", description: "x", url: "a", digest },
          { name: "../escape", type: "skill-md", description: "x", url: "a", digest },
          { name: "twice", type: "skill-md", description: "x", url: "a", digest },
          { name: "twice", type: "skill-md", description: "y", url: "b", digest },
        ],
        plugins: [
          { name: "by-url", description: "x", source: "https://git.test/Some/Repo.git" },
          { name: "odd", description: "x", source: "git://git.test/x.git" },
          { name: "shell", description: "x", source: "left-pad; rm -rf ~" },
          { name: "bad-digest", description: "x", source: "left-pad", digest: "md5:abc" },
        ],
      },
      INDEX,
    );
    expect(entries.map((entry) => entry.name)).toEqual(["twice", "by-url"]);
    expect(entries[0]!.description).toBe("x");
    const said = notes.join("\n");
    for (const name of ["no-digest", "upper-digest", "plain-http", "a-file", "future", "../escape", "odd", "shell", "bad-digest"]) {
      expect(said).toContain(name);
    }
    expect(said).toContain('skill "twice" is listed twice');
    expect(said).toContain("nothing is installed unverified");
    expect(parseIndex([], INDEX).notes).toHaveLength(1);
    expect(parseIndex({}, INDEX).notes[0]).toContain("neither");
  });

  it("an origin names its well-known index, and a full URL names itself", () => {
    expect(indexUrlOf("https://skills.test")).toBe(INDEX);
    expect(indexUrlOf("https://skills.test/")).toBe(INDEX);
    expect(indexUrlOf("https://team.test/registry/index.json")).toBe("https://team.test/registry/index.json");
  });

  it("search needs every word, and puts a name match first", () => {
    const entries = [
      skillEntry({ name: "pdf-forms", description: "Fill in PDF forms." }),
      skillEntry({ name: "invoices", description: "Read a PDF invoice and its line items." }),
      skillEntry({ name: "csv", description: "Tables." }),
    ];
    expect(searchEntries(entries, "pdf").map((entry) => entry.name)).toEqual(["pdf-forms", "invoices"]);
    expect(searchEntries(entries, "PDF line").map((entry) => entry.name)).toEqual(["invoices"]);
    expect(searchEntries(entries, "robots")).toEqual([]);
  });
});

describe("reading registries", () => {
  it("reads each index, and one that cannot be read does not stop the rest", async () => {
    const net = web({
      [INDEX]: { body: JSON.stringify({ skills: [{ name: "log-triage", type: "skill-md", description: "x", url: "log-triage/SKILL.md", digest: `sha256:${sha(SKILL)}` }] }) },
      "https://broken.test/index.json": { body: "{ not json" },
    });
    const { entries, problems } = await readRegistries(
      ["https://skills.test", "https://broken.test/index.json", "https://gone.test/index.json", "http://plain.test/index.json", "not a url"],
      net.fetch,
    );
    expect(entries.map((entry) => entry.name)).toEqual(["log-triage"]);
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toContain("https://gone.test/index.json: https://gone.test/index.json answered 404");
    expect(problems.join("\n")).toContain("is not https, so it is not fetched");
    // Refused before the network, not after it.
    expect(net.asked).not.toContain("http://plain.test/index.json");
  });
});

describe("installing a skill", () => {
  it("verifies the digest, checks it is a skill, and writes it under skills/<name>/", async () => {
    const root = await makeProject({});
    roots.push(root);
    const entry = skillEntry();
    const net = web({ [entry.source]: { body: SKILL } });

    const fetched = await fetchSkill(entry, net.fetch);
    expect(fetched).toMatchObject({ name: "log-triage", description: "Summarise application logs and flag likely root causes." });
    expect(fetched.body).toContain("Read the newest log first.");
    const { written } = await installSkill(root, fetched);
    expect(written).toEqual(["skills/log-triage/SKILL.md"]);
    expect(await readFile(join(root, "skills", "log-triage", "SKILL.md"), "utf8")).toBe(SKILL);

    // The folder is an ordinary skill to the loader.
    const project = await loadProject(root);
    expect(Object.keys(project.skills ?? {})).toEqual(["log-triage"]);
    expect(project.faults).toEqual([]);

    await expect(installSkill(root, fetched)).rejects.toThrow(/already exists; pass --force/);
    await writeFile(join(root, "skills", "log-triage", "stale.md"), "left over", "utf8");
    await installSkill(root, fetched, { force: true });
    expect(await readdir(join(root, "skills", "log-triage"))).toEqual(["SKILL.md"]);
  });

  it("refuses bytes that do not match the digest, and writes nothing", async () => {
    const root = await makeProject({});
    roots.push(root);
    const entry = skillEntry();
    const net = web({ [entry.source]: { body: SKILL.replace("newest", "oldest") } });
    await expect(fetchSkill(entry, net.fetch)).rejects.toThrow(/does not match the digest/);
    expect(await stat(join(root, "skills")).catch(() => undefined)).toBeUndefined();
  });

  it("refuses a file that is not the skill the index named", async () => {
    const other = SKILL.replace("name: log-triage", "name: something-else");
    const entry = skillEntry({ digest: sha(other) });
    await expect(fetchSkill(entry, web({ [entry.source]: { body: other } }).fetch)).rejects.toThrow(/must equal the skill's folder name/);
    const prose = "just some text";
    const bare = skillEntry({ digest: sha(prose) });
    await expect(fetchSkill(bare, web({ [bare.source]: { body: prose } }).fetch)).rejects.toThrow(/is not a skill this app could load/);
  });

  it("unpacks a .tar.gz with its scripts beside it, none of them executable or run", async () => {
    const root = await makeProject({});
    roots.push(root);
    const marker = join(root, "ran.txt");
    const archive = tarGz(
      tarEntry("SKILL.md", SKILL),
      tarEntry("scripts/", "", "5"),
      tarEntry("scripts/tail.sh", `#!/bin/sh\necho ran > ${marker}\n`),
      tarEntry("references/format.md", "# Log format"),
    );
    const entry = skillEntry({ type: "archive", source: "https://skills.test/files/log-triage.tar.gz", digest: sha(archive) });
    const fetched = await fetchSkill(entry, web({ [entry.source]: { body: archive, type: "application/gzip" } }).fetch);
    const { written } = await installSkill(root, fetched);
    expect(written).toEqual(["skills/log-triage/SKILL.md", "skills/log-triage/references/format.md", "skills/log-triage/scripts/tail.sh"]);
    expect(await stat(marker).catch(() => undefined)).toBeUndefined();
    if (process.platform !== "win32") {
      expect((await stat(join(root, "skills", "log-triage", "scripts", "tail.sh"))).mode & 0o111).toBe(0);
    }
  });

  it("refuses the whole archive for one path that leaves the folder, a link, or no SKILL.md at its root", async () => {
    const root = await makeProject({});
    roots.push(root);
    const refused = async (archive: Buffer, why: RegExp): Promise<void> => {
      const entry = skillEntry({ type: "archive", source: "https://skills.test/files/x.tar.gz", digest: sha(archive) });
      await expect(fetchSkill(entry, web({ [entry.source]: { body: archive } }).fetch)).rejects.toThrow(why);
    };
    await refused(tarGz(tarEntry("SKILL.md", SKILL), tarEntry("../../guard.ts", "export default () => undefined;")), /climbs out of the skill's folder/);
    await refused(tarGz(tarEntry("SKILL.md", SKILL), tarEntry("/etc/cron.d/x", "* * * * *")), /absolute path/);
    await refused(tarGz(tarEntry("SKILL.md", SKILL), tarEntry("scripts\\..\\..\\x.ts", "x")), /backslash or a colon/);
    await refused(tarGz(tarEntry("SKILL.md", SKILL), tarEntry("C:evil.ts", "x")), /backslash or a colon/);
    await refused(tarGz(tarEntry("SKILL.md", SKILL), tarEntry("scripts/run", "", "2", "/bin/sh")), /holds a link/);
    await refused(tarGz(tarEntry("SKILL.md", SKILL), tarEntry("hard", "", "1", "SKILL.md")), /holds a link/);
    await refused(tarGz(tarEntry("SKILL.md", SKILL), tarEntry("skill.md", "again")), /twice/);
    await refused(tarGz(tarEntry("log-triage/SKILL.md", SKILL)), /no SKILL\.md at its root/);
    await refused(Buffer.from("neither one thing nor the other"), /could not be read as \.tar\.gz/);
    const odd = Buffer.from("neither one thing nor the other");
    const unnamed = skillEntry({ type: "archive", source: "https://skills.test/files/download", digest: sha(odd) });
    await expect(fetchSkill(unnamed, web({ [unnamed.source]: { body: odd } }).fetch)).rejects.toThrow(/neither a \.tar\.gz nor a \.zip/);
    expect(await stat(join(root, "skills")).catch(() => undefined)).toBeUndefined();
  });

  it("reads a .zip, stored and deflated, under the same refusals", async () => {
    const good = zip([
      { name: "SKILL.md", data: SKILL },
      { name: "references/", data: "" },
      { name: "references/format.md", data: "# Log format\n".repeat(50), deflate: true },
    ]);
    expect(archiveFormat(null, "https://x.test/a.zip", good)).toBe("zip");
    expect(archiveFormat("application/octet-stream", "https://x.test/download", good)).toBe("zip");
    const files = unpackArchive(good, "zip");
    expect(files.map((file) => file.path)).toEqual(["SKILL.md", "references/format.md"]);
    expect(Buffer.from(files[1]!.data).toString("utf8")).toBe("# Log format\n".repeat(50));

    expect(() => unpackArchive(zip([{ name: "../x.ts", data: "x" }]), "zip")).toThrow(/climbs out/);
    expect(() => unpackArchive(zip([{ name: "run", data: "/bin/sh", mode: 0o120777 }]), "zip")).toThrow(/holds a link/);
    expect(() => unpackArchive(Buffer.from("PK nothing here"), "zip")).toThrow(/could not be read as \.zip/);
  });

  it("stops at its limits, so an archive cannot unpack without end", () => {
    const big = "0".repeat(200_000);
    expect(() => unpackArchive(zip([{ name: "SKILL.md", data: big, deflate: true }]), "zip", { bytes: 50_000 })).toThrow(/unpacks to more than 50,000 bytes/);
    expect(() => unpackArchive(tarGz(tarEntry("a", "1"), tarEntry("b", "2"), tarEntry("c", "3")), "tar.gz", { files: 2 })).toThrow(/more than 2 files/);
    expect(() => unpackArchive(tarGz(tarEntry("a", big)), "tar.gz", { bytes: 50_000 })).toThrow(/nothing was unpacked/);
  });

  it("the installer itself will not write outside the skill's folder, whatever it is handed", async () => {
    const root = await makeProject({});
    roots.push(root);
    const handed = { name: "log-triage", description: "x", body: "x", advice: [], files: [{ path: "../../guard.ts", data: Buffer.from("x") }] };
    await expect(installSkill(root, handed)).rejects.toThrow(/outside skills\/log-triage/);
    await expect(installSkill(root, { ...handed, name: "../up", files: [] })).rejects.toThrow(/not a name a skill folder can have/);
    expect(await stat(join(root, "guard.ts")).catch(() => undefined)).toBeUndefined();
    expect(() => safeRelativePath("a/./b")).toThrow();
    expect(safeRelativePath("./scripts/run.sh")).toBe("scripts/run.sh");
  });
});

const pluginEntry = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  kind: "plugin",
  name: "crm",
  description: "A CRM.",
  version: "1.4.0",
  source: "praecise-crm",
  package: "praecise-crm",
  digest: "d".repeat(64),
  registry: INDEX,
  ...over,
});

describe("recording a plugin", () => {
  it("writes it down with the command that installs it, and installs nothing", async () => {
    const root = await makeProject({});
    roots.push(root);
    const first = await recordPlugin(root, pluginEntry());
    expect(first.install).toBe("npm install praecise-crm@1.4.0");
    expect(first.replaced).toBeUndefined();
    expect((await readRecordedPlugins(root)).plugins).toEqual([
      { name: "crm", package: "praecise-crm", source: "praecise-crm", version: "1.4.0", digest: `sha256:${"d".repeat(64)}`, registry: INDEX },
    ]);
    expect(await stat(join(root, "node_modules")).catch(() => undefined)).toBeUndefined();

    const again = await recordPlugin(root, pluginEntry({ source: "git+https://git.test/acme/crm.git", version: undefined }));
    expect(again.install).toBe("npm install git+https://git.test/acme/crm.git");
    expect(again.replaced).toMatchObject({ source: "praecise-crm" });
    expect((await readRecordedPlugins(root)).plugins).toHaveLength(1);
  });

  it("the app says a recorded plugin is not installed, and loads it once it is", async () => {
    const root = await makeProject({
      "agents/own.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "The app's own agent." });`,
    });
    roots.push(root);
    await recordPlugin(root, pluginEntry());

    const before = await loadProject(root);
    expect(before.warnings.join("\n")).toContain('plugin "crm" is recorded in praecise.plugins.json and is not installed; run `npm install praecise-crm@1.4.0`');
    expect(before.faults).toEqual([]);
    expect(Object.keys(before.agents)).toEqual(["own"]);

    // What the person's package manager would have put there.
    const at = join(root, "node_modules", "praecise-crm");
    await mkdir(join(at, "dist"), { recursive: true });
    await writeFile(join(at, "package.json"), JSON.stringify({ name: "praecise-crm", type: "module", exports: { ".": { import: "./dist/index.js" } } }), "utf8");
    await writeFile(
      join(at, "dist", "index.js"),
      `export default { name: "crm", app: { agents: { account: { role: "Look an account up." } } } };`,
      "utf8",
    );
    const after = await loadProject(root, { version: "installed" });
    expect(after.faults).toEqual([]);
    expect(Object.keys(after.agents).sort()).toEqual(["account", "own"]);
    expect(after.config.plugins?.map((plugin) => plugin.name)).toEqual(["crm"]);
  });

  it("a package that is not a plugin is a fault, and a broken file is said so", async () => {
    const root = await makeProject({});
    roots.push(root);
    await recordPlugin(root, pluginEntry());
    const at = join(root, "node_modules", "praecise-crm");
    await mkdir(at, { recursive: true });
    await writeFile(join(at, "package.json"), JSON.stringify({ name: "praecise-crm", type: "module", main: "main.js" }), "utf8");
    await writeFile(join(at, "main.js"), "export default 7;", "utf8");
    expect(((await loadProject(root)).faults ?? []).join("\n")).toContain("praecise-crm does not export a plugin as its default export");

    await writeFile(join(root, "praecise.plugins.json"), "{ nope", "utf8");
    expect(((await loadProject(root, { version: "2" })).faults ?? []).join("\n")).toContain("praecise.plugins.json:");
    await expect(recordPlugin(root, pluginEntry())).rejects.toThrow(/Fix or delete it/);
  });
});

describe("the commands", () => {
  const archive = tarGz(tarEntry("SKILL.md", SKILL.replace("Read the newest log first.", "Read the newest log first.\u001b[2J\u001b[31m")), tarEntry("scripts/tail.sh", "tail -n 50 app.log"));
  const pages = {
    [INDEX]: {
      body: JSON.stringify({
        $schema: DISCOVERY_SCHEMA,
        skills: [{ name: "log-triage", type: "archive", description: "Summarise logs.", url: "log-triage.tar.gz", digest: `sha256:${sha(archive)}`, version: "0.3.0" }],
        plugins: [{ name: "crm", description: "A CRM for agents.", version: "1.4.0", source: "praecise-crm" }],
      }),
    },
    "https://skills.test/.well-known/agent-skills/log-triage.tar.gz": { body: archive, type: "application/gzip" },
  };
  const app = (registries: string[] = ["https://skills.test"]): Promise<string> =>
    makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({ registries: ${JSON.stringify(registries)} });`,
    });
  const captured = (): string[] => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
    return lines;
  };

  it("nothing is fetched by loading the app, listing pieces, or a command that is not search or add", async () => {
    const root = await app();
    roots.push(root);
    const net = web(pages);
    vi.stubGlobal("fetch", net.fetch);
    captured();
    await loadProject(root);
    expect(await main(["list", "--dir", root])).toBe(0);
    expect(await main(["add", "--dir", root])).toBe(0);
    expect(await main(["add", "function", "lookup", "--dir", root])).toBe(0);
    expect(net.asked).toEqual([]);
  });

  it("`search` lists what the registries hold, and fails when the app lists none", async () => {
    const root = await app();
    const bare = await makeProject({});
    roots.push(root, bare);
    const net = web(pages);
    vi.stubGlobal("fetch", net.fetch);
    const lines = captured();

    expect(await main(["search", "--dir", root])).toBe(0);
    expect(lines.join("")).toContain("log-triage");
    expect(lines.join("")).toContain("crm");
    expect(net.asked).toEqual([INDEX]);

    lines.length = 0;
    expect(await main(["search", "crm", "--dir", root, "--json"])).toBe(0);
    expect(JSON.parse(lines.join("")).results).toMatchObject([{ kind: "plugin", name: "crm", source: "praecise-crm" }]);
    expect(await main(["search", "nothing-like-it", "--dir", root])).toBe(1);
    expect(await main(["search", "--dir", bare])).toBe(1);
    expect(lines.join("")).toContain("lists no registries");
  });

  it("`add <skill>` installs it and prints what it says, with nothing a terminal would act on", async () => {
    const root = await app();
    roots.push(root);
    vi.stubGlobal("fetch", web(pages).fetch);
    const lines = captured();

    expect(await main(["add", "log-triage", "--show", "--dir", root])).toBe(0);
    expect(await stat(join(root, "skills")).catch(() => undefined)).toBeUndefined();

    lines.length = 0;
    expect(await main(["add", "log-triage", "--dir", root])).toBe(0);
    const said = lines.join("");
    expect(said).toContain("skills/log-triage/SKILL.md");
    expect(said).toContain("skills/log-triage/scripts/tail.sh");
    expect(said).toContain("sha256 verified");
    expect(said).toContain("Read the newest log first.");
    expect(said).toContain("none has been run or made executable");
    expect(said).not.toContain("\u001b[2J");
    expect(said).not.toContain("\u001b[31m");
    expect(await readFile(join(root, "skills", "log-triage", "scripts", "tail.sh"), "utf8")).toBe("tail -n 50 app.log");

    expect(await main(["add", "log-triage", "--dir", root])).toBe(1);
    expect(await main(["add", "log-triage", "--force", "--dir", root])).toBe(0);
  });

  it("`add <plugin>` records it and says how to install it, and a name nobody lists is an error", async () => {
    const root = await app();
    roots.push(root);
    vi.stubGlobal("fetch", web(pages).fetch);
    const lines = captured();

    expect(await main(["add", "crm", "--dir", root])).toBe(0);
    expect(lines.join("")).toContain("npm install praecise-crm@1.4.0");
    expect(lines.join("")).toContain("nothing has been installed");
    expect((await readRecordedPlugins(root)).plugins).toMatchObject([{ name: "crm", package: "praecise-crm" }]);
    expect(await stat(join(root, "node_modules")).catch(() => undefined)).toBeUndefined();

    expect(await main(["add", "no-such-thing", "--dir", root])).toBe(1);
    expect(await main(["add", "crm", "--kind", "skill", "--dir", root])).toBe(1);
  });
});
