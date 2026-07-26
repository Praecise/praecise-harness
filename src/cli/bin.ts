#!/usr/bin/env node
/**
 * Entry point.
 *
 * Agents are written in TypeScript and imported at runtime, so the process has
 * to be able to strip types. Node 23.6+ does it by default; on 22.x it needs a
 * flag, which we add by re-executing ourselves once rather than making the
 * author remember it.
 */

import { spawnSync } from "node:child_process";

import { main } from "./index.js";

const REEXEC = "PRAECISE_REEXEC";

if (!process.features.typescript && !process.env[REEXEC]) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", ...process.argv.slice(1)],
    { stdio: "inherit", env: { ...process.env, [REEXEC]: "1" } },
  );
  process.exit(result.status ?? 1);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: Error) => {
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exitCode = 1;
  });
