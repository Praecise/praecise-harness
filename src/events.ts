/**
 * Events from outside, in the one envelope everything that sends them already agrees on.
 *
 * A `Source` is a stream this app pulls from. Most of the world pushes instead: a
 * webhook, a queue's HTTP target, another service saying something happened. Those
 * arrive one at a time with no cursor, and what makes them safe to act on is the same
 * thing that makes a source safe — an event that is delivered twice must find the run
 * the first delivery started.
 *
 * CloudEvents is the envelope because it carries exactly the two fields that takes:
 * where an event came from and its id there. `source` + `id` is unique by the
 * specification's own rule, so the pair names the run, and a sender that retries
 * cannot start a second one.
 */

/** A CloudEvents 1.0 event. Required: `specversion`, `id`, `source`, `type`. */
export interface CloudEvent {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  subject?: string;
  /** RFC 3339. */
  time?: string;
  datacontenttype?: string;
  dataschema?: string;
  data?: unknown;
  /** The payload when it is bytes rather than JSON. */
  data_base64?: string;
  /** Extension attributes, which the specification allows any sender to add. */
  [extension: string]: unknown;
}

export const CLOUDEVENTS_JSON = "application/cloudevents+json";
export const CLOUDEVENTS_BATCH = "application/cloudevents-batch+json";

/** The most events one request may deliver. A larger batch is a stream, and a `Source` is for those. */
const MOST = 100;

const REQUIRED = ["id", "source", "type"] as const;

/** What is wrong with something offered as an event, or nothing. */
function faultIn(event: Record<string, unknown>): string | undefined {
  if (event.specversion !== "1.0") {
    return `specversion must be "1.0"; got ${JSON.stringify(event.specversion ?? null)}`;
  }
  for (const key of REQUIRED) {
    if (typeof event[key] !== "string" || !event[key]) return `\`${key}\` is required and must be a non-empty string`;
  }
  return undefined;
}

/**
 * Read the events a request carries, in any of the three ways the HTTP binding allows.
 *
 *   structured — the whole event as JSON, `application/cloudevents+json`
 *   batched    — an array of them, `application/cloudevents-batch+json`
 *   binary     — the attributes as `ce-*` headers and the body as the data
 *
 * Returns the events, or a sentence saying why the request is not one. Nothing is
 * guessed: a body that merely looks like an event, sent as plain JSON with no `ce-`
 * headers, is refused, because an id invented here would not survive a retry and a
 * retry would then start a second run.
 */
export function readCloudEvents(
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
): CloudEvent[] | string {
  const header = (name: string): string | undefined => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const type = (header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();

  let offered: unknown[];
  if (type === CLOUDEVENTS_BATCH) {
    if (!Array.isArray(body)) return "a batch must be a JSON array of events";
    offered = body;
  } else if (type === CLOUDEVENTS_JSON) {
    offered = [body];
  } else if (header("ce-specversion")) {
    const attributes: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (!name.toLowerCase().startsWith("ce-")) continue;
      const said = Array.isArray(value) ? value[0] : value;
      // Header values are percent-encoded where they would not otherwise survive a header.
      if (said !== undefined) attributes[name.slice(3).toLowerCase()] = safeDecode(said);
    }
    offered = [{ ...attributes, ...(type ? { datacontenttype: type } : {}), data: body }];
  } else {
    return (
      `not a CloudEvent: send ${CLOUDEVENTS_JSON}, ${CLOUDEVENTS_BATCH}, or ce-specversion, ce-id, ` +
      `ce-source and ce-type headers with the data as the body`
    );
  }

  if (!offered.length) return "the batch is empty";
  if (offered.length > MOST) return `a request may deliver ${MOST} events; this one carries ${offered.length}`;

  const events: CloudEvent[] = [];
  for (const [at, entry] of offered.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return `event ${at + 1} is not an object`;
    }
    const fault = faultIn(entry as Record<string, unknown>);
    if (fault) return offered.length > 1 ? `event ${at + 1}: ${fault}` : fault;
    events.push(entry as CloudEvent);
  }
  return events;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** An event of this app's own, for something it reports to somebody else. */
export function cloudEvent(
  type: string,
  source: string,
  data: unknown,
  rest: { id?: string; subject?: string; time?: string } = {},
): CloudEvent {
  return {
    specversion: "1.0",
    id: rest.id ?? globalThis.crypto.randomUUID(),
    source,
    type,
    time: rest.time ?? new Date().toISOString(),
    ...(rest.subject ? { subject: rest.subject } : {}),
    datacontenttype: "application/json",
    data,
  };
}
