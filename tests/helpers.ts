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

export interface Reply {
  text: string;
  /** Tool the model should ask for instead of answering. */
  tool?: { name: string; args: unknown };
  /** Provider-native stop reason, where a test needs one other than the usual. */
  stop?: string;
}

/** The scripted reply, delivered a word at a time as server-sent events. */
function asEvents(reply: Reply, stop: string): Response {
  const text = reply.text
    ? reply.text.split(/(?<=\s)/).map((piece) => ({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: piece },
      }))
    : [];

  const tool = reply.tool
    ? [
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "t1", name: reply.tool.name },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.tool.args) },
        },
      ]
    : [];

  const frames = [
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    ...text,
    ...tool,
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } },
  ];

  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * A stand-in for an endpoint on the `messages` wire. Each call shifts the next
 * scripted reply, so a test can drive a cascade turn by turn.
 */
export function stubModel(replies: Reply[]): {
  fetch: typeof fetch;
  calls: { model: string; body: Record<string, unknown> }[];
} {
  const calls: { model: string; body: Record<string, unknown> }[] = [];
  const queue = [...replies];

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ model: String(body.model), body });

    if (!url.includes("/v1/messages")) {
      return new Response("not found", { status: 404 });
    }

    const reply = queue.shift() ?? { text: "no more scripted replies" };
    const stop = reply.stop ?? (reply.tool ? "tool_use" : "end_turn");
    if (body.stream) return asEvents(reply, stop);

    const content = [
      ...(reply.text ? [{ type: "text", text: reply.text }] : []),
      ...(reply.tool
        ? [{ type: "tool_use", id: "t1", name: reply.tool.name, input: reply.tool.args }]
        : []),
    ];

    return new Response(
      JSON.stringify({
        content,
        stop_reason: stop,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  return { fetch: impl, calls };
}
