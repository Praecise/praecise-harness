/**
 * Which request shape an endpoint speaks — an open registry, not a closed set.
 *
 * The shapes that ship are named after the field they carry a conversation in, or after
 * the endpoint where two of them would otherwise collide on one name, and between them
 * they cover most endpoints worth talking to. They are not a limit.
 *
 * This used to be a frozen map over a three-value union, and the effect was worse than
 * inconvenience: a vendor outside those three shapes could not be reached at all. An
 * author could implement `ChatAdapter` — it is public, and it typechecks — and then have
 * nowhere to put the result, because `speaks` would not accept the name and nothing
 * exposed the map. With the package's `exports` admitting only the root, that made a
 * fourth endpoint a FORK. A framework that ships an interface it will not accept an
 * implementation of has published a type, not a seam.
 *
 * So: register a shape under a name, then write that name in `speaks`. The framework
 * still ships no model ids and no base URLs — those belong to the app that chose them —
 * but it will now talk to whatever an app can describe.
 */

import type { Wire } from "../../compile/models.js";
import type { ChatAdapter } from "../types.js";
import { chatWire } from "./chat.js";
import { contentsWire } from "./contents.js";
import { interactionsWire } from "./interactions.js";
import { messagesWire } from "./messages.js";
import { responsesWire } from "./responses.js";

const ADAPTERS = new Map<Wire, ChatAdapter>([
  ["messages", messagesWire],
  ["chat", chatWire],
  ["contents", contentsWire],
  // Two vendors have made this their primary surface; one of them now labels
  // chat-completions legacy outright. The default takes the system prompt as a
  // role inside the input, which both understand — an endpoint wanting the
  // top-level `instructions` field registers its own under another name.
  ["responses", responsesWire()],
  // The surface Google made primary for Gemini. Named after the endpoint rather than
  // after the field it carries its conversation in, because that field is `input` and
  // "input" is already what the `responses` shape calls its own, differently-shaped one —
  // two wires answering to one name would make `speaks` ambiguous at exactly the moment a
  // reader is trying to work out which vendor a config line means. `generateContent` stays
  // registered as "contents" and stays supported; this is where new capability lands.
  ["interactions", interactionsWire],
]);

/** The shapes that ship. Registering over one of these is refused — see below. */
const BUILT_IN: ReadonlySet<Wire> = new Set(["messages", "chat", "contents", "responses", "interactions"]);

/**
 * Teach the framework a request shape.
 *
 * Replacing a built-in is refused rather than allowed. A registry that lets one import
 * silently change what `speaks: "chat"` means everywhere is a debugging problem nobody
 * can see from the file that has the bug — and a framework's job is to make the second
 * thing that happens explicable by the first. Register your own under your own name.
 */
export function registerWire(name: string, adapter: ChatAdapter): void {
  if (!name || !name.trim()) throw new Error("a wire needs a name to be written in `speaks`");
  if (BUILT_IN.has(name)) {
    throw new Error(
      `"${name}" is a shape this framework ships, and replacing it would silently change ` +
        `what every app meaning that name gets. Register yours under a different name.`,
    );
  }
  if (typeof adapter !== "function") throw new Error(`wire "${name}" must be a function taking a ChatRequest`);
  ADAPTERS.set(name, adapter);
}

/** The names currently registered, for an error message or a diagnostic. */
export const knownWires = (): Wire[] => [...ADAPTERS.keys()];

/**
 * Resolve a shape by name. Unknown names throw NAMING WHAT IS KNOWN — the old map
 * returned `undefined` here, which surfaced later as a call on a non-function, at a
 * point in the stack with nothing to say about the config line that caused it.
 */
export function adapterFor(wire: Wire): ChatAdapter {
  const adapter = ADAPTERS.get(wire);
  if (!adapter) {
    throw new Error(
      `no endpoint shape called "${wire}". This framework speaks ${knownWires().map((w) => `"${w}"`).join(", ")}. ` +
        `Add your own with registerWire("${wire}", adapter) before the app loads, or correct \`speaks\`.`,
    );
  }
  return adapter;
}

export { chatWire, contentsWire, interactionsWire, messagesWire, responsesWire };
export type { SystemAs } from "./responses.js";
export type { InteractionsResponse, ThinkingLevel } from "./interactions.js";
