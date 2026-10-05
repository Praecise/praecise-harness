/**
 * A package's commands, added through the app's config and reached as
 * `praecise <plugin> <command>`, never in place of a built-in.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/index.js";
import { TEST_ENDPOINT, cleanup, FRAMEWORK, makeProject } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(cleanup));
});

async function project(): Promise<string> {
  const root = await makeProject({
    "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
      export default defineConfig({
        name: "acme",
        ${TEST_ENDPOINT},
        plugins: [{
          name: "ops",
          commands: {
            greet: { describe: "Say hello", run: (argv, ctx) => { ctx.out("hello " + argv.join(" ") + " " + String(ctx.flags.tone ?? "")); return 0; } },
            fail: { describe: "Exit 3", run: () => 3 },
          },
        }],
      });`,
  });
  roots.push(root);
  return root;
}

describe("a CLI plugin", () => {
  it("runs its command with the remaining arguments and flags", async () => {
    const root = await project();
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
    expect(await main(["ops", "greet", "world", "--tone", "warm", "--dir", root])).toBe(0);
    expect(lines.join("")).toContain("hello world warm");
    expect(await main(["ops", "fail", "--dir", root])).toBe(3);
  });

  it("lists its commands, and reports an unknown plugin as an unknown command", async () => {
    const root = await project();
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
    expect(await main(["ops", "--dir", root])).toBe(0);
    expect(lines.join("")).toContain("greet");
    expect(await main(["nope", "--dir", root])).toBe(1);
    expect(lines.join("")).toContain("unknown command");
  });
});
