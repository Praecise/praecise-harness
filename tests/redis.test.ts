/**
 * The Redis and Valkey backend, against a server written here.
 *
 * No Redis is assumed to be running, so the other end of the socket is a small one
 * that lives in this file: it speaks RESP2 and RESP3 over a real TCP connection and
 * implements the commands the driver sends, as the Redis documentation describes them
 * — the plain ones, and vector sets, time series and JSON, each of which can be
 * switched off to stand for a server that does not have it.
 *
 * That is worth being plain about. What is proven here is that the client frames and
 * reads the protocol correctly over a socket, and that the driver keeps every promise
 * a store makes against a server that behaves as documented. Whether a real Redis 8
 * agrees with this file's reading of its documentation is not proven here.
 */
import { createServer, type Server as NetServer, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { conform, conformanceReport } from "../src/stores/conform.js";
import { openStore } from "../src/stores/index.js";
import { redisDriver } from "../src/stores/redis.js";
import { encodeCommand, pairsOf, readReply, Resp, RespError, respOptionsFrom } from "../src/stores/resp.js";

// ── A server that behaves as documented ────────────────────────────────────

type Out =
  | { t: "ok"; s?: string }
  | { t: "err"; m: string }
  | { t: "int"; n: number }
  | { t: "bulk"; s: string }
  | { t: "null" }
  | { t: "arr"; items: Out[] }
  | { t: "map"; pairs: [Out, Out][] }
  | { t: "dbl"; n: number }
  | { t: "bool"; b: boolean };

type Kept =
  | { type: "hash"; fields: Map<string, string> }
  | { type: "zset"; members: Map<string, number> }
  | { type: "vset"; dim: number; items: Map<string, number[]> }
  | { type: "ts"; samples: Map<number, number> }
  | { type: "json"; doc: string };

interface Shape {
  /** Answers `HELLO`, and so speaks RESP3. Off: a server from before it. */
  hello?: boolean;
  vectors?: boolean;
  series?: boolean;
  json?: boolean;
  password?: string;
}

const ok: Out = { t: "ok" };
const int = (n: number): Out => ({ t: "int", n });
const bulk = (s: string): Out => ({ t: "bulk", s });
const err = (m: string): Out => ({ t: "err", m });

function encode(out: Out, proto: 2 | 3): string {
  switch (out.t) {
    case "ok":
      return `+${out.s ?? "OK"}\r\n`;
    case "err":
      return `-${out.m}\r\n`;
    case "int":
      return `:${out.n}\r\n`;
    case "bulk":
      return `$${Buffer.byteLength(out.s)}\r\n${out.s}\r\n`;
    case "null":
      return proto === 3 ? "_\r\n" : "$-1\r\n";
    case "arr":
      return `*${out.items.length}\r\n${out.items.map((item) => encode(item, proto)).join("")}`;
    case "map":
      return (
        (proto === 3 ? `%${out.pairs.length}\r\n` : `*${out.pairs.length * 2}\r\n`) +
        out.pairs.map(([key, value]) => encode(key, proto) + encode(value, proto)).join("")
      );
    case "dbl":
      return proto === 3 ? `,${out.n}\r\n` : encode(bulk(String(out.n)), 2);
    case "bool":
      return proto === 3 ? `#${out.b ? "t" : "f"}\r\n` : `:${out.b ? 1 : 0}\r\n`;
  }
}

const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    left += a[i]! * a[i]!;
    right += b[i]! * b[i]!;
  }
  return (dot / Math.sqrt(left * right) + 1) / 2;
};

const AGGREGATE: Record<string, (values: number[]) => number> = {
  avg: (values) => values.reduce((a, b) => a + b, 0) / values.length,
  sum: (values) => values.reduce((a, b) => a + b, 0),
  min: (values) => Math.min(...values),
  max: (values) => Math.max(...values),
  count: (values) => values.length,
  first: (values) => values[0]!,
  last: (values) => values.at(-1)!,
};

interface Fake {
  url: string;
  port: number;
  /** Every command received, in order, as its words. */
  seen: string[][];
  keys: Map<string, Kept>;
  /** The names of the commands received, without repeats. */
  used(): Set<string>;
  close(): Promise<void>;
}

async function fakeRedis(shape: Shape = {}): Promise<Fake> {
  const can = { hello: true, vectors: true, series: true, json: true, ...shape };
  const keys = new Map<string, Kept>();
  const seen: string[][] = [];
  const sockets = new Set<Socket>();

  const known = new Map<string, string[]>([
    ["HSET", ["write"]],
    ["HGETALL", ["readonly"]],
    ["DEL", ["write"]],
  ]);
  for (const name of can.vectors ? ["VADD", "VSIM", "VREM"] : []) known.set(name, ["write"]);
  for (const name of can.series ? ["TS.ADD", "TS.RANGE", "TS.DEL"] : []) known.set(name, ["write"]);
  for (const name of can.json ? ["JSON.SET", "JSON.GET"] : []) known.set(name, ["write"]);

  const of = <T extends Kept["type"]>(key: string, type: T, make?: () => Extract<Kept, { type: T }>) => {
    const held = keys.get(key);
    if (held) return held.type === type ? (held as Extract<Kept, { type: T }>) : undefined;
    if (!make) return undefined;
    const made = make();
    keys.set(key, made);
    return made;
  };
  const bound = (text: string, fallback: number): { value: number; open: boolean } => {
    if (text === "-inf" || text === "-") return { value: -Infinity, open: false };
    if (text === "+inf" || text === "+") return { value: Infinity, open: false };
    if (text.startsWith("(")) return { value: Number(text.slice(1)), open: true };
    const value = Number(text);
    return { value: Number.isNaN(value) ? fallback : value, open: false };
  };

  const run = (words: string[], state: { proto: 2 | 3; authed: boolean }): Out => {
    const [name = "", ...args] = words;
    const command = name.toUpperCase();
    const module = command.startsWith("V") && command.length <= 5 && ["VADD", "VSIM", "VREM", "VDIM"].includes(command)
      ? can.vectors
      : command.startsWith("TS.")
        ? can.series
        : command.startsWith("JSON.")
          ? can.json
          : true;
    if (!module) return err(`ERR unknown command '${name}'`);

    switch (command) {
      case "HELLO": {
        if (!can.hello) return err("ERR unknown command 'HELLO'");
        const auth = args.indexOf("AUTH");
        if (auth >= 0) {
          if (args[auth + 2] !== can.password) return err("WRONGPASS invalid username-password pair or user is disabled.");
          state.authed = true;
        } else if (can.password && !state.authed) {
          return err("NOAUTH HELLO must be called with the client already authenticated");
        }
        state.proto = 3;
        return {
          t: "map",
          pairs: [
            [bulk("server"), bulk("redis")],
            [bulk("version"), bulk("8.2.0")],
            [bulk("proto"), int(3)],
            [bulk("modules"), { t: "arr", items: [] }],
          ],
        };
      }
      case "AUTH":
        if (args.at(-1) !== can.password) return err("WRONGPASS invalid username-password pair or user is disabled.");
        state.authed = true;
        return ok;
      case "SELECT":
      case "PING":
        return ok;
      case "COMMAND":
        return {
          t: "arr",
          items: args.slice(1).map((asked) => {
            const flags = known.get(asked.toUpperCase());
            return flags
              ? { t: "arr", items: [bulk(asked.toLowerCase()), int(-2), { t: "arr", items: flags.map(bulk) }] }
              : { t: "null" };
          }),
        };
      case "DEL":
        return int(args.filter((key) => keys.delete(key)).length);
      case "HSET": {
        const hash = of(args[0]!, "hash", () => ({ type: "hash", fields: new Map() }))!;
        let added = 0;
        for (let i = 1; i + 1 < args.length; i += 2) {
          if (!hash.fields.has(args[i]!)) added++;
          hash.fields.set(args[i]!, args[i + 1]!);
        }
        return int(added);
      }
      case "HDEL": {
        const hash = of(args[0]!, "hash");
        return int(args.slice(1).filter((field) => hash?.fields.delete(field)).length);
      }
      case "HGETALL":
        return { t: "map", pairs: [...(of(args[0]!, "hash")?.fields ?? [])].map(([key, value]) => [bulk(key), bulk(value)]) };
      case "ZADD": {
        const zset = of(args[0]!, "zset", () => ({ type: "zset", members: new Map() }))!;
        const fresh = !zset.members.has(args[2]!);
        zset.members.set(args[2]!, Number(args[1]));
        return int(fresh ? 1 : 0);
      }
      case "ZREM": {
        const zset = of(args[0]!, "zset");
        const went = zset?.members.delete(args[1]!) ? 1 : 0;
        if (zset && !zset.members.size) keys.delete(args[0]!);
        return int(went);
      }
      case "ZCOUNT": {
        const low = bound(args[1]!, 0);
        const high = bound(args[2]!, 0);
        const scores = [...(of(args[0]!, "zset")?.members.values() ?? [])];
        return int(
          scores.filter(
            (score) => (low.open ? score > low.value : score >= low.value) && (high.open ? score < high.value : score <= high.value),
          ).length,
        );
      }
      case "ZRANGE": {
        // Only the form the driver uses: `key max min BYSCORE REV [LIMIT offset count]`.
        if (args[3] !== "BYSCORE" || args[4] !== "REV") return err("ERR syntax error");
        const high = bound(args[1]!, 0).value;
        const low = bound(args[2]!, 0).value;
        let found = [...(of(args[0]!, "zset")?.members ?? [])]
          .filter(([, score]) => score >= low && score <= high)
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))
          .map(([member]) => member);
        if (args[5] === "LIMIT") {
          const offset = Number(args[6]);
          const count = Number(args[7]);
          found = count < 0 ? found.slice(offset) : found.slice(offset, offset + count);
        }
        return { t: "arr", items: found.map(bulk) };
      }
      case "VADD": {
        // `key VALUES n v1..vn element [NOQUANT]`
        const count = Number(args[2]);
        const vector = args.slice(3, 3 + count).map(Number);
        const element = args[3 + count]!;
        const set = of(args[0]!, "vset", () => ({ type: "vset", dim: count, items: new Map() }))!;
        if (set.dim !== count) return err(`ERR Vector dimension mismatch - got ${count} but set has ${set.dim}`);
        const fresh = !set.items.has(element);
        set.items.set(element, vector);
        return { t: "bool", b: fresh };
      }
      case "VREM": {
        const set = of(args[0]!, "vset");
        const went = set?.items.delete(args[1]!) ?? false;
        if (set && !set.items.size) keys.delete(args[0]!);
        return { t: "bool", b: went };
      }
      case "VDIM": {
        const set = of(args[0]!, "vset");
        return set ? int(set.dim) : err("ERR key does not exist");
      }
      case "VSIM": {
        const count = Number(args[2]);
        const vector = args.slice(3, 3 + count).map(Number);
        const limit = Number(args[args.indexOf("COUNT") + 1]);
        const scored = [...(of(args[0]!, "vset")?.items ?? [])]
          .map(([element, held]) => [element, cosine(vector, held)] as const)
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit);
        if (!scored.length) return { t: "arr", items: [] };
        return { t: "map", pairs: scored.map(([element, score]) => [bulk(element), { t: "dbl", n: score }]) };
      }
      case "TS.ADD": {
        const stamp = Number(args[1]);
        if (!Number.isInteger(stamp) || stamp < 0) return err("ERR TSDB: invalid timestamp");
        const series = of(args[0]!, "ts", () => ({ type: "ts", samples: new Map() }))!;
        if (series.samples.has(stamp) && args[3] !== "ON_DUPLICATE") return err("ERR TSDB: Error at upsert, update is not supported");
        series.samples.set(stamp, Number(args[2]));
        return int(stamp);
      }
      case "TS.DEL": {
        const series = of(args[0]!, "ts");
        if (!series) return err("ERR TSDB: the key does not exist");
        let went = 0;
        for (const stamp of series.samples.keys()) {
          if (stamp >= Number(args[1]) && stamp <= Number(args[2]) && series.samples.delete(stamp)) went++;
        }
        return int(went);
      }
      case "TS.RANGE": {
        const series = of(args[0]!, "ts");
        if (!series) return err("ERR TSDB: the key does not exist");
        const low = bound(args[1]!, 0).value;
        const high = bound(args[2]!, 0).value;
        const width = Number(args[5]);
        const windows = new Map<number, number[]>();
        for (const [stamp, value] of [...series.samples].sort((a, b) => a[0] - b[0])) {
          if (stamp < low || stamp > high) continue;
          const start = Math.floor(stamp / width) * width;
          windows.set(start, [...(windows.get(start) ?? []), value]);
        }
        return {
          t: "arr",
          items: [...windows].map(([start, values]) => ({
            t: "arr",
            items: [int(start), { t: "dbl", n: AGGREGATE[args[4]!]!(values) }],
          })),
        };
      }
      case "JSON.SET":
        keys.set(args[0]!, { type: "json", doc: args[2]! });
        return ok;
      case "JSON.GET": {
        const held = of(args[0]!, "json");
        return held ? bulk(held.doc) : { t: "null" };
      }
      default:
        return err(`ERR unknown command '${name}'`);
    }
  };

  const server: NetServer = createServer((socket) => {
    sockets.add(socket);
    const state = { proto: 2 as 2 | 3, authed: false };
    let queued: string[][] | undefined;
    let buffer = Buffer.alloc(0);

    /** One command off the front of the buffer, or nothing if it is not all here. */
    const next = (): string[] | undefined => {
      if (!buffer.length || buffer[0] !== 0x2a) return undefined;
      let at = buffer.indexOf("\r\n");
      if (at < 0) return undefined;
      const count = Number(buffer.toString("utf8", 1, at));
      at += 2;
      const words: string[] = [];
      for (let i = 0; i < count; i++) {
        const end = buffer.indexOf("\r\n", at);
        if (end < 0) return undefined;
        const length = Number(buffer.toString("utf8", at + 1, end));
        if (buffer.length < end + 2 + length + 2) return undefined;
        words.push(buffer.toString("utf8", end + 2, end + 2 + length));
        at = end + 2 + length + 2;
      }
      buffer = buffer.subarray(at);
      return words;
    };

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let out = "";
      for (let words = next(); words; words = next()) {
        seen.push(words);
        const command = words[0]!.toUpperCase();
        let reply: Out;
        if (can.password && !state.authed && !["HELLO", "AUTH"].includes(command)) {
          reply = err("NOAUTH Authentication required.");
        } else if (command === "MULTI") {
          queued = [];
          reply = ok;
        } else if (command === "EXEC") {
          // Every queued command runs, and one that fails does not undo the others.
          reply = { t: "arr", items: (queued ?? []).map((one) => run(one, state)) };
          queued = undefined;
        } else if (queued) {
          queued.push(words);
          reply = { t: "ok", s: "QUEUED" };
        } else {
          reply = run(words, state);
        }
        out += encode(reply, state.proto);
      }
      // Written a few bytes at a time, so a reply is never assumed to arrive whole.
      for (let i = 0; i < out.length; i += 7) socket.write(out.slice(i, i + 7));
    });
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  return {
    url: `redis://${can.password ? `:${can.password}@` : ""}127.0.0.1:${port}`,
    port,
    seen,
    keys,
    used: () => new Set(seen.map((words) => words[0]!.toUpperCase())),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const servers: Fake[] = [];
async function serverWith(shape?: Shape): Promise<Fake> {
  const fake = await fakeRedis(shape);
  servers.push(fake);
  return fake;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((fake) => fake.close()));
});

// ── The protocol ───────────────────────────────────────────────────────────

describe("reading a reply", () => {
  const read = (text: string) => readReply(Buffer.from(text))?.reply;

  it("reads every type RESP2 and RESP3 write", () => {
    expect(read("+OK\r\n")).toBe("OK");
    expect(read(":42\r\n")).toBe(42);
    expect(read("$5\r\nhello\r\n")).toBe("hello");
    expect(read("$-1\r\n")).toBeNull();
    expect(read("*-1\r\n")).toBeNull();
    expect(read("_\r\n")).toBeNull();
    expect(read("#t\r\n")).toBe(true);
    expect(read("#f\r\n")).toBe(false);
    expect(read(",3.25\r\n")).toBe(3.25);
    expect(read(",inf\r\n")).toBe(Infinity);
    expect(read(",-inf\r\n")).toBe(-Infinity);
    expect(read("(3492890328409238509324850943850943825024385\r\n")).toBe("3492890328409238509324850943850943825024385");
    expect(read("=15\r\ntxt:Some string\r\n")).toBe("Some string");
    expect(read("*2\r\n:1\r\n$1\r\na\r\n")).toEqual([1, "a"]);
    expect(read("~2\r\n+a\r\n+b\r\n")).toEqual(["a", "b"]);
    expect(read("%1\r\n+k\r\n:1\r\n")).toEqual(new Map([["k", 1]]));
    expect(read("$0\r\n\r\n")).toBe("");
  });

  it("reads an error as an error, with the word it began with", () => {
    const error = read("-WRONGTYPE Operation against a key holding the wrong kind of value\r\n");
    expect(error).toBeInstanceOf(RespError);
    expect((error as RespError).code).toBe("WRONGTYPE");
    expect(read("!11\r\nERR blob no\r\n")).toBeInstanceOf(RespError);
  });

  it("counts a string by its bytes, not its characters", () => {
    expect(read("$6\r\ncafé ☕\r\n".replace("$6", `$${Buffer.byteLength("café ☕")}`))).toBe("café ☕");
  });

  it("waits for the rest of a reply that has not all arrived", () => {
    const whole = "*2\r\n$5\r\nhello\r\n%1\r\n+k\r\n,1.5\r\n";
    for (let cut = 0; cut < whole.length; cut++) expect(readReply(Buffer.from(whole.slice(0, cut)))).toBeUndefined();
    expect(readReply(Buffer.from(whole))).toMatchObject({ next: Buffer.byteLength(whole), push: false });
  });

  it("marks a push as answering nothing, and reads past an attribute to the reply", () => {
    expect(readReply(Buffer.from(">2\r\n+message\r\n+hi\r\n"))).toMatchObject({ push: true });
    expect(read("|1\r\n+ttl\r\n:3600\r\n$3\r\nfoo\r\n")).toBe("foo");
  });

  it("reads a map's pairs whichever protocol wrote it", () => {
    expect(pairsOf(read("%2\r\n+a\r\n:1\r\n+b\r\n:2\r\n")!)).toEqual([["a", 1], ["b", 2]]);
    expect(pairsOf(read("*4\r\n+a\r\n:1\r\n+b\r\n:2\r\n")!)).toEqual([["a", 1], ["b", 2]]);
  });
});

describe("writing a command", () => {
  it("frames every argument by its length, so none of it is read as syntax", () => {
    expect(encodeCommand(["SET", "a key", "two\r\nlines", 7]).toString()).toBe(
      "*4\r\n$3\r\nSET\r\n$5\r\na key\r\n$10\r\ntwo\r\nlines\r\n$1\r\n7\r\n",
    );
    expect(encodeCommand(["GET", "café"]).toString()).toContain("$5\r\ncafé");
  });
});

describe("reading a connection string", () => {
  it("takes every part a socket needs", () => {
    expect(respOptionsFrom("rediss://sam:p%40ss@cache.internal:6380/3")).toMatchObject({
      host: "cache.internal",
      port: 6380,
      tls: true,
      username: "sam",
      password: "p@ss",
      database: 3,
    });
    expect(respOptionsFrom("valkey://localhost")).toMatchObject({ host: "localhost", port: 6379, tls: false, database: undefined });
    expect(respOptionsFrom("valkeys://localhost").tls).toBe(true);
  });

  it("refuses a scheme it does not open and a database that is not a number", () => {
    expect(() => respOptionsFrom("http://localhost")).toThrow(/not a scheme/);
    expect(() => respOptionsFrom("redis://localhost/main")).toThrow(/not a database/);
  });
});

describe("a connection", () => {
  it("opens in RESP3, and learns what it is speaking to", async () => {
    const fake = await serverWith();
    const resp = await Resp.open(respOptionsFrom(fake.url));
    expect(resp.protocol).toBe(3);
    expect(resp.hello.get("version")).toBe("8.2.0");
    expect(fake.seen[0]).toEqual(["HELLO", "3"]);
    await resp.close();
  });

  it("speaks RESP2 to a server from before HELLO", async () => {
    const fake = await serverWith({ hello: false, password: "hunter2" });
    const resp = await Resp.open(respOptionsFrom(fake.url));
    expect(resp.protocol).toBe(2);
    expect(fake.seen.map((words) => words[0])).toEqual(["HELLO", "AUTH"]);
    expect(await resp.command("PING")).toBe("OK");
    await resp.close();
  });

  it("authenticates in the greeting, and refuses to go on with the wrong password", async () => {
    const fake = await serverWith({ password: "hunter2" });
    const resp = await Resp.open(respOptionsFrom(fake.url));
    expect(fake.seen[0]).toEqual(["HELLO", "3", "AUTH", "default", "hunter2"]);
    await resp.close();
    await expect(Resp.open({ ...respOptionsFrom(fake.url), password: "wrong" })).rejects.toThrow(/WRONGPASS/);
  });

  it("answers several commands sent at once in the order they were sent, errors in their place", async () => {
    const fake = await serverWith();
    const resp = await Resp.open(respOptionsFrom(fake.url));
    const replies = await resp.pipeline([["HSET", "h", "a", "1"], ["NOPE"], ["HGETALL", "h"]]);
    expect(replies[0]).toBe(1);
    expect(replies[1]).toBeInstanceOf(RespError);
    expect(replies[2]).toEqual(new Map([["a", "1"]]));
    await expect(resp.command("NOPE")).rejects.toThrow(/unknown command/);
    await resp.close();
  });

  it("throws the failure of a command that failed inside a block run as one", async () => {
    const fake = await serverWith();
    const resp = await Resp.open(respOptionsFrom(fake.url));
    await expect(resp.atomic([["HSET", "h", "a", "1"], ["NOPE"]])).rejects.toThrow(/unknown command/);
    // The server does not roll back: the command before the failure was still run.
    expect(await resp.command("HGETALL", "h")).toEqual(new Map([["a", "1"]]));
    await resp.close();
  });

  it("fails what is waiting when the server goes away", async () => {
    const fake = await serverWith();
    const resp = await Resp.open(respOptionsFrom(fake.url));
    await fake.close();
    await expect(resp.command("PING")).rejects.toThrow();
  });
});

// ── The driver ─────────────────────────────────────────────────────────────

describe.each<[string, Shape]>([
  ["a server with vector sets, time series and JSON", {}],
  ["the same, spoken to in RESP2", { hello: false }],
  ["a server with none of them", { vectors: false, series: false, json: false }],
  ["a server with none of them, from before HELLO", { hello: false, vectors: false, series: false, json: false }],
])("a store on %s", (_what, shape) => {
  it("keeps every promise a store makes", async () => {
    const fake = await serverWith(shape);
    const result = await conform(redisDriver, { url: fake.url });
    expect(result.ok, conformanceReport(result)).toBe(true);
    const bucketed = result.checks.find((check) => /buckets a series/.test(check.name));
    expect(bucketed?.skipped ?? false).toBe(shape.series === false);
  });
});

describe("what a server has, used where it is found", () => {
  it("says what it found and what it does about it", async () => {
    const full = await serverWith();
    const connection = await redisDriver.connect({ url: full.url, dimensions: 2 });
    expect(connection.capabilities).toMatchObject({ vectors: true, fullText: false, vectorSearch: "index", faster: ["buckets"] });
    expect(connection.capabilities.serves).toEqual(["vector", "document", "timeseries"]);
    expect(connection.capabilities.detail).toMatch(/redis 8\.2\.0, RESP3/);
    expect(connection.capabilities.detail).toMatch(/ordered by the server \(vector sets\)/);
    expect(full.seen).toContainEqual(["COMMAND", "INFO", "VADD", "VSIM", "VREM", "TS.ADD", "TS.RANGE", "TS.DEL", "JSON.SET", "JSON.GET"]);
    await connection.close();

    const plain = await serverWith({ vectors: false, series: false, json: false });
    const fallback = await redisDriver.connect({ url: plain.url, dimensions: 2 });
    expect(fallback.capabilities).toMatchObject({ vectorSearch: "scan", faster: [] });
    expect(fallback.capabilities.detail).toMatch(/no vector sets; they arrive with Redis 8/);
    expect(fallback.capabilities.detail).toMatch(/no time series commands/);
    expect(fallback.capabilities.detail).toMatch(/JSON string in its hash/);
    await fallback.close();
  });

  it("asks a vector set for the nearest rows, and a scope's own set when a scope is asked", async () => {
    const fake = await serverWith();
    const store = await openStore("kept", { kind: "store", of: "vector", url: fake.url, dimensions: 2 }, { stateDir: "/x" });
    await store.remember([
      { id: "a", text: "near", scope: "mine", vector: [1, 0] },
      { id: "b", text: "far", scope: "mine", vector: [0, 1] },
      { id: "c", text: "theirs", scope: "theirs", vector: [1, 0] },
    ]);
    fake.seen.length = 0;

    const found = await store.recall([1, 0], { scope: "mine" });
    expect(found.map((row) => row.id)).toEqual(["a", "b"]);
    expect(found[0]?.score).toBeGreaterThan(found[1]!.score);
    const asked = fake.seen.find((words) => words[0] === "VSIM");
    expect(asked?.slice(0, 6)).toEqual(["VSIM", "praecise:vec:mine", "VALUES", "2", "1", "0"]);
    expect(asked).toContain("WITHSCORES");

    expect((await store.recall([1, 0])).map((row) => row.id).sort()).toEqual(["a", "b", "c"]);
    expect(fake.seen.findLast((words) => words[0] === "VSIM")?.[1]).toBe("praecise:vec");

    // Taken back, a row leaves both sets, so it cannot be found by what it used to say.
    await store.redact({ id: "a" }, "[taken back]");
    expect((await store.recall([1, 0], { scope: "mine" })).map((row) => row.id)).toEqual(["b"]);
    expect((fake.keys.get("praecise:vec") as { items: Map<string, number[]> }).items.has("a")).toBe(false);
    await store.close();
  });

  it("refuses a vector of another width before anything is written", async () => {
    const fake = await serverWith();
    const store = await openStore("kept", { kind: "store", of: "vector", url: fake.url, dimensions: 2 }, { stateDir: "/x" });
    await expect(
      store.remember([
        { id: "ok", text: "fine", vector: [1, 0] },
        { id: "bad", text: "too wide", vector: [1, 0, 0] },
      ]),
    ).rejects.toThrow(/2 wide and one of these is 3/);
    expect(await store.history()).toHaveLength(0);
    await store.close();
  });

  it("compares vectors here on a server with no vector sets, to the same order", async () => {
    const fake = await serverWith({ vectors: false });
    const store = await openStore("kept", { kind: "store", of: "vector", url: fake.url, dimensions: 2 }, { stateDir: "/x" });
    await store.remember([
      { id: "a", text: "near", vector: [1, 0] },
      { id: "b", text: "far", vector: [0, 1] },
    ]);
    expect((await store.recall([1, 0])).map((row) => row.id)).toEqual(["a", "b"]);
    expect(fake.used().has("VSIM")).toBe(false);
    expect(fake.used().has("VADD")).toBe(false);
    await store.close();
  });

  it("answers a bucketed series from the time series, and from the rows when that is behind", async () => {
    const fake = await serverWith();
    const store = await openStore("kept", { kind: "store", of: "timeseries", url: fake.url }, { stateDir: "/x" });
    await store.series.append("cpu", [
      { at: 1_000, value: 2 },
      { at: 2_000, value: 4 },
      { at: 61_000, value: 10 },
    ]);
    fake.seen.length = 0;
    expect(await store.series.range("cpu", { bucket: 60_000, aggregate: "mean" })).toEqual([
      { at: 0, value: 3 },
      { at: 60_000, value: 10 },
    ]);
    expect(fake.seen.filter((words) => words[0] === "TS.RANGE").map((words) => words[5])).toEqual(["count", "avg"]);
    // Only the windows were read: no row was fetched to answer.
    expect(fake.used().has("HGETALL")).toBe(false);

    // A reading before 1970 is a row and cannot be a sample, so the series is one
    // short. The count says so, and the rows answer instead — with the same windows.
    await store.series.append("cpu", { at: -5_000, value: 100 });
    fake.seen.length = 0;
    expect(await store.series.range("cpu", { bucket: 60_000, aggregate: "sum" })).toEqual([
      { at: -60_000, value: 100 },
      { at: 0, value: 6 },
      { at: 60_000, value: 10 },
    ]);
    expect(fake.used().has("HGETALL")).toBe(true);

    // Sent again, a reading replaces itself in the series as it does in the rows.
    await store.series.append("load", { at: 5, value: 1 });
    await store.series.append("load", { at: 5, value: 9 });
    expect(await store.series.range("load", { bucket: 10, aggregate: "max" })).toEqual([{ at: 0, value: 9 }]);
    await store.close();
  });

  it("keeps a row's record as a JSON document the server can address, and reads it back whole", async () => {
    const fake = await serverWith();
    const store = await openStore("kept", { kind: "store", of: "document", url: fake.url }, { stateDir: "/x" });
    const [id] = await store.remember({ text: "an invoice", meta: { total: 42, lines: [{ sku: "a" }] } });
    expect(fake.keys.get(`praecise:meta:${id}`)).toEqual({ type: "json", doc: '{"total":42,"lines":[{"sku":"a"}]}' });
    expect((await store.history())[0]?.meta).toEqual({ total: 42, lines: [{ sku: "a" }] });

    await store.forget({ id });
    expect(fake.keys.has(`praecise:meta:${id}`)).toBe(false);
    expect([...fake.keys.keys()]).toEqual([]);
    await store.close();
  });

  it("holds the three data verbs like any other backend", async () => {
    const fake = await serverWith({ vectors: false, series: false, json: false });
    const store = await openStore("kept", { kind: "store", of: "document", url: fake.url }, { stateDir: "/x" });
    await store.values.put(["users", "ada"], "theme", { dark: true });
    expect(await store.values.get(["users", "ada"], "theme")).toEqual({ dark: true });
    await store.facts.relate("ada", "knows", "bob");
    await store.facts.relate("bob", "knows", "cy");
    expect((await store.facts.neighbors("ada", { depth: 2 })).map((one) => one.node)).toEqual(["bob", "cy"]);
    await store.series.append("cpu", [
      { at: 1_000, value: 1 },
      { at: 2_000, value: 3 },
    ]);
    expect(await store.series.last("cpu")).toEqual({ at: 2_000, value: 3 });
    expect(await store.series.range("cpu", { bucket: 60_000, aggregate: "sum" })).toEqual([{ at: 0, value: 4 }]);
    await store.close();
  });
});

describe("writing as one", () => {
  it("sends nothing until a transaction ends, and then all of it as one block", async () => {
    const fake = await serverWith({ vectors: false, series: false, json: false });
    const connection = await redisDriver.connect({ url: fake.url });
    fake.seen.length = 0;

    await connection.transaction(async () => {
      await connection.put([{ id: "one", text: "first", at: 1 }], [undefined]);
      await connection.put([{ id: "two", text: "second", at: 2 }], [undefined]);
      expect(fake.used().has("HSET")).toBe(false);
    });
    const names = fake.seen.map((words) => words[0]);
    expect(names.filter((name) => name === "MULTI")).toHaveLength(1);
    expect(names.indexOf("MULTI")).toBeLessThan(names.indexOf("HSET"));
    expect(names.at(-1)).toBe("EXEC");
    expect((await connection.list({ limit: -1 })).map((item) => item.id)).toEqual(["two", "one"]);
    await connection.close();
  });

  it("keeps what an outer transaction wrote when one inside it fails", async () => {
    const fake = await serverWith({ vectors: false, series: false, json: false });
    const connection = await redisDriver.connect({ url: fake.url });
    await connection.transaction(async () => {
      await connection.put([{ id: "kept", text: "kept", at: 1 }], [undefined]);
      await connection
        .transaction(async () => {
          await connection.put([{ id: "undone", text: "undone", at: 2 }], [undefined]);
          throw new Error("stopped halfway");
        })
        .catch(() => undefined);
    });
    expect((await connection.list({ limit: -1 })).map((item) => item.id)).toEqual(["kept"]);
    await connection.close();
  });

  it("moves a row out of the scope it used to be in", async () => {
    const fake = await serverWith();
    const connection = await redisDriver.connect({ url: fake.url, dimensions: 2 });
    await connection.put([{ id: "row", text: "here", scope: "old", at: 1 }], [[1, 0]]);
    await connection.put([{ id: "row", text: "there", scope: "new", at: 2 }], [[0, 1]]);
    expect(await connection.list({ scope: "old", limit: -1 })).toEqual([]);
    expect((await connection.list({ scope: "new", limit: -1 })).map((item) => item.text)).toEqual(["there"]);
    expect(fake.keys.has("praecise:vec:old")).toBe(false);
    expect(await connection.near([1, 0], { scope: "old", limit: 5 })).toEqual([]);
    await connection.close();
  });
});

describe("the rest of what a connection is asked", () => {
  it("is opened by any of its four schemes, under a prefix the url may name", async () => {
    const fake = await serverWith({ vectors: false, series: false, json: false });
    for (const scheme of ["redis", "valkey"]) {
      const url = `${fake.url.replace("redis:", `${scheme}:`)}?prefix=app1`;
      const store = await openStore("kept", { kind: "store", of: "document", url }, { stateDir: "/x" });
      await store.remember({ id: scheme, text: "hello" });
      expect(fake.keys.has(`app1:item:${scheme}`)).toBe(true);
      await store.close();
    }
  });

  it("refuses a family it cannot be, by name", async () => {
    const fake = await serverWith();
    await expect(openStore("rows", { kind: "store", of: "sql", url: fake.url }, { stateDir: "/x" })).rejects.toThrow(
      /serves vector, document, timeseries/,
    );
  });

  it("runs the author's own command, with its arguments sent as arguments", async () => {
    const fake = await serverWith();
    const store = await openStore("kept", { kind: "store", of: "document", url: fake.url }, { stateDir: "/x" });
    await store.query("HSET", ["a key", "field", "two\r\nlines"]);
    expect(await store.query("HGETALL", ["a key"])).toEqual({ columns: ["key", "value"], rows: [["field", "two\r\nlines"]] });
    await expect(store.query("NOPE")).rejects.toThrow(/unknown command/);
    await store.close();
  });

  it("writes nothing through a connection opened read-only", async () => {
    const fake = await serverWith();
    const writer = await redisDriver.connect({ url: fake.url });
    await writer.put([{ id: "one", text: "kept", at: 1 }], [undefined]);
    const reader = await redisDriver.connect({ url: fake.url, readOnly: true });
    expect((await reader.list({ limit: -1 })).map((item) => item.text)).toEqual(["kept"]);
    await expect(reader.put([{ id: "two", text: "no", at: 2 }], [undefined])).rejects.toThrow(/read-only/);
    await expect(reader.drop({ limit: -1 })).rejects.toThrow(/read-only/);
    await expect(reader.run("HSET", ["k", "f", "v"])).rejects.toThrow(/read-only/);
    await expect(reader.run("FLUSHALL")).rejects.toThrow(/not known to only read/);
    expect((await reader.run("HGETALL", ["praecise:item:one"])).rows).toContainEqual(["body", "kept"]);
    await writer.close();
    await reader.close();
  });

  it("narrows by who wrote a row, a page at a time", async () => {
    const fake = await serverWith({ vectors: false, series: false, json: false });
    const connection = await redisDriver.connect({ url: fake.url });
    await connection.put(
      Array.from({ length: 450 }, (_, index) => ({
        id: `r${index}`,
        text: `row ${index}`,
        at: index,
        by: index % 150 === 0 ? "rare" : "common",
      })),
      Array.from({ length: 450 }, () => undefined),
    );
    expect((await connection.list({ by: "rare", limit: 2 })).map((item) => item.id)).toEqual(["r300", "r150"]);
    expect((await connection.list({ by: "rare", limit: -1 })).map((item) => item.id)).toEqual(["r300", "r150", "r0"]);
    await connection.close();
  });
});
