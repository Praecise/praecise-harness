/**
 * Computer use: a screen as a tool, and a browser as a screen.
 *
 * Three things are held here. The vocabulary — one handler, whichever names a model
 * uses for an action. The two ways the tool reaches a model — as a described function
 * everywhere, and as an endpoint's own computer tool where the app declared one — which
 * must arrive at the same handler in the same shape. And the browser driver, against a
 * stand-in for the DevTools socket, so what is checked is the protocol it speaks.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agent, guard } from "../src/define.js";
import { browserScreen, chordOf, type Launched, type Socket } from "../src/harness/browser.js";
import { HALTED, computer, computerTool, type Screen } from "../src/harness/computer.js";
import { clearResults, weigh } from "../src/harness/context.js";
import { attachedIn } from "../src/harness/modality.js";
import type { Message } from "../src/harness/types.js";
import { createApp } from "../src/sdk.js";
import { MODEL_ENV } from "./helpers.js";

const PNG = "iVBORw0KGgo=";

/** A screen that records what it was asked to do. */
function fakeScreen(extra: Partial<Screen> = {}): Screen & { did: unknown[][] } {
  const did: unknown[][] = [];
  const note = (...what: unknown[]): Promise<void> => {
    did.push(what);
    return Promise.resolve();
  };
  return {
    did,
    width: 1000,
    height: 600,
    screenshot: async (region) => {
      did.push(region ? ["screenshot", region] : ["screenshot"]);
      return { mime: "image/png", data: PNG, name: "screenshot.png" };
    },
    move: (to) => note("move", to),
    click: (at, options) => note("click", at, options),
    drag: (from, to, modifiers) => note("drag", from, to, modifiers),
    scroll: (at, by, modifiers) => note("scroll", at, by, modifiers),
    type: (text) => note("type", text),
    key: (combo) => note("key", combo),
    cursor: async () => ({ x: 5, y: 6 }),
    ...extra,
  };
}

describe("the vocabulary a model works a screen with", () => {
  it("each action reaches the screen as what it is", async () => {
    const screen = fakeScreen();
    const tool = computerTool(screen);
    const run = (args: Record<string, unknown>) => tool.run(args);

    expect(await run({ action: "click", coordinate: [10, 20] })).toBe("Clicked left at [10, 20].");
    await run({ action: "click", coordinate: [10, 20], button: "right", text: "shift" });
    await run({ action: "double_click", coordinate: [1, 2] });
    await run({ action: "move", coordinate: [3, 4] });
    await run({ action: "drag", start_coordinate: [1, 1], coordinate: [9, 9] });
    await run({ action: "scroll", coordinate: [50, 50], scroll_direction: "up", scroll_amount: 2 });
    await run({ action: "type", text: "hello" });
    expect(await run({ action: "key", text: "ctrl+s", repeat: 2 })).toBe("Pressed ctrl+s 2 times.");
    expect(await run({ action: "cursor_position" })).toBe("The pointer is at [5, 6].");
    expect(await run({ action: "wait", duration: 0 })).toBe("Waited 0s.");

    expect(screen.did).toEqual([
      ["click", { x: 10, y: 20 }, { button: "left", count: 1, modifiers: [] }],
      ["click", { x: 10, y: 20 }, { button: "right", count: 1, modifiers: ["shift"] }],
      ["click", { x: 1, y: 2 }, { button: "left", count: 2, modifiers: [] }],
      ["move", { x: 3, y: 4 }],
      ["drag", { x: 1, y: 1 }, { x: 9, y: 9 }, []],
      ["scroll", { x: 50, y: 50 }, { dx: 0, dy: -2 }, []],
      ["type", "hello"],
      ["key", "ctrl+s"],
      ["key", "ctrl+s"],
    ]);
  });

  it("a screenshot and a zoom come back as pictures on the result", async () => {
    const screen = fakeScreen();
    const tool = computerTool(screen);

    const shot = await tool.run({ action: "screenshot" });
    expect(attachedIn(shot)).toEqual([{ mime: "image/png", data: PNG, name: "screenshot.png" }]);
    // A region given either way round, and past the edge, is the part of it that is on the screen.
    const zoom = await tool.run({ action: "zoom", region: [900, 500, 1200, 100] });
    expect(attachedIn(zoom)).toHaveLength(1);
    expect(screen.did.at(-1)).toEqual(["screenshot", { x: 900, y: 100, width: 100, height: 400 }]);
  });

  it("answers to the names an endpoint's own tool uses for the same actions", async () => {
    const screen = fakeScreen();
    const tool = computerTool(screen);
    await tool.run({ action: "left_click", coordinate: [1, 1] });
    await tool.run({ action: "right_click", coordinate: [1, 1] });
    await tool.run({ action: "middle_click", coordinate: [1, 1] });
    await tool.run({ action: "triple_click", coordinate: [1, 1] });
    await tool.run({ action: "mouse_move", coordinate: "[7, 8]" });
    await tool.run({ action: "left_click_drag", start_coordinate: [1, 1], coordinate: [2, 2] });

    expect(screen.did.map((call) => [call[0], (call[2] as { button?: string; count?: number } | undefined)?.button, (call[2] as { count?: number } | undefined)?.count])).toEqual([
      ["click", "left", 1],
      ["click", "right", 1],
      ["click", "middle", 1],
      ["click", "left", 3],
      ["move", undefined, undefined],
      ["drag", undefined, undefined],
    ]);
  });

  it("refuses what it cannot do with a reason a model can act on", async () => {
    const tool = computerTool(fakeScreen());
    await expect(tool.run({ action: "click", coordinate: [1000, 20] })).rejects.toThrow(/off the screen, which is 1000 by 600/);
    await expect(tool.run({ action: "click", coordinate: "nowhere" })).rejects.toThrow(/has to be \[x, y\]/);
    await expect(tool.run({ action: "teleport" })).rejects.toThrow(/is not an action/);
    await expect(tool.run({ action: "left_mouse_down" })).rejects.toThrow(/this screen cannot left_mouse_down/);
    await expect(tool.run({ action: "click", coordinate: [1, 1], text: "hello" })).rejects.toThrow(/not a key that can be held/);
    await expect(tool.run({ action: "open", url: "https://example.com" })).rejects.toThrow(/cannot be sent to an address/);
  });

  it("offers only what the screen behind it can do", () => {
    const plain = computerTool(fakeScreen());
    const actions = (plain.parameters.properties as { action: { enum: string[] } }).action.enum;
    expect(actions).toEqual(["screenshot", "click", "double_click", "move", "drag", "scroll", "type", "key", "wait", "cursor_position", "zoom"]);
    expect(plain.native).toEqual({ kind: "computer", width: 1000, height: 600, without: ["left_mouse_down", "left_mouse_up", "hold_key"] });

    const full = computerTool(fakeScreen({ press: async () => undefined, release: async () => undefined, hold: async () => undefined, open: async () => undefined }));
    expect((full.parameters.properties as { action: { enum: string[] } }).action.enum).toEqual(
      expect.arrayContaining(["left_mouse_down", "left_mouse_up", "hold_key", "open"]),
    );
    expect(full.native?.without).toEqual([]);
  });

  it("after one action in a turn fails, the rest of that turn are not run, and the next turn is", async () => {
    const screen = fakeScreen();
    const tool = computerTool(screen);
    const turn = (): { transcript: Message[] } => ({ transcript: [{ role: "assistant", content: "" }] });
    const first = turn();

    await expect(tool.run({ action: "click", coordinate: [5000, 1] }, first)).rejects.toThrow();
    expect(await tool.run({ action: "type", text: "into the wrong field" }, first)).toBe(HALTED);
    expect(screen.did).toEqual([]);

    expect(await tool.run({ action: "type", text: "now" }, turn())).toBe("Typed 3 character(s).");
  });

  it("can return a fresh screenshot with every action that changes something", async () => {
    const screen = fakeScreen();
    const tool = computerTool(screen, { screenshotAfter: true, settleMs: 0 });

    expect(attachedIn(await tool.run({ action: "click", coordinate: [1, 1] }))).toHaveLength(1);
    // Looking changes nothing, so there is nothing new to show.
    expect(await tool.run({ action: "cursor_position" })).toBe("The pointer is at [5, 6].");
  });

  it("a wait ends when the request does", async () => {
    const stop = new AbortController();
    const tool = computerTool(fakeScreen());
    const waiting = tool.run({ action: "wait", duration: 20 }, { transcript: [], signal: stop.signal });
    stop.abort(new Error("the caller hung up"));

    await expect(waiting).rejects.toThrow("the caller hung up");
  });

  it("describes what it would do to an authority, and is not trusted", () => {
    const tool = computerTool(fakeScreen({ open: async () => undefined }));
    expect(tool.trust).toBe("untrusted");
    expect(tool.effect).toBe("write");
    expect(tool.action!({ action: "left_click", coordinate: [1, 2] })).toEqual({ operation: "computer.click", detail: { coordinate: [1, 2] } });
    expect(tool.action!({ action: "open", url: "https://example.com" })).toMatchObject({ operation: "computer.open", counterparty: "https://example.com" });
  });
});

describe("old screenshots give way when a transcript runs out of room", () => {
  const shot = { mime: "image/png", data: PNG };
  const transcript: Message[] = [
    { role: "user", content: "do it" },
    ...Array.from({ length: 5 }, (_, at): Message[] => [
      { role: "assistant", content: "", toolCalls: [{ id: `c${at}`, name: "computer", args: { action: "screenshot" } }] },
      { role: "tool", toolCallId: `c${at}`, name: "computer", content: "The screen.", attachments: [shot] },
    ]).flat(),
  ];

  it("a picture is weighed as more than the sentence it came with", () => {
    expect(weigh(transcript)).toBeGreaterThan(5 * 1_000);
  });

  it("clearing an old result clears what was attached to it, and keeps the recent ones", () => {
    const cleared = clearResults(transcript);
    const results = cleared.messages.filter((message) => message.role === "tool");

    expect(results.map((message) => message.attachments?.length ?? 0)).toEqual([0, 0, 1, 1, 1]);
    expect(results[0]!.content).toContain("cleared to make room");
    expect(cleared.freed).toBeGreaterThan(2_000);
    // The transcript it was given is untouched.
    expect(transcript[2]!.attachments).toHaveLength(1);
  });
});

// ── In an app, on the messages wire ─────────────────────────────────────────

type Block = Record<string, unknown>;
type Sent = { body: Record<string, unknown>; headers: Record<string, string> };

function endpoint(script: Block[][]) {
  const sent: Sent[] = [];
  const queue = [...script];
  const impl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const content = queue.shift() ?? [{ type: "text", text: "nothing more was scripted" }];
    return new Response(
      JSON.stringify({
        content,
        stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetch: impl, sent };
}

const blocksOf = (sent: Sent): Block[] => (sent.body.messages as { content: Block[] }[]).flatMap((message) => message.content);

describe("a screen in an app", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "praecise-computer-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const house = { url: "https://models.test", credential: "HOUSE_KEY", speaks: "messages", fast: "small" };
  const build = (screen: Screen, model: { fetch: typeof fetch }, provider: Record<string, unknown> = {}, extra: Partial<Parameters<typeof createApp>[0]> = {}) =>
    createApp(
      {
        root,
        config: { models: { house: { ...house, ...provider } } },
        agents: { operator: agent({ name: "operator", role: "Work the screen.", quality: "fast", tools: ["computer"] }) },
        functions: { computer: computer(screen) },
        ...extra,
      },
      { env: MODEL_ENV, fetch: model.fetch },
    );

  it("is sent as a described function, and its screenshot goes back as a picture the model can see", async () => {
    const screen = fakeScreen();
    const model = endpoint([
      [{ type: "tool_use", id: "t1", name: "computer", input: { action: "screenshot" } }],
      [{ type: "tool_use", id: "t2", name: "computer", input: { action: "click", coordinate: [10, 20] } }],
      [{ type: "text", text: "Clicked it." }],
    ]);
    const seen: (string | undefined)[] = [];
    const app = await build(screen, model, {}, { guard: guard(({ action, tainted }) => void seen.push(`${action?.operation}${tainted ? " tainted" : ""}`)) });
    const answer = await app.ask("operator", "press the button");

    const offered = (model.sent[0]!.body.tools as Block[]).find((tool) => tool.name === "computer")!;
    expect(offered.type).toBeUndefined();
    expect((offered.input_schema as { required: string[] }).required).toEqual(["action"]);

    const result = blocksOf(model.sent[1]!).find((block) => block.type === "tool_result")!;
    expect(result.content).toEqual([
      { type: "text", text: "The screen, 1000 by 600." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
    ]);
    expect(screen.did).toEqual([["screenshot"], ["click", { x: 10, y: 20 }, { button: "left", count: 1, modifiers: [] }]]);
    // What a screen shows is not the app's, so what follows it is marked.
    expect(seen).toEqual(["computer.screenshot", "computer.click tainted"]);
    expect(answer.tainted).toBe(true);
    await app.close();
  });

  it("is declared as the endpoint's own toolset where the app named one, and its members arrive as the same calls", async () => {
    const screen = fakeScreen();
    const model = endpoint([
      [
        { type: "tool_use", id: "t1", name: "left_click", toolset_name: "computer", input: { coordinate: [500, 300] } },
        { type: "tool_use", id: "t2", name: "key", toolset_name: "computer", input: { text: "Return", repeat: 2 } },
      ],
      [{ type: "text", text: "Done." }],
    ]);
    const app = await build(screen, model, { computer: "computer_toolset_20260801" });
    const answer = await app.ask("operator", "press the button");

    // No name, no screen size, and the members this screen cannot perform turned off.
    expect((model.sent[0]!.body.tools as Block[])[0]).toEqual({
      type: "computer_toolset_20260801",
      configs: { left_mouse_down: { enabled: false }, left_mouse_up: { enabled: false }, hold_key: { enabled: false } },
    });
    expect(screen.did).toEqual([
      ["click", { x: 500, y: 300 }, { button: "left", count: 1, modifiers: [] }],
      ["key", "Return"],
      ["key", "Return"],
    ]);
    // The record is of one tool, called with an action, whichever way it was declared.
    expect(answer.toolCalls).toEqual([
      { name: "computer", args: { coordinate: [500, 300], action: "left_click" } },
      { name: "computer", args: { text: "Return", repeat: 2, action: "key" } },
    ]);

    // Handed back in the form they came in: the member as the name, and the toolset on call and result.
    const back = blocksOf(model.sent[1]!);
    expect(back.filter((block) => block.type === "tool_use")).toEqual([
      { type: "tool_use", id: "t1", name: "left_click", toolset_name: "computer", input: { coordinate: [500, 300] } },
      { type: "tool_use", id: "t2", name: "key", toolset_name: "computer", input: { text: "Return", repeat: 2 } },
    ]);
    expect(back.filter((block) => block.type === "tool_result").map((block) => [block.tool_use_id, block.toolset_name])).toEqual([
      ["t1", "computer"],
      ["t2", "computer"],
    ]);
    await app.close();
  });

  it("is declared with its name and the screen's size where the app named the earlier form, and the header is the app's too", async () => {
    const screen = fakeScreen();
    const model = endpoint([
      [{ type: "tool_use", id: "t1", name: "computer", input: { action: "left_click", coordinate: [5, 5] } }],
      [{ type: "text", text: "Done." }],
    ]);
    const app = await build(screen, model, { computer: "computer_20251124", headers: { "anthropic-beta": "computer-use-2025-11-24" } });
    await app.ask("operator", "press the button");

    expect((model.sent[0]!.body.tools as Block[])[0]).toEqual({ type: "computer_20251124", name: "computer", display_width_px: 1000, display_height_px: 600 });
    expect(model.sent[0]!.headers["anthropic-beta"]).toBe("computer-use-2025-11-24");
    expect(blocksOf(model.sent[1]!).find((block) => block.type === "tool_use")).toEqual({
      type: "tool_use",
      id: "t1",
      name: "computer",
      input: { action: "left_click", coordinate: [5, 5] },
    });
    expect(screen.did).toHaveLength(1);
    await app.close();
  });
});

// ── The browser, against a stand-in for its DevTools socket ─────────────────

interface Command {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** A DevTools endpoint: answers every command, and records it. */
function fakeBrowser(answers: Record<string, (params: Record<string, unknown>) => Record<string, unknown> | Error> = {}) {
  const commands: Command[] = [];
  const urls: string[] = [];
  let closed = 0;

  class FakeSocket implements Socket {
    private readonly heard = new Map<string, ((event: { data?: unknown }) => void)[]>();
    constructor(url: string) {
      urls.push(url);
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
      this.heard.set(type, [...(this.heard.get(type) ?? []), listener]);
    }
    private emit(type: string, event: { data?: unknown }): void {
      for (const listener of this.heard.get(type) ?? []) listener(event);
    }
    send(data: string): void {
      const command = JSON.parse(data) as Command;
      commands.push(command);
      const defaults: Record<string, Record<string, unknown>> = {
        "Target.getTargets": { targetInfos: [{ targetId: "page-1", type: "page" }] },
        "Target.attachToTarget": { sessionId: "session-1" },
        "Page.captureScreenshot": { data: PNG },
        "Page.navigate": { frameId: "frame-1" },
      };
      const answer = answers[command.method]?.(command.params) ?? defaults[command.method] ?? {};
      queueMicrotask(() => {
        this.emit("message", {
          data: JSON.stringify(answer instanceof Error ? { id: command.id, error: { message: answer.message } } : { id: command.id, result: answer }),
        });
        if (command.method === "Page.navigate" && !(answer instanceof Error)) {
          this.emit("message", { data: JSON.stringify({ method: "Page.loadEventFired", sessionId: "session-1", params: {} }) });
        }
      });
    }
    close(): void {
      closed++;
    }
  }

  /** What was sent to the page since the browser was set up, as `[method, params]`. */
  const since = (from: number): [string, Record<string, unknown>][] => commands.slice(from).map((command) => [command.method, command.params]);
  return { WebSocket: FakeSocket, commands, urls, since, closed: () => closed };
}

describe("a browser as a screen", () => {
  const ENDPOINT = "ws://127.0.0.1:9222/devtools/browser/abc";

  it("attaches to the page, pins its size, and speaks to it by session", async () => {
    const browser = fakeBrowser();
    const screen = await browserScreen({ endpoint: ENDPOINT, WebSocket: browser.WebSocket, width: 800, height: 600 });

    expect(browser.urls).toEqual([ENDPOINT]);
    expect(browser.commands.map((command) => [command.method, command.sessionId])).toEqual([
      ["Target.getTargets", undefined],
      ["Target.attachToTarget", undefined],
      ["Page.enable", "session-1"],
      ["Emulation.setDeviceMetricsOverride", "session-1"],
    ]);
    expect(browser.commands[1]!.params).toEqual({ targetId: "page-1", flatten: true });
    expect(browser.commands[3]!.params).toEqual({ width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    expect([screen.width, screen.height]).toEqual([800, 600]);
    await screen.close();
  });

  it("opens a page of its own when the browser has none", async () => {
    const browser = fakeBrowser({ "Target.getTargets": () => ({ targetInfos: [{ targetId: "worker-1", type: "service_worker" }] }), "Target.createTarget": () => ({ targetId: "page-9" }) });
    await browserScreen({ endpoint: ENDPOINT, WebSocket: browser.WebSocket });

    expect(browser.commands.map((command) => command.method).slice(0, 3)).toEqual(["Target.getTargets", "Target.createTarget", "Target.attachToTarget"]);
    expect(browser.commands[2]!.params).toMatchObject({ targetId: "page-9" });
  });

  it("takes a screenshot, and a zoom is the region enlarged to the screen's size", async () => {
    const browser = fakeBrowser();
    const screen = await browserScreen({ endpoint: ENDPOINT, WebSocket: browser.WebSocket, width: 800, height: 600 });
    const from = browser.commands.length;

    expect(await screen.screenshot()).toEqual({ mime: "image/png", data: PNG, name: "screenshot.png" });
    await screen.screenshot({ x: 100, y: 100, width: 400, height: 300 });
    await screen.screenshot({ x: 0, y: 0, width: 10, height: 10 });

    expect(browser.since(from)).toEqual([
      ["Page.captureScreenshot", { format: "png" }],
      ["Page.captureScreenshot", { format: "png", clip: { x: 100, y: 100, width: 400, height: 300, scale: 2 } }],
      // A speck is enlarged as far as is still a picture of something, and no further.
      ["Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 10, height: 10, scale: 4 } }],
    ]);
  });

  it("clicks as a move, a press and a release, counting the clicks of a double click", async () => {
    const browser = fakeBrowser();
    const screen = await browserScreen({ endpoint: ENDPOINT, WebSocket: browser.WebSocket });
    const from = browser.commands.length;
    await screen.click({ x: 10, y: 20 }, { button: "left", count: 2, modifiers: ["shift"] });

    expect(browser.since(from)).toEqual([
      ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 20, buttons: 0, modifiers: 8 }],
      ["Input.dispatchMouseEvent", { type: "mousePressed", x: 10, y: 20, buttons: 1, button: "left", clickCount: 1, modifiers: 8 }],
      ["Input.dispatchMouseEvent", { type: "mouseReleased", x: 10, y: 20, buttons: 0, button: "left", clickCount: 1, modifiers: 8 }],
      ["Input.dispatchMouseEvent", { type: "mousePressed", x: 10, y: 20, buttons: 1, button: "left", clickCount: 2, modifiers: 8 }],
      ["Input.dispatchMouseEvent", { type: "mouseReleased", x: 10, y: 20, buttons: 0, button: "left", clickCount: 2, modifiers: 8 }],
    ]);
    expect(await screen.cursor()).toEqual({ x: 10, y: 20 });
  });

  it("drags with the button held, by way of the middle, and scrolls by clicks of the wheel", async () => {
    const browser = fakeBrowser();
    const screen = await browserScreen({ endpoint: ENDPOINT, WebSocket: browser.WebSocket });
    const from = browser.commands.length;
    await screen.drag({ x: 0, y: 0 }, { x: 100, y: 50 }, []);
    await screen.scroll({ x: 5, y: 5 }, { dx: 0, dy: 3 }, []);

    expect(browser.since(from).map(([, params]) => [params.type, params.x, params.y, params.buttons, params.deltaY])).toEqual([
      ["mouseMoved", 0, 0, 0, undefined],
      ["mousePressed", 0, 0, 1, undefined],
      ["mouseMoved", 50, 25, 1, undefined],
      ["mouseMoved", 100, 50, 1, undefined],
      ["mouseReleased", 100, 50, 0, undefined],
      ["mouseWheel", 5, 5, 0, 300],
    ]);
  });

  it("types text as text, and a line break as Enter", async () => {
    const browser = fakeBrowser();
    const screen = await browserScreen({ endpoint: ENDPOINT, WebSocket: browser.WebSocket });
    const from = browser.commands.length;
    await screen.type("one\ntwo");

    expect(browser.since(from)).toEqual([
      ["Input.insertText", { text: "one" }],
      ["Input.dispatchKeyEvent", { type: "keyDown", modifiers: 0, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" }],
      ["Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }],
      ["Input.insertText", { text: "two" }],
    ]);
  });

  it("presses a chord with its modifiers down around it, and enters no character for a command", async () => {
    const browser = fakeBrowser();
    const screen = await browserScreen({ endpoint: ENDPOINT, WebSocket: browser.WebSocket });
    const from = browser.commands.length;
    await screen.key("ctrl+shift+t");

    expect(browser.since(from).map(([, params]) => [params.type, params.key, params.modifiers, params.text])).toEqual([
      ["rawKeyDown", "Control", 2, undefined],
      ["rawKeyDown", "Shift", 10, undefined],
      ["rawKeyDown", "T", 10, undefined],
      ["keyUp", "T", 10, undefined],
      ["keyUp", "Shift", 2, undefined],
      ["keyUp", "Control", 0, undefined],
    ]);
  });

  it("knows keys by the names a model uses for them", () => {
    expect(chordOf("Return").key).toMatchObject({ key: "Enter", vk: 13 });
    expect(chordOf("Page_Down").key).toMatchObject({ key: "PageDown", vk: 34 });
    expect(chordOf("F5").key).toEqual({ key: "F5", code: "F5", vk: 116 });
    expect(chordOf("a").key).toEqual({ key: "a", code: "KeyA", vk: 65, text: "a" });
    expect(chordOf("shift+a").key).toMatchObject({ key: "A", text: "A" });
    expect(chordOf("super").modifiers).toBe(4);
    expect(chordOf("ctrl++").key).toMatchObject({ key: "+" });
    expect(() => chordOf("hyper+a")).toThrow(/not a key that can be held/);
    expect(() => chordOf("ctrl+banana")).toThrow(/not a key this screen knows/);
  });

  it("goes to a web address and waits for it to load, and to no other kind unless the app says so", async () => {
    const browser = fakeBrowser();
    const screen = await browserScreen({ endpoint: ENDPOINT, WebSocket: browser.WebSocket, url: "https://example.com/start" });

    expect(browser.commands.at(-1)).toMatchObject({ method: "Page.navigate", params: { url: "https://example.com/start" } });
    await expect(screen.open("file:///etc/passwd")).rejects.toThrow(/does not open file: addresses/);
    await expect(screen.open("example.com")).rejects.toThrow(/is not an address/);
    expect(browser.commands.filter((command) => command.method === "Page.navigate")).toHaveLength(1);
  });

  it("says why when the browser refuses a command or a page will not open", async () => {
    const browser = fakeBrowser({
      "Page.captureScreenshot": () => new Error("Target closed"),
      "Page.navigate": () => ({ errorText: "net::ERR_NAME_NOT_RESOLVED" }),
    });
    const screen = await browserScreen({ endpoint: ENDPOINT, WebSocket: browser.WebSocket });

    await expect(screen.screenshot()).rejects.toThrow("Target closed");
    await expect(screen.open("https://nowhere.invalid")).rejects.toThrow(/net::ERR_NAME_NOT_RESOLVED/);
  });

  it("starts the browser it is pointed to, in a profile of its own, and stops it when closed", async () => {
    const browser = fakeBrowser();
    const started: { command: string; args: string[] }[] = [];
    let killed = 0;
    const spawn = (command: string, args: string[]): Launched => {
      started.push({ command, args });
      return {
        stderr: {
          on: (_event, listener) => {
            queueMicrotask(() => listener("\nDevTools listening on ws://127.0.0.1:41234/devtools/browser/xyz\n"));
          },
        },
        on: () => undefined,
        kill: () => void killed++,
      };
    };
    const screen = await browserScreen({ executable: "/opt/chromium/chrome", WebSocket: browser.WebSocket, spawn, width: 1024, height: 768 });

    expect(started[0]!.command).toBe("/opt/chromium/chrome");
    expect(started[0]!.args).toEqual(expect.arrayContaining(["--remote-debugging-port=0", "--headless=new", "--window-size=1024,768", "about:blank"]));
    expect(started[0]!.args.some((arg) => arg.startsWith("--user-data-dir="))).toBe(true);
    expect(browser.urls).toEqual(["ws://127.0.0.1:41234/devtools/browser/xyz"]);

    await screen.close();
    expect(browser.commands.at(-1)!.method).toBe("Browser.close");
    expect(killed).toBe(1);
    expect(browser.closed()).toBe(1);
  });

  it("leaves a browser it was only pointed at running, and needs to be told where one is", async () => {
    const browser = fakeBrowser();
    const screen = await browserScreen({ endpoint: ENDPOINT, WebSocket: browser.WebSocket });
    await screen.close();

    expect(browser.commands.some((command) => command.method === "Browser.close")).toBe(false);
    await expect(browserScreen({ WebSocket: browser.WebSocket })).rejects.toThrow(/needs `executable`/);
  });

  it("says so when the browser exits before it is ready", async () => {
    const spawn = (): Launched => ({
      stderr: { on: (_event, listener) => void queueMicrotask(() => listener("error while loading shared libraries")) },
      on: (event, listener) => {
        if (event === "exit") setTimeout(() => listener(127), 5);
      },
      kill: () => undefined,
    });

    await expect(browserScreen({ executable: "/nope", WebSocket: fakeBrowser().WebSocket, spawn })).rejects.toThrow(/exited \(127\) before it was ready: error while loading shared libraries/);
  });

  it("works through the tool: a model's click becomes the protocol's", async () => {
    const browser = fakeBrowser();
    const screen = await browserScreen({ endpoint: ENDPOINT, WebSocket: browser.WebSocket });
    const tool = computerTool(screen);
    const from = browser.commands.length;

    expect(attachedIn(await tool.run({ action: "screenshot" }))).toHaveLength(1);
    await tool.run({ action: "left_click", coordinate: [640, 400] });
    await tool.run({ action: "open", url: "https://example.com" });

    expect(browser.since(from).map(([method]) => method)).toEqual([
      "Page.captureScreenshot",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Page.navigate",
    ]);
  });
});
