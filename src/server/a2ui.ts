/**
 * A2UI: an interface, described by the agent and drawn by whoever is showing it.
 *
 * An agent that can only answer in prose asks for a date in a sentence and gets one back
 * in a sentence. A2UI lets it send the form instead: a declarative description of a
 * surface, built from components the front end already has, with the buttons wired to
 * named actions that come back as messages. Nothing executable crosses the wire, which
 * is the point: the agent names components from a catalog the renderer chose, and the
 * renderer draws only what it knows.
 *
 * This file is the server's half and only that. It has the message set of A2UI 1.0 as
 * types, a validator for it, a tool an agent calls to send a surface, and the text a
 * person's action on a surface becomes when it comes back in. There is NO renderer
 * here: this framework does not draw anything, and what turns these messages into
 * pixels is the front end's A2UI renderer.
 *
 * ── What is checked, and what cannot be ───────────────────────────────────────
 *
 * The envelope is checked completely: which message it is, its required fields, that no
 * field is present the schema does not allow, that a surface is created before it is
 * updated and not created twice, that a component tree has a root. What a component MAY
 * contain is not checked, because that is the catalog's business and the catalog is the
 * renderer's: a `Button` has whatever properties the renderer's catalog gives it. A
 * renderer that receives a component it cannot draw says so with an `error` message,
 * and that message reaches the agent as input like any other (see `eventsText`).
 *
 * ── How it travels ────────────────────────────────────────────────────────────
 *
 * Over A2A, as the A2UI extension has it: a data part whose metadata says
 * `mimeType: application/a2ui+json` and whose data is the list of messages. Over AG-UI
 * the A2UI specification names AG-UI as a binding and defines no encoding for it, so the
 * one used here is this framework's own: an `ACTIVITY_SNAPSHOT` whose `activityType` is
 * `a2ui` and whose content carries the same list (see `AguiStream.surface`).
 *
 * A renderer says which catalogs it can draw in `a2uiRendererCapabilities`, per turn.
 * A turn that carries none has offered no A2UI, and the tool is not given to the agent
 * for it: the extension forbids sending a surface in reply to such a turn, and an agent
 * holding a tool nothing can show would use it anyway.
 */

import type { LocalTool } from "../compile/plan.js";

/** The version of A2UI these messages are. It goes in every message. */
export const A2UI_VERSION = "1.0";

/** The media type that marks a list of A2UI messages, wherever one is carried. */
export const A2UI_MEDIA_TYPE = "application/a2ui+json";

/** The A2A extension an agent card declares to say it can send A2UI 1.0. */
export const A2UI_EXTENSION_URI = "https://a2ui.org/a2a-extension/a2ui/v1.0";

/** The `activityType` a list of A2UI messages has on an AG-UI stream. This framework's own choice. */
export const A2UI_ACTIVITY = "a2ui";

/** The name of the tool an agent sends a surface with. */
export const SURFACE_TOOL = "show_surface";

/** A call to a function a catalog defines: `{ "@call": name, args }`. */
export interface A2uiFunctionCall {
  "@call": string;
  catalogId?: string;
  args?: Record<string, unknown>;
}

/** One component of a surface. Everything but `id` and `component` is the catalog's. */
export interface A2uiComponent {
  id: string;
  component: string;
  [property: string]: unknown;
}

/** The answer to a function call, in either direction: a value or an error, never both. */
export interface A2uiFunctionResponse {
  functionCallId: string;
  value?: unknown;
  error?: { code: string; message: string };
}

/** What an agent sends a renderer. Exactly one of the six, beside `version`. */
export type A2uiMessage = { version: "1.0" } & (
  | {
      createSurface: {
        surfaceId: string;
        catalogId?: string;
        sendDataModel?: boolean;
        components?: A2uiComponent[];
        dataModel?: Record<string, unknown>;
        metadata?: { extensions?: Record<string, unknown> };
      };
    }
  | { updateComponents: { surfaceId: string; components: A2uiComponent[] } }
  | { updateDataModel: { surfaceId: string; path?: string; value: unknown } }
  | { deleteSurface: { surfaceId: string } }
  | { callRendererFunction: { surfaceId?: string; functionCallId: string; callFunction: A2uiFunctionCall & { catalogId: string } } }
  | { agentFunctionResponse: A2uiFunctionResponse }
);

/** What a renderer sends an agent. Exactly one of the four, beside `version`. */
export type A2uiEvent = { version: "1.0" } & (
  | {
      action: {
        name: string;
        surfaceId: string;
        sourceComponentId: string;
        timestamp: string;
        context: Record<string, unknown>;
        userMessage?: string;
        metadata?: { extensions?: Record<string, unknown> };
      };
    }
  | { callAgentFunction: { surfaceId: string; functionCallId: string; callFunction: A2uiFunctionCall } }
  | { rendererFunctionResponse: A2uiFunctionResponse }
  | { error: { code: string; message: string; surfaceId?: string; path?: string; functionCallId?: string; [more: string]: unknown } }
);

/** What is wrong with one message, in the standard form a model is shown so it can correct it. */
export interface A2uiFault {
  /** Which message in the list. */
  index: number;
  code: "VALIDATION_FAILED";
  /** A JSON pointer to the field, within that message. */
  path: string;
  message: string;
  surfaceId?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const AGENT_KINDS = [
  "createSurface",
  "updateComponents",
  "updateDataModel",
  "deleteSurface",
  "callRendererFunction",
  "agentFunctionResponse",
] as const;

const EVENT_KINDS = ["action", "callAgentFunction", "rendererFunctionResponse", "error"] as const;

/** Extension keys are identifiers; that much of the Unicode rule is checkable without tables. */
const EXTENSION_KEY = /^[\p{ID_Start}_][\p{ID_Continue}]*$/u;

/** A checker for one message: collects what is wrong, each under the field it is wrong at. */
class Checker {
  readonly faults: A2uiFault[] = [];
  private readonly index: number;
  private surfaceId?: string;

  constructor(index: number) {
    this.index = index;
  }

  about(surfaceId: unknown): void {
    if (typeof surfaceId === "string") this.surfaceId = surfaceId;
  }

  wrong(path: string, message: string): void {
    this.faults.push({
      index: this.index,
      code: "VALIDATION_FAILED",
      path,
      message,
      ...(this.surfaceId !== undefined ? { surfaceId: this.surfaceId } : {}),
    });
  }

  /** A required string. Returns it when it is one. */
  text(holder: Record<string, unknown>, key: string, at: string, required = true): string | undefined {
    const value = holder[key];
    if (value === undefined) {
      if (required) this.wrong(`${at}/${key}`, `"${key}" is required`);
      return undefined;
    }
    if (typeof value !== "string") {
      this.wrong(`${at}/${key}`, `"${key}" must be a string`);
      return undefined;
    }
    return value;
  }

  /** No field the schema does not name. */
  only(holder: Record<string, unknown>, allowed: readonly string[], at: string): void {
    for (const key of Object.keys(holder)) {
      if (!allowed.includes(key)) this.wrong(`${at}/${key}`, `"${key}" is not a field of this object`);
    }
  }

  metadata(value: unknown, at: string): void {
    if (value === undefined) return;
    if (!isObject(value)) return this.wrong(at, "metadata must be an object");
    this.only(value, ["extensions"], at);
    if (value.extensions === undefined) return;
    if (!isObject(value.extensions)) return this.wrong(`${at}/extensions`, "extensions must be an object");
    for (const key of Object.keys(value.extensions)) {
      if (!EXTENSION_KEY.test(key)) this.wrong(`${at}/extensions/${key}`, "extension keys must be identifiers");
    }
  }

  call(value: unknown, at: string, needsCatalog: boolean): void {
    if (!isObject(value)) return this.wrong(at, "callFunction must be an object");
    this.text(value, "@call", at);
    if (needsCatalog || value.catalogId !== undefined) this.text(value, "catalogId", at);
    if (value.args !== undefined && !isObject(value.args)) this.wrong(`${at}/args`, "args must be an object");
  }

  response(value: unknown, at: string): void {
    if (!isObject(value)) return this.wrong(at, "a function response must be an object");
    this.only(value, ["functionCallId", "value", "error"], at);
    this.text(value, "functionCallId", at);
    const answered = "value" in value;
    const failed = "error" in value;
    if (answered === failed) this.wrong(at, "a function response carries exactly one of value and error");
    if (failed) {
      if (!isObject(value.error)) return this.wrong(`${at}/error`, "error must be an object");
      this.only(value.error, ["code", "message"], `${at}/error`);
      this.text(value.error, "code", `${at}/error`);
      this.text(value.error, "message", `${at}/error`);
    }
  }

  /** A component list. Returns the ids it defines. */
  components(value: unknown, at: string): string[] {
    if (!Array.isArray(value) || !value.length) {
      this.wrong(at, "components must be a list of at least one component");
      return [];
    }
    const ids: string[] = [];
    value.forEach((entry: unknown, position) => {
      const here = `${at}/${position}`;
      if (!isObject(entry)) return this.wrong(here, "a component must be an object");
      const id = this.text(entry, "id", here);
      const kind = this.text(entry, "component", here);
      if (kind === "Surface") {
        this.wrong(`${here}/component`, '"Surface" is the container a surface already is; it cannot be sent as a component');
      }
      if (id !== undefined) {
        if (ids.includes(id)) this.wrong(`${here}/id`, `the id "${id}" is used by more than one component in this list`);
        ids.push(id);
      }
      if (entry["@catalogId"] !== undefined) this.text(entry, "@catalogId", here);
      if (entry["@metadata"] !== undefined) this.metadata(entry["@metadata"], `${here}/@metadata`);
    });
    return ids;
  }
}

/**
 * What is wrong with a list of agent-to-renderer messages. Empty when nothing is.
 *
 * `surfaces` is what the renderer is known to be showing: the ids of surfaces created
 * and not deleted. Pass the same set from one call to the next and it is kept up to
 * date, so "updated a surface that was never created" is caught across a conversation
 * and not only within one list. `catalogs`, where given, is what the renderer said it
 * can draw; a surface that names another is refused here instead of by the renderer.
 *
 * Messages are judged one at a time, as a renderer applies them: one that is wrong does
 * not make its neighbours wrong, and a surface it would have created does not exist.
 */
export function validateA2ui(
  messages: unknown,
  options: { surfaces?: Set<string>; catalogs?: readonly string[] } = {},
): A2uiFault[] {
  if (!Array.isArray(messages)) {
    return [{ index: 0, code: "VALIDATION_FAILED", path: "", message: "A2UI messages are sent as a list" }];
  }
  const surfaces = options.surfaces ?? new Set<string>();
  const faults: A2uiFault[] = [];

  messages.forEach((message: unknown, index) => {
    const check = new Checker(index);
    const done = (): void => void faults.push(...check.faults);
    if (!isObject(message)) {
      check.wrong("", "a message must be an object");
      return done();
    }
    if (message.version !== A2UI_VERSION) check.wrong("/version", `version must be "${A2UI_VERSION}"`);
    const kinds = AGENT_KINDS.filter((kind) => kind in message);
    if (kinds.length !== 1) {
      check.wrong("", `a message carries exactly one of ${AGENT_KINDS.join(", ")}`);
      return done();
    }
    const kind = kinds[0]!;
    check.only(message, ["version", kind], "");
    const body = message[kind];
    const at = `/${kind}`;
    if (!isObject(body)) {
      check.wrong(at, `${kind} must be an object`);
      return done();
    }
    check.about(body.surfaceId);

    switch (kind) {
      case "createSurface": {
        check.only(body, ["surfaceId", "catalogId", "sendDataModel", "components", "dataModel", "metadata"], at);
        const id = check.text(body, "surfaceId", at);
        const catalog = check.text(body, "catalogId", at, false);
        if (catalog !== undefined && options.catalogs && !options.catalogs.includes(catalog)) {
          check.wrong(`${at}/catalogId`, `the renderer cannot draw "${catalog}"; it offered ${options.catalogs.join(", ") || "no catalogs"}`);
        }
        if (body.sendDataModel !== undefined && typeof body.sendDataModel !== "boolean") {
          check.wrong(`${at}/sendDataModel`, "sendDataModel must be true or false");
        }
        if (body.components !== undefined) check.components(body.components, `${at}/components`);
        if (body.dataModel !== undefined && !isObject(body.dataModel)) check.wrong(`${at}/dataModel`, "dataModel must be an object");
        check.metadata(body.metadata, `${at}/metadata`);
        if (id !== undefined && surfaces.has(id)) {
          check.wrong(`${at}/surfaceId`, `a surface called "${id}" already exists; delete it first, or update it`);
        }
        if (id !== undefined && !check.faults.length) surfaces.add(id);
        break;
      }
      case "updateComponents":
      case "updateDataModel":
      case "deleteSurface": {
        const id = check.text(body, "surfaceId", at);
        if (id !== undefined && !surfaces.has(id)) {
          check.wrong(`${at}/surfaceId`, `no surface called "${id}" has been created`);
        }
        if (kind === "updateComponents") {
          check.only(body, ["surfaceId", "components"], at);
          check.components(body.components, `${at}/components`);
        } else if (kind === "updateDataModel") {
          check.only(body, ["surfaceId", "path", "value"], at);
          check.text(body, "path", at, false);
          // `null` is a value here: it is how a key is deleted. Absent is the fault.
          if (!("value" in body)) check.wrong(`${at}/value`, '"value" is required; send null to delete what is at the path');
        } else {
          check.only(body, ["surfaceId"], at);
          if (id !== undefined && !check.faults.length) surfaces.delete(id);
        }
        break;
      }
      case "callRendererFunction": {
        check.only(body, ["surfaceId", "functionCallId", "callFunction"], at);
        const id = check.text(body, "surfaceId", at, false);
        if (id !== undefined && !surfaces.has(id)) check.wrong(`${at}/surfaceId`, `no surface called "${id}" has been created`);
        check.text(body, "functionCallId", at);
        check.call(body.callFunction, `${at}/callFunction`, true);
        break;
      }
      case "agentFunctionResponse":
        check.response(body, at);
        break;
    }
    done();
  });
  return faults;
}

/** What is wrong with a list of renderer-to-agent messages. Empty when nothing is. */
export function validateA2uiEvents(messages: unknown): A2uiFault[] {
  if (!Array.isArray(messages)) {
    return [{ index: 0, code: "VALIDATION_FAILED", path: "", message: "A2UI messages are sent as a list" }];
  }
  const faults: A2uiFault[] = [];
  messages.forEach((message: unknown, index) => {
    const check = new Checker(index);
    const done = (): void => void faults.push(...check.faults);
    if (!isObject(message)) {
      check.wrong("", "a message must be an object");
      return done();
    }
    if (message.version !== A2UI_VERSION) check.wrong("/version", `version must be "${A2UI_VERSION}"`);
    const kinds = EVENT_KINDS.filter((kind) => kind in message);
    if (kinds.length !== 1 || Object.keys(message).length !== 2) {
      check.wrong("", `a message carries version and exactly one of ${EVENT_KINDS.join(", ")}`);
      return done();
    }
    const kind = kinds[0]!;
    const body = message[kind];
    const at = `/${kind}`;
    if (!isObject(body)) {
      check.wrong(at, `${kind} must be an object`);
      return done();
    }
    check.about(body.surfaceId);

    if (kind === "action") {
      for (const key of ["name", "surfaceId", "sourceComponentId", "timestamp"]) check.text(body, key, at);
      check.text(body, "userMessage", at, false);
      if (!isObject(body.context)) check.wrong(`${at}/context`, "context is required and must be an object");
      check.metadata(body.metadata, `${at}/metadata`);
    } else if (kind === "callAgentFunction") {
      check.only(body, ["surfaceId", "functionCallId", "callFunction"], at);
      check.text(body, "surfaceId", at);
      check.text(body, "functionCallId", at);
      check.call(body.callFunction, `${at}/callFunction`, false);
    } else if (kind === "rendererFunctionResponse") {
      check.response(body, at);
    } else {
      check.text(body, "code", at);
      check.text(body, "message", at);
      const structural = ["VALIDATION_FAILED", "UNALLOWED_PARENT", "UNALLOWED_CHILD"].includes(String(body.code));
      if (structural) {
        check.only(body, ["code", "surfaceId", "path", "message"], at);
        check.text(body, "surfaceId", at);
        check.text(body, "path", at);
      } else if ((typeof body.surfaceId === "string") === (typeof body.functionCallId === "string")) {
        check.wrong(at, "an error names the surface or the function call it is about, and not both");
      }
    }
    done();
  });
  return faults;
}

/**
 * The catalogs a renderer said it can draw this turn, or nothing if it offered none.
 *
 * `capabilities` is the `a2uiRendererCapabilities` object as it arrived: keyed by A2UI
 * version, so a renderer that speaks only another version has offered nothing here.
 */
export function rendererCatalogs(capabilities: unknown): string[] | undefined {
  if (!isObject(capabilities)) return undefined;
  const ours = capabilities[A2UI_VERSION];
  if (!isObject(ours) || !Array.isArray(ours.supportedCatalogIds)) return undefined;
  const ids = ours.supportedCatalogIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  return ids.length ? ids : undefined;
}

/** A fault as the standard error the specification says a model is shown. */
function faultLine(fault: A2uiFault): string {
  return JSON.stringify({
    error: {
      code: fault.code,
      ...(fault.surfaceId !== undefined ? { surfaceId: fault.surfaceId } : {}),
      path: `/${fault.index}${fault.path}`,
      message: fault.message,
    },
  });
}

/**
 * The tool an agent sends a surface with.
 *
 * It takes the list of messages, checks them, and hands the valid ones to `emit`, which
 * is the transport's: an A2A artifact, an AG-UI event. What was wrong is the tool's
 * result, in the specification's own error form, so the model can send a corrected
 * message; that is the generate-and-validate loop A2UI is designed around, with the
 * validation here and not on the person's screen.
 *
 * `surfaces` is what the renderer is showing, and should be the same set for a whole
 * conversation where the caller can keep one.
 */
export function surfaceTool(options: {
  /** What the renderer said it can draw. */
  catalogs: readonly string[];
  emit: (messages: A2uiMessage[]) => void;
  surfaces?: Set<string>;
}): LocalTool {
  const surfaces = options.surfaces ?? new Set<string>();
  return {
    name: SURFACE_TOOL,
    description:
      "Show the person an interface instead of describing one: a form, a card, a list with buttons. " +
      "Send a list of A2UI 1.0 messages. Each is an object with \"version\": \"1.0\" and exactly one of " +
      "createSurface { surfaceId, catalogId, components?, dataModel? }, updateComponents { surfaceId, components }, " +
      "updateDataModel { surfaceId, path?, value }, deleteSurface { surfaceId }, " +
      "callRendererFunction { functionCallId, callFunction }, agentFunctionResponse { functionCallId, value | error }. " +
      "A component is { id, component, ...properties from the catalog } and refers to its children by id; one " +
      "component must have the id \"root\". Bind a property to the data model with { \"@path\": \"/a/b\" }. Give a " +
      "button an action { event: { name, context } }: when the person presses it, the action comes back to you by that name. " +
      `The catalogs this renderer can draw: ${options.catalogs.join(", ")}. Create a surface before updating it.`,
    parameters: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          description: "The A2UI messages, applied in order.",
          items: { type: "object" },
        },
      },
      required: ["messages"],
    },
    // It changes what the person is looking at and nothing else.
    effect: "read",
    run(args) {
      const messages = args.messages;
      if (!Array.isArray(messages) || !messages.length) {
        return 'Nothing was shown: "messages" must be a list of at least one A2UI message.';
      }
      const faults = validateA2ui(messages, { surfaces, catalogs: options.catalogs });
      const bad = new Set(faults.map((fault) => fault.index));
      const good = messages.filter((_message, index) => !bad.has(index)) as A2uiMessage[];
      if (good.length) options.emit(good);
      if (!faults.length) return `Shown: ${good.length} message${good.length === 1 ? "" : "s"} sent to the renderer.`;
      return [
        good.length
          ? `${good.length} of ${messages.length} messages were sent. The others were not, and need correcting:`
          : "Nothing was shown. Correct these and send the messages again:",
        ...faults.map(faultLine),
      ].join("\n");
    },
  };
}

/**
 * What came back from a surface, as the agent reads it.
 *
 * A person pressing a button is input to the run exactly as a typed sentence is, so it
 * is turned into one: which action, on which surface, with what the form held. The
 * other three kinds are rarer and are passed on as plainly: a function the renderer
 * asks the agent to run, the result of one the agent asked for, and an error.
 *
 * `dataModel` is the `a2uiRendererDataModel` that came with the turn, where a surface
 * was created with `sendDataModel`: what each surface's fields hold now.
 */
export function eventsText(events: readonly A2uiEvent[], dataModel?: unknown): string {
  const lines: string[] = [];
  for (const event of events) {
    if ("action" in event) {
      const { name, surfaceId, sourceComponentId, context, userMessage } = event.action;
      lines.push(
        `The person acted on the surface "${surfaceId}": action "${name}" from the component "${sourceComponentId}"` +
          (userMessage ? ` (${userMessage})` : "") +
          `. Context: ${JSON.stringify(context)}`,
      );
    } else if ("callAgentFunction" in event) {
      const { functionCallId, callFunction, surfaceId } = event.callAgentFunction;
      lines.push(
        `The surface "${surfaceId}" asks you to run the function "${callFunction["@call"]}" with ` +
          `${JSON.stringify(callFunction.args ?? {})}. Answer with an agentFunctionResponse for functionCallId "${functionCallId}".`,
      );
    } else if ("rendererFunctionResponse" in event) {
      const { functionCallId, value, error } = event.rendererFunctionResponse;
      lines.push(
        error
          ? `The renderer function call "${functionCallId}" failed: ${error.code}: ${error.message}`
          : `The renderer function call "${functionCallId}" returned ${JSON.stringify(value ?? null)}`,
      );
    } else {
      const { code, message, surfaceId, path } = event.error;
      lines.push(
        `The renderer reported an error${surfaceId ? ` on the surface "${surfaceId}"` : ""}` +
          `${path ? ` at ${path}` : ""}: ${code}: ${message}`,
      );
    }
  }
  const model = isObject(dataModel) && dataModel.version === A2UI_VERSION && isObject(dataModel.surfaces) ? dataModel.surfaces : undefined;
  if (model && Object.keys(model).length) lines.push(`What the surfaces hold now: ${JSON.stringify(model)}`);
  return lines.join("\n");
}

/**
 * Read what a turn carries of A2UI: the catalogs offered, and what came back.
 *
 * Shared by every transport, so that a turn is read the same way wherever it arrived:
 * `capabilities` and `dataModel` are the two metadata objects, `events` the list of
 * renderer-to-agent messages. Events that do not validate are left out and named in
 * `faults`; the ones that do still count, as the specification asks of a receiver.
 */
export function a2uiTurn(given: { capabilities?: unknown; dataModel?: unknown; events?: unknown }): {
  catalogs?: string[];
  text: string;
  faults: A2uiFault[];
} {
  const catalogs = rendererCatalogs(given.capabilities);
  if (given.events === undefined) return { ...(catalogs ? { catalogs } : {}), text: eventsText([], given.dataModel), faults: [] };
  const faults = validateA2uiEvents(given.events);
  const bad = new Set(faults.map((fault) => fault.index));
  const good = Array.isArray(given.events)
    ? (given.events.filter((_event, index) => !bad.has(index)) as A2uiEvent[])
    : [];
  return { ...(catalogs ? { catalogs } : {}), text: eventsText(good, given.dataModel), faults };
}
