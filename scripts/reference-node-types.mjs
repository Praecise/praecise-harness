/**
 * Put `/// <reference types="node" />` at the head of the published entry declarations.
 *
 * This package's public types name `Buffer` and the `node:*` modules. Whether ambient node types
 * are in scope is a decision the CONSUMER's tsconfig makes — so a published `.d.ts` that relies
 * on that decision fails to typecheck for anyone who did not make it, which is exactly what the
 * `consumer` CI job caught: a stranger installing the tarball got eight errors on `Buffer`,
 * `node:http`, `node:stream` and `node:sqlite`.
 *
 * The reference is written in the source too, and TypeScript strips it at emit when it judges it
 * redundant for the build — which it is for the build, and is not for the consumer. So it is put
 * back here, after the compiler has had its say.
 *
 * Only the two entry declarations need it. Everything else is reached through them, and a
 * reference at the entry brings node's types into the consumer's program for the whole package.
 */
import { readFile, writeFile } from "node:fs/promises";

const REFERENCE = '/// <reference types="node" />\n';
const ENTRIES = ["dist/index.d.ts", "dist/internal.d.ts"];

for (const file of ENTRIES) {
  const text = await readFile(file, "utf8");
  if (text.startsWith(REFERENCE)) continue;
  await writeFile(file, REFERENCE + text);
}
