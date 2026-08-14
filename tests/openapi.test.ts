/**
 * An OpenAPI description turned into callable tools.
 *
 * The failure mode worth testing for is silence: a document that yields fewer tools than
 * it describes, a name collision that makes one endpoint unreachable, a path parameter
 * that never gets substituted. None of these throw. The agent simply never learns the
 * endpoint exists, or calls a URL with a literal `{id}` in it, and nothing says so.
 */
import { describe, expect, test } from "vitest";

import { ApiClient, collectResources, collectTools } from "../src/harness/mcp.js";
import {
  baseUrlOf,
  callOperation,
  operationName,
  operationsFrom,
  requestFor,
  resolveRefs,
  toolsFrom,
} from "../src/harness/openapi.js";

const PETS = {
  openapi: "3.1.0",
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        summary: "Fetch one pet",
        parameters: [
          { name: "petId", in: "path", required: true, schema: { type: "string" } },
          { name: "verbose", in: "query", schema: { type: "boolean" } },
          { name: "X-Trace", in: "header", schema: { type: "string" } },
        ],
      },
      delete: { operationId: "deletePet", parameters: [{ name: "petId", in: "path", schema: { type: "string" } }] },
    },
    "/pets": {
      post: {
        operationId: "createPet",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" }, tag: { type: "string" } },
                required: ["name"],
              },
            },
          },
        },
      },
    },
  },
};

describe("reading a document into operations", () => {
  test("every method under every path becomes a tool", () => {
    const { operations } = operationsFrom(PETS);
    expect(operations.map((op) => op.name).sort()).toEqual(["createPet", "deletePet", "getPet"]);
  });

  test("parameters are flattened into one object, with their location remembered", () => {
    // The model produces a single JSON object; HTTP wants these in three different
    // places. Making the model understand that split is the thing being avoided.
    const { operations } = operationsFrom(PETS);
    const get = operations.find((op) => op.name === "getPet");
    expect(Object.keys((get!.parameters as { properties: object }).properties).sort()).toEqual([
      "X-Trace",
      "petId",
      "verbose",
    ]);
    expect(get?.places).toEqual({ petId: "path", verbose: "query", "X-Trace": "header" });
  });

  test("a body is flattened into the same object rather than nested under `body`", () => {
    // A nested body would ask the model to know which of its own arguments are transport
    // and which are content.
    const { operations } = operationsFrom(PETS);
    const post = operations.find((op) => op.name === "createPet");
    const schema = post?.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(["name", "tag"]);
    expect(schema.required).toContain("name");
  });

  test("a path parameter is required even when the document forgot to say so", () => {
    // The URL cannot be built without it, whatever the document claims.
    const { operations } = operationsFrom(PETS);
    const del = operations.find((op) => op.name === "deletePet");
    expect((del!.parameters as { required: string[] }).required).toContain("petId");
  });

  test("the schema forbids fields the endpoint does not have", () => {
    // Otherwise a model inventing a plausible extra field gets a 400 from the API
    // instead of a correction here.
    const { operations } = operationsFrom(PETS);
    expect((operations[0]!.parameters as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });

  test("a deprecated operation is left out, and the omission is reported", () => {
    const { operations, notes } = operationsFrom({
      openapi: "3.1.0",
      servers: [{ url: "https://api.example.com" }],
      paths: { "/old": { get: { operationId: "old", deprecated: true } } },
    });
    expect(operations).toHaveLength(0);
    expect(notes.join(" ")).toContain("deprecated");
  });

  test("a document with no paths says so instead of yielding nothing quietly", () => {
    const { operations, notes } = operationsFrom({ openapi: "3.1.0" });
    expect(operations).toHaveLength(0);
    expect(notes.join(" ")).toContain("no `paths`");
  });

  test("a document naming no server is flagged rather than producing unusable tools", () => {
    const { notes } = operationsFrom({ openapi: "3.1.0", paths: { "/x": { get: {} } } });
    expect(notes.join(" ")).toContain("names no server");
  });
});

describe("names", () => {
  test("operationId is used, because it matches the API's own documentation", () => {
    expect(operationName("get", "/pets/{petId}", "getPet")).toBe("getPet");
  });

  test("without one, the name is derived and stable", () => {
    // Stability is the point: a name that shifts between runs invalidates every prompt
    // cache and every logged trace that mentioned it.
    const first = operationName("get", "/pets/{petId}");
    expect(first).toBe(operationName("get", "/pets/{petId}"));
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("a duplicate name is resolved and reported, not allowed", () => {
    // Two tools with one name means the model picks one and the other is unreachable
    // with no error anywhere. `operationId` is optional and duplicated in practice.
    const { operations, notes } = operationsFrom({
      openapi: "3.1.0",
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/a": { get: { operationId: "same" } },
        "/b": { get: { operationId: "same" } },
      },
    });
    expect(operations.map((op) => op.name)).toEqual(["same", "same_2"]);
    expect(notes.join(" ")).toContain("both named");
  });
});

describe("$ref", () => {
  test("a local reference is resolved into the schema the model sees", () => {
    const doc = {
      openapi: "3.1.0",
      servers: [{ url: "https://api.example.com" }],
      components: { schemas: { Pet: { type: "object", properties: { name: { type: "string" } } } } },
      paths: {
        "/pets": {
          post: {
            operationId: "createPet",
            requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } },
          },
        },
      },
    };
    const { operations } = operationsFrom(doc);
    expect(Object.keys((operations[0]!.parameters as { properties: object }).properties)).toEqual(["name"]);
  });

  test("a remote reference is not fetched", () => {
    // A `$ref` to a network URI is a request made on someone else's behalf to a host the
    // document chose — the same class of problem MCP's own schema rules forbid by default.
    const resolved = resolveRefs({ $ref: "https://evil.example.com/schema.json" }, {}) as {
      description: string;
    };
    expect(resolved.description).toContain("external reference");
  });

  test("a reference cycle terminates instead of hanging at load time", () => {
    // Ordinary in real documents: a Node whose children are Nodes.
    const doc = {
      components: { schemas: { Node: { type: "object", properties: { child: { $ref: "#/components/schemas/Node" } } } } },
    };
    expect(() => resolveRefs({ $ref: "#/components/schemas/Node" }, doc)).not.toThrow();
  });

  test("a reference that points at nothing says so rather than vanishing", () => {
    const resolved = resolveRefs({ $ref: "#/components/schemas/Missing" }, { components: { schemas: {} } }) as {
      description: string;
    };
    expect(resolved.description).toContain("unresolved");
  });
});

describe("Swagger 2 documents, which is most of what exists", () => {
  test("host, basePath and scheme become a base URL", () => {
    expect(baseUrlOf({ host: "api.example.com", basePath: "/v2", schemes: ["https"] })).toBe(
      "https://api.example.com/v2",
    );
  });

  test("a parameter typed beside itself rather than in a schema still works", () => {
    const { operations } = operationsFrom({
      swagger: "2.0",
      host: "api.example.com",
      paths: { "/x": { get: { operationId: "x", parameters: [{ name: "n", in: "query", type: "integer" }] } } },
    });
    expect((operations[0]!.parameters as { properties: { n: { type: string } } }).properties.n.type).toBe("integer");
  });
});

describe("building the request from what the model produced", () => {
  const { operations } = operationsFrom(PETS);
  const get = operations.find((op) => op.name === "getPet")!;
  const post = operations.find((op) => op.name === "createPet")!;

  test("each value goes where the document said it goes", () => {
    const { url, init } = requestFor(get, { petId: "p1", verbose: true, "X-Trace": "abc" });
    expect(url).toBe("https://api.example.com/v1/pets/p1?verbose=true");
    expect((init.headers as Record<string, string>)["x-trace"]).toBe("abc");
  });

  test("a path parameter is encoded, so a slash cannot address another resource", () => {
    const { url } = requestFor(get, { petId: "a/b" });
    expect(url).toBe("https://api.example.com/v1/pets/a%2Fb");
  });

  test("an unfilled placeholder is refused rather than sent literally", () => {
    // Otherwise the request goes to a path containing `{petId}`, which is a 404 whose
    // cause is invisible from the response.
    expect(() => requestFor(get, {})).toThrow("petId");
  });

  test("body fields become a JSON body, and nothing else does", () => {
    const { url, init } = requestFor(post, { name: "Rex", tag: "dog" });
    expect(url).toBe("https://api.example.com/v1/pets");
    expect(JSON.parse(String(init.body))).toEqual({ name: "Rex", tag: "dog" });
    expect((init.headers as Record<string, string>)["content-type"]).toContain("json");
  });

  test("a repeated query parameter is repeated, not overwritten", () => {
    const { operations: ops } = operationsFrom({
      openapi: "3.1.0",
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/search": {
          get: {
            operationId: "search",
            parameters: [{ name: "tag", in: "query", schema: { type: "array", items: { type: "string" } } }],
          },
        },
      },
    });
    const { url } = requestFor(ops[0]!, { tag: ["a", "b"] });
    expect(url).toBe("https://api.example.com/search?tag=a&tag=b");
  });

  test("a GET does not grow a body", () => {
    const { init } = requestFor(get, { petId: "p1" });
    expect(init.body).toBeUndefined();
  });
});

describe("calling one", () => {
  const { operations } = operationsFrom(PETS);
  const get = operations.find((op) => op.name === "getPet")!;

  test("a successful call returns what the API said", async () => {
    const fetchImpl = (async () => new Response('{"id":"p1"}', { status: 200 })) as unknown as typeof fetch;
    const result = await callOperation(get, { petId: "p1" }, { fetch: fetchImpl });
    expect(result.isError).toBe(false);
    expect(result.text).toBe('{"id":"p1"}');
  });

  test("an error status comes back as readable text, not as a thrown exception", async () => {
    // An API saying "that id does not exist" is something the model can act on. Throwing
    // ends the turn on something it could have corrected — the same distinction MCP draws
    // between a protocol error and a tool execution error.
    const fetchImpl = (async () => new Response("no such pet", { status: 404 })) as unknown as typeof fetch;
    const result = await callOperation(get, { petId: "nope" }, { fetch: fetchImpl });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("404");
    expect(result.text).toContain("no such pet");
  });

  test("caller headers are merged in, which is how a credential is presented", async () => {
    let seen: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await callOperation(get, { petId: "p1" }, { fetch: fetchImpl, headers: { authorization: "Bearer t" } });
    expect(seen.authorization).toBe("Bearer t");
  });
});

describe("as tool schemas", () => {
  test("what a model is handed is name, description and the flat schema", () => {
    const { operations } = operationsFrom(PETS);
    const tools = toolsFrom(operations);
    expect(tools.every((tool) => tool.name && tool.description && tool.parameters)).toBe(true);
    expect(tools.find((tool) => tool.name === "getPet")?.description).toContain("Fetch one pet");
  });
});

describe("declared as a service, which is what makes any of this reachable", () => {
  const service = {
    name: "petstore",
    openapi: PETS,
    credential: "PETSTORE_API_KEY",
    auth: "bearer" as const,
    apiKey: "k",
  };

  test("collectTools offers an OpenAPI service's operations like any other tools", async () => {
    // The check that matters: an author writes `tool({ openapi })` and the agent's tool
    // list grows. Without this the module is a library nobody in the framework calls.
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const { schemas, clients, notes } = await collectTools([service as never], fetchImpl);

    expect(schemas.map((s) => s.name).sort()).toEqual([
      "petstore__createPet",
      "petstore__deletePet",
      "petstore__getPet",
    ]);
    expect(clients.get("petstore")).toBeInstanceOf(ApiClient);
    expect(notes.filter((n) => n.includes("unavailable"))).toEqual([]);
  });

  test("calling one reaches the API, with the service's credential attached", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), headers: init.headers as Record<string, string> };
      return new Response('{"id":"p1"}', { status: 200 });
    }) as unknown as typeof fetch;

    const client = new ApiClient(service as never, fetchImpl);
    await client.listTools();
    const text = await client.call("getPet", { petId: "p1" });

    expect(text).toBe('{"id":"p1"}');
    expect(seen?.url).toBe("https://api.example.com/v1/pets/p1");
    expect(seen?.headers.authorization).toBe("Bearer k");
  });

  test("a document fetched from a URL works the same as one written inline", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith("/openapi.json")) {
        return new Response(JSON.stringify(PETS), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const remote = { ...service, openapi: "https://api.example.com/openapi.json" };
    const tools = await new ApiClient(remote as never, fetchImpl).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["createPet", "deletePet", "getPet"]);
  });

  test("a description that will not load fails the service, not the request", async () => {
    // Same rule the MCP path follows: losing one integration must not take the agent down.
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const remote = { ...service, openapi: "https://api.example.com/openapi.json" };
    const { schemas, notes } = await collectTools([remote as never], fetchImpl);

    expect(schemas).toEqual([]);
    expect(notes.join(" ")).toContain("unavailable");
  });

  test("a public API with no credential is still reachable", async () => {
    // A missing credential is a fault for an MCP endpoint and an ordinary fact for a
    // public HTTP API, so it must not be skipped the way an unconfigured service is.
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const open = { ...service, apiKey: undefined };
    const { schemas } = await collectTools([open as never], fetchImpl);
    expect(schemas.length).toBeGreaterThan(0);
  });

  test("resources are declined in words rather than attached as nothing", async () => {
    // An OpenAPI document publishes no resources. Silence here would leave a prompt that
    // was written expecting context with none, and no explanation anywhere.
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const withResources = { ...service, resources: ["*"] };
    const { clients } = await collectTools([withResources as never], fetchImpl);
    const attached = await collectResources([withResources as never], clients);

    expect(attached.text).toBe("");
    expect(attached.notes.join(" ")).toContain("publishes no resources");
  });
});
