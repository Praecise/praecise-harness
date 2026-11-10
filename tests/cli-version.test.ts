/**
 * `praecise --version` and `-v` print this package's version and nothing else.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/index.js";
import { VERSION } from "../src/cli/scaffold.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function captured(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
  return lines;
}

describe("the version flag", () => {
  for (const flag of ["--version", "-v"]) {
    it(`${flag} prints the version alone`, async () => {
      const lines = captured();
      expect(await main([flag])).toBe(0);
      expect(lines.join("")).toBe(`${VERSION}\n`);
    });
  }

  it("no command still prints the usage", async () => {
    const lines = captured();
    expect(await main([])).toBe(0);
    expect(lines.join("")).toContain("agents from a folder");
    expect(lines.join("")).not.toBe(`${VERSION}\n`);
  });
});
