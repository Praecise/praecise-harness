/**
 * The app's events, described for a machine that wants to send or receive them.
 *
 * The other discovery documents say what an app can be asked to do. This one says what
 * it can be told, and what it tells: the CloudEvents its workflows subscribe to and
 * wait for, where to post them, and the run events it reports when it has somewhere to
 * report them. AsyncAPI is the format because it is to events what OpenAPI is to
 * requests, and tooling that reads one already exists.
 *
 * Generated, like the rest, from what the app declares: a workflow's `on`, its `wait`
 * steps, and whether `notify` is configured. An event type nobody declared is not
 * listed, and the reporting side is left out of an app that reports nothing. Filtered
 * by the same access rules as the tool list, so a workflow a caller could not reach
 * does not have its events advertised to them either.
 *
 * Written against AsyncAPI 3.1.0, whose fixed fields were read from the published
 * specification: `asyncapi`, `info`, `defaultContentType`, `servers` (`host`,
 * `protocol`, `security`), `channels` (`address`, which may be null for an address
 * that is not known; `parameters`; `messages`), `operations` (`action` of `send` or
 * `receive`, `channel` and `messages` as references) and `components`. The payload
 * schemas are JSON Schema, which the specification takes by default. The document
 * was not run through an AsyncAPI validator.
 */

import { subscriptionsOf, type App } from "../app.js";
import { isWait, type WorkflowSpec } from "../define.js";
import { CLOUDEVENTS_BATCH, CLOUDEVENTS_JSON } from "../events.js";
import { RUN_EVENT_TYPES } from "../notify.js";
import { walkSteps } from "../workflow/defects.js";
import { publishedOf, type Caller } from "./mcp.js";

/** Where the description is served. */
export const ASYNCAPI_PATH = "/asyncapi.json";

/** The version of the specification the document is written in. */
export const ASYNCAPI_VERSION = "3.1.0";

/** The event types a workflow waits for part-way through, with the step that waits. */
function waitsOf(spec: WorkflowSpec): { type: string; step: string }[] {
  const found: { type: string; step: string }[] = [];
  walkSteps(spec.steps, (step) => {
    if (isWait(step) && typeof step.wait === "string" && step.wait) found.push({ type: step.wait, step: step.id });
  });
  return found;
}

/** A key the specification allows in `components`, for an event type that may hold anything. */
function keyFor(type: string, taken: Set<string>): string {
  const base = type.replace(/[^a-zA-Z0-9.\-_]/g, "_") || "event";
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  taken.add(key);
  return key;
}

const CLOUD_EVENT_SCHEMA = {
  type: "object",
  description: "A CloudEvents 1.0 event. `source` and `id` together name it: delivered twice, it does its work once.",
  required: ["specversion", "id", "source", "type"],
  properties: {
    specversion: { type: "string", const: "1.0" },
    id: { type: "string", minLength: 1 },
    source: { type: "string", minLength: 1, format: "uri-reference" },
    type: { type: "string", minLength: 1 },
    subject: { type: "string" },
    time: { type: "string", format: "date-time" },
    datacontenttype: { type: "string" },
    dataschema: { type: "string", format: "uri" },
    data: {},
    data_base64: { type: "string" },
  },
};

const RUN_NOTICE_SCHEMA = {
  type: "object",
  description: "Which run, and what it has come to. Never what the run produced.",
  required: ["run", "workflow", "status"],
  properties: {
    run: { type: "string" },
    workflow: { type: "string" },
    status: { type: "string", enum: ["running", "waiting", "done", "failed", "cancelled"] },
    step: {
      type: "object",
      description: "The gate or the wait a waiting run stopped at.",
      required: ["id", "prompt"],
      properties: { id: { type: "string" }, prompt: { type: "string" } },
    },
    outcome: {
      type: "object",
      description: "Whether the workflow's declared outcome held.",
      required: ["held"],
      properties: { held: { type: "boolean" } },
    },
  },
};

/** An event of one type: the envelope, with `type` fixed and `data` as given. */
const typed = (type: string, data?: Record<string, unknown>): Record<string, unknown> => ({
  allOf: [
    { $ref: "#/components/schemas/CloudEvent" },
    { type: "object", properties: { type: { const: type }, ...(data ? { data } : {}) } },
  ],
});

/**
 * The AsyncAPI description of what this app receives and sends.
 *
 * Three channels, each present only when there is something on it:
 *
 *   `bus`       `POST /api/events` — an event for whoever subscribed or is waiting
 *   `workflow`  `POST /api/events/{workflow}` — an event for one workflow by name
 *   `runs`      the run events this app reports, when `notify` is configured
 *
 * The address of `runs` is null. It is wherever the app was configured to report to,
 * which is the operator's to know and not something to print in a public document.
 */
export function asyncApi(app: App, caller: Caller = {}, baseUrl = ""): Record<string, unknown> {
  const reachable = new Set(publishedOf(app, caller).map(({ tool }) => tool.name));
  const workflows = app.workflowNames.filter((name) => reachable.has(name));

  // What each event type does here, gathered across the workflows this caller can reach.
  const does = new Map<string, string[]>();
  const note = (type: string, what: string): void => void does.set(type, [...(does.get(type) ?? []), what]);
  for (const name of workflows) {
    const spec = app.project.workflows[name]!;
    for (const type of subscriptionsOf(spec)) note(type, `starts a run of "${name}"`);
    for (const { type, step } of waitsOf(spec)) note(type, `continues a run of "${name}" waiting at step "${step}"`);
  }

  const taken = new Set<string>();
  const messages: Record<string, unknown> = {};
  const onBus: Record<string, unknown> = {};
  for (const [type, effects] of does) {
    const key = keyFor(type, taken);
    messages[key] = {
      name: type,
      title: type,
      summary: `Received. It ${effects.join("; ")}.`,
      contentType: CLOUDEVENTS_JSON,
      payload: typed(type),
    };
    onBus[key] = { $ref: `#/components/messages/${key}` };
  }

  const channels: Record<string, unknown> = {};
  const operations: Record<string, unknown> = {};

  if (does.size) {
    channels.bus = {
      address: "/api/events",
      title: "The app's event bus",
      description:
        `POST a CloudEvent as ${CLOUDEVENTS_JSON}, several as ${CLOUDEVENTS_BATCH}, or one in binary mode with ce-* headers. ` +
        `Every workflow subscribed to its type starts a run, and every run waiting for it continues. ` +
        `An event of a type not listed here is accepted and goes nowhere.`,
      messages: onBus,
    };
    operations.publishEvent = {
      action: "receive",
      channel: { $ref: "#/channels/bus" },
      summary: "Put an event on the bus.",
      messages: Object.keys(onBus).map((key) => ({ $ref: `#/channels/bus/messages/${key}` })),
    };
  }

  if (workflows.length) {
    const any = keyFor("event", taken);
    messages[any] = {
      name: "event",
      title: "Any CloudEvent",
      summary:
        "Received. It continues the run of the named workflow that is waiting for it, or, when none is, starts a run of that workflow with the event as its input.",
      contentType: CLOUDEVENTS_JSON,
      payload: { $ref: "#/components/schemas/CloudEvent" },
    };
    channels.workflow = {
      address: "/api/events/{workflow}",
      title: "One workflow, by name",
      description: "POST a CloudEvent, in any of the three ways the bus takes one, to the workflow named in the address.",
      parameters: { workflow: { enum: workflows, description: "The workflow the event is for." } },
      messages: { [any]: { $ref: `#/components/messages/${any}` } },
    };
    operations.deliverEvent = {
      action: "receive",
      channel: { $ref: "#/channels/workflow" },
      summary: "Hand an event to one workflow.",
      messages: [{ $ref: `#/channels/workflow/messages/${any}` }],
    };
  }

  if (app.notifies) {
    const reported: Record<string, unknown> = {};
    for (const [kind, type] of Object.entries(RUN_EVENT_TYPES)) {
      const key = keyFor(type, taken);
      messages[key] = {
        name: type,
        title: `A run ${kind === "started" ? "started" : kind === "waiting" ? "is waiting" : kind === "done" ? "finished" : kind === "failed" ? "failed" : "was cancelled"}`,
        summary: "Sent. The event's `subject` is the run's id.",
        contentType: "application/json",
        payload: typed(type, { $ref: "#/components/schemas/RunNotice" }),
      };
      reported[key] = { $ref: `#/components/messages/${key}` };
    }
    channels.runs = {
      address: null,
      title: "What runs do",
      description:
        "Each change of a run's status, sent to where this app was configured to report: a function, or a webhook signed as Standard Webhooks. " +
        "The address is the operator's and is not published here.",
      messages: reported,
    };
    operations.reportRun = {
      action: "send",
      channel: { $ref: "#/channels/runs" },
      summary: "Report a change of a run's status.",
      messages: Object.keys(reported).map((key) => ({ $ref: `#/channels/runs/messages/${key}` })),
    };
  }

  let server: Record<string, unknown> | undefined;
  try {
    const at = new URL(baseUrl);
    server = {
      host: at.host,
      protocol: at.protocol.replace(/:$/, ""),
      ...(at.pathname && at.pathname !== "/" ? { pathname: at.pathname } : {}),
      description: "Events are received here. Every request needs the server's bearer token.",
      security: [{ $ref: "#/components/securitySchemes/bearer" }],
    };
  } catch {
    // No address to give: the caller did not say where this is served.
  }

  return {
    asyncapi: ASYNCAPI_VERSION,
    info: {
      title: app.name,
      version: app.version,
      description: `The events ${app.name} receives and sends, as CloudEvents 1.0. Generated from the app; nothing here is written by hand.`,
    },
    defaultContentType: CLOUDEVENTS_JSON,
    ...(server ? { servers: { app: server } } : {}),
    channels,
    operations,
    components: {
      messages,
      schemas: {
        CloudEvent: CLOUD_EVENT_SCHEMA,
        ...(app.notifies ? { RunNotice: RUN_NOTICE_SCHEMA } : {}),
      },
      ...(server ? { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } } : {}),
    },
  };
}
