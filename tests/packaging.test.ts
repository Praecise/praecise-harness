/**
 * The parts of `package.json` that npm removes on its own.
 *
 * These are not style checks. Each one is a field that has already been silently deleted or
 * loosened by a routine `npm install`, in a package that is PUBLISHED — so the damage lands on
 * whoever installs it next rather than on anybody who could notice here.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe("published packaging", () => {
  /**
   * `@types/node` has to be a RUNTIME dependency, not a dev one.
   *
   * 58232bb added it — "The published types did not resolve for anyone who installed them" — and
   * `npm install` deletes it again every time it resolves anything else. It has been removed at
   * least twice this way, silently, while the install reported success.
   *
   * A dev dependency is not installed for consumers, so the published `.d.ts` files reference a
   * `node` types package that is not there and every type in this library degrades to `any` on
   * the far side. Nothing fails here when that happens, which is the whole problem: the package
   * builds, tests and publishes exactly as it does when it is correct.
   */
  it("keeps @types/node as a runtime dependency, because the published types need it", () => {
    expect(
      pkg.dependencies?.["@types/node"],
      "npm has deleted this entry before; without it the published types resolve to nothing",
    ).toBeTruthy();
  });

  /**
   * A caret on a pre-release is not a pin.
   *
   * `^7.1.0-dev.20260819.1` admits 7.1.0-dev.20260820.1, then 7.1.0, then 7.2.0, and on to
   * 7.9.9 — so "we are on a known dev build" quietly becomes "we are on whatever shipped since".
   * The workspace typecheck ratchet exists to catch drift, and it cannot catch drift in the
   * compiler that produces its own numbers.
   */
  it("pins pre-release toolchain versions exactly, since a caret on a pre-release floats", () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, range] of Object.entries(all)) {
      if (!/-(dev|rc|beta|alpha|next|canary)\b/.test(range)) continue;
      expect(
        /^[0-9]/.test(range),
        `${name} is a pre-release declared as "${range}" — drop the range operator and pin it`,
      ).toBe(true);
    }
  });
});
