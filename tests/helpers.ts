import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A throwaway project directory built from a path → contents map. */
export async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "praecise-test-"));
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return root;
}

export async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

/** Absolute specifier so a scaffolded project can import the framework. */
export const FRAMEWORK = new URL("../src/index.ts", import.meta.url).href;

/**
 * The endpoint tests run against, as a config fragment. The framework knows no
 * endpoint but Praecise Cloud, so tests describe their own, exactly as an app
 * bringing its own models would.
 */
export const TEST_ENDPOINT = `models: {
      house: {
        url: "https://models.test",
        credential: "HOUSE_KEY",
        speaks: "messages",
        fast: "small",
        balanced: "mid",
        best: "large",
      },
    }`;

/** The same endpoint as a whole config file, for projects that declare no other. */
export const TEST_MODELS: Record<string, string> = {
  "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
    export default defineConfig({ ${TEST_ENDPOINT} });`,
};

/** The credential for the endpoint above. */
export const MODEL_ENV = { HOUSE_KEY: "test-key" };

/**
 * The bearer token the test servers are started with.
 *
 * Fixed rather than minted so a test can assert on it. Real servers mint one per
 * start; passing an explicit token is the supported way to bring your own.
 */
export const TEST_TOKEN = "test-bearer-token";

/** Headers carrying the token, merged over whatever the caller wanted. */
export const authed = (extra: Record<string, string> = {}): Record<string, string> => ({
  authorization: `Bearer ${TEST_TOKEN}`,
  ...extra,
});

/**
 * The scripted endpoint the framework publishes for an app's own tests, under the name
 * these tests have always called it by.
 */
export { scriptedEndpoint as stubModel, systemText } from "../src/testing/index.js";
export type { EndpointReply as Reply } from "../src/testing/index.js";
