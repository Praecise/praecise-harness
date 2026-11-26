/**
 * What a function attaches reaches an MCP client as what it is.
 *
 * A screenshot is the reason a client calls a screen at all. Rendered as text it is a
 * sentence saying a picture exists, which is no use to the model that asked to look.
 */
import { afterEach, describe, expect, test } from "vitest";

import { App } from "../src/app.js";
import { mcpRequest } from "../src/harness/mcp.js";
import { handleMcp } from "../src/server/mcp.js";
import { FRAMEWORK, MODEL_ENV, TEST_ENDPOINT, cleanup, makeProject, stubModel } from "./helpers.js";

describe("a function's attachments over MCP", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(cleanup));
  });

  test("a picture is image content beside what was said, and a result with none is unchanged", async () => {
    const root = await makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({ name: "acme", ${TEST_ENDPOINT} });`,
      "functions/look.ts": `import { attach, fn } from "${FRAMEWORK}";
        export default fn({ description: "Look at the screen.", effect: "read", run: () => attach("The screen, 2 by 1.", { mime: "image/png", data: "iVBORw0KGgo=", name: "screenshot.png" }, { mime: "application/pdf", data: "JVBERg==", name: "report.pdf" }) });`,
      "functions/say.ts": `import { fn } from "${FRAMEWORK}";
        export default fn({ description: "Say something.", effect: "read", run: () => ({ said: "hello" }) });`,
    });
    roots.push(root);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stubModel([]).fetch });
    const call = async (name: string): Promise<{ content: Record<string, unknown>[]; isError: boolean }> =>
      ((await handleMcp(app, mcpRequest("tools/call", { name, arguments: {} }), { identified: true })) as { result: { content: Record<string, unknown>[]; isError: boolean } }).result;

    expect((await call("look")).content).toEqual([
      { type: "text", text: "The screen, 2 by 1." },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      { type: "text", text: "[attached and not sent: report.pdf]" },
    ]);
    expect((await call("say")).content).toEqual([{ type: "text", text: JSON.stringify({ said: "hello" }, null, 2) }]);
    await app.close();
  });
});
