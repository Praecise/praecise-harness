/**
 * The host's half of an MCP App's message bridge, as far as a host without a screen can
 * hold it.
 *
 * An MCP App is a page a service's tool brought with its result. Rendered, it sits in a
 * sandboxed frame and talks to its host in JSON-RPC over `postMessage`: it asks to call
 * tools, read resources, send a message, open a link, change its size. The extension
 * gives every one of those to "the host", and here the host is in two places. The frame
 * is in a browser, with a front end around it. The services, the guard and the authority
 * are in this process.
 *
 * So the bridge is split where the page's requests split. What needs the app is
 * answered here: a front end forwards the page's message to `/api/ui/<service>` and
 * posts the reply back into the frame.
 *
 *   `tools/call`      the tool must be on the view's own service and marked callable by
 *                     views; then the guard and the authority are asked, exactly as for a
 *                     model's call, with `via: "ui"`.
 *   `resources/read`  read from the view's own service.
 *   `ping`            answered.
 *   notifications     taken and dropped: a page's log line is not this process's to keep.
 *
 * What needs a browser is not answered here, and is refused by name so that a front end
 * that forwards one by mistake is told whose it is:
 *
 *   `ui/initialize`             the reply is mostly the frame's surroundings: theme,
 *                               display mode, container size, locale, platform.
 *   `ui/open-link`              opening a link is a browser's act, on a person's consent.
 *   `ui/message`,               both put something into the conversation the person is
 *   `ui/update-model-context`   having, which the front end holds and this does not.
 *   `ui/request-display-mode`,  the frame's own geometry.
 *   `ui/notifications/size-changed`
 *
 * The sandbox itself is the front end's too: the frame on a separate origin, its
 * content-security policy built from the view's `meta.csp` and nothing wider, the
 * `ui/notifications/tool-input` and `tool-result` messages posted into it from the
 * view's `toolInput` and `toolResult`, and `ui/resource-teardown` before it is removed.
 */

import type { App } from "../app.js";

/** Which methods a front end answers itself, and what each needs that this does not have. */
const FRONT_END: Record<string, string> = {
  "ui/initialize": "its reply describes the frame's surroundings: theme, display mode, size, locale",
  "ui/open-link": "opening a link is the browser's act, and takes the person's consent",
  "ui/message": "it adds to the conversation, which the front end holds",
  "ui/update-model-context": "it adds to the conversation, which the front end holds",
  "ui/request-display-mode": "the frame's display mode is the front end's to change",
  "ui/resource-teardown": "it is sent by the host to the view, not the other way",
};

/**
 * Answer one message an MCP App sent, on behalf of the service its view came from.
 *
 * `service` is the view's own (`UiView.service`). The front end supplies it from the
 * view it rendered, never from anything the page says: a page that could name its own
 * service could call any of them. Returns `undefined` for a notification.
 */
export async function handleView(app: App, service: string, message: unknown): Promise<unknown | undefined> {
  const request = message as { jsonrpc?: unknown; id?: string | number | null; method?: unknown; params?: Record<string, unknown> };
  const id = request?.id ?? null;
  const fail = (code: number, text: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message: text } });
  const ok = (result: unknown) => ({ jsonrpc: "2.0" as const, id, result });

  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return fail(-32600, "invalid request");
  // No id: a notification. Nothing a page notifies of changes anything here.
  if (request.id === undefined || request.id === null) return undefined;

  try {
    switch (request.method) {
      case "ping":
        return ok({});

      case "tools/call": {
        const name = request.params?.name;
        if (typeof name !== "string") return fail(-32602, "params.name is required, as a string");
        try {
          return ok(await app.callFromView(service, name, request.params?.arguments ?? {}));
        } catch (err) {
          // A refusal, or a tool that failed, is a result the page can show: the same
          // rule a model's tool call follows, where being told why is the useful part.
          return ok({ content: [{ type: "text", text: (err as Error).message }], isError: true });
        }
      }

      case "resources/read": {
        const uri = request.params?.uri;
        if (typeof uri !== "string") return fail(-32602, "params.uri is required, as a string");
        return ok({ contents: await app.readFromView(service, uri) });
      }

      default: {
        const whose = FRONT_END[request.method];
        return fail(
          -32601,
          whose
            ? `${request.method} is answered by the front end that renders the view, not by the app: ${whose}`
            : `${request.method} is not something a view may ask of this app`,
        );
      }
    }
  } catch (err) {
    return fail(-32000, (err as Error).message);
  }
}
