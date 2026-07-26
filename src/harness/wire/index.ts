/**
 * Three request shapes cover the endpoints worth talking to, and each is named
 * after the field it carries its conversation in. `Rung.wire` picks one.
 */

import type { Wire } from "../../compile/models.js";
import type { ChatAdapter } from "../types.js";
import { chatWire } from "./chat.js";
import { contentsWire } from "./contents.js";
import { messagesWire } from "./messages.js";

const ADAPTERS: Record<Wire, ChatAdapter> = {
  messages: messagesWire,
  chat: chatWire,
  contents: contentsWire,
};

export function adapterFor(wire: Wire): ChatAdapter {
  return ADAPTERS[wire];
}

export { chatWire, contentsWire, messagesWire };
