/**
 * A screen read as elements and worked by reference.
 *
 * Three things are held here. The tool: what it reads, how it acts on a reference, and
 * what it tells the guard. The browser's side of it, against a stand-in for the
 * DevTools socket: the tree it is given, the references it keeps, and the refusal of
 * one whose element has changed. And, where a browser is named in
 * `PRAECISE_TEST_CHROMIUM`, the whole of it against a real page.
 */

import { describe, expect, it } from "vitest";

import { browserScreen, type Socket } from "../src/harness/browser.js";
import { HALTED, computerTool, type ReadOptions, type Screen, type ScreenElement } from "../src/harness/computer.js";
import { elements, elementsTool } from "../src/harness/elements.js";
import type { Message } from "../src/harness/types.js";

const PNG = "iVBORw0KGgo=";

const PAGE: ScreenElement[] = [
  {
    ref: "r1",
    role: "page",
    name: "Orders",
    children: [
      { ref: "r2", role: "heading", name: "Orders" },
      { ref: "r3", role: "textbox", name: "Search", value: "shoes" },
      { ref: "r4", role: "button", name: "Export", states: ["disabled"] },
      { ref: "r5", role: "paragraph", children: [{ ref: "r6", role: "text", name: "Three orders are waiting." }] },
      { ref: "r7", role: "button", name: "Send all" },
    ],
  },
];

const BOXES: Record<string, { x: number; y: number; width: number; height: number }> = {
  r3: { x: 100, y: 40, width: 200, height: 20 },
  r4: { x: 400, y: 40, width: 80, height: 20 },
  r7: { x: 100, y: 5000, width: 80, height: 20 },
};

/** A screen with a list of elements, which records what it was asked to do. */
function fakeScreen(extra: Partial<Screen> = {}, page: () => ScreenElement[] = () => PAGE): Screen & { did: unknown[][] } {
  const did: unknown[][] = [];
  const note = (...what: unknown[]): Promise<void> => {
    did.push(what);
    return Promise.resolve();
  };
  const flat = (list: ScreenElement[]): ScreenElement[] => list.flatMap((each) => [each, ...flat(each.children ?? [])]);
  return {
    did,
    width: 1000,
    height: 600,
    screenshot: async () => ({ mime: "image/png", data: PNG, name: "screenshot.png" }),
    move: (to) => note("move", to),
    click: (at, options) => note("click", at, options),
    drag: (from, to) => note("drag", from, to),
    scroll: (at, by) => note("scroll", at, by),
    type: (text) => note("type", text),
    key: (combo) => note("key", combo),
    cursor: async () => ({ x: 0, y: 0 }),
    read: async (options: ReadOptions = {}) => {
      const all = flat(page());
      if (options.filter === "interactive") return all.filter((each) => each.role === "button" || each.role === "textbox").map(({ children: _children, ...each }) => each);
      return options.ref ? all.filter((each) => each.ref === options.ref) : page();
    },
    locate: async (ref) => {
      const found = flat(page()).find((each) => each.ref === ref);
      if (!found) throw new Error(`${ref} is no longer on the page; read the page again`);
      return { ...found, box: BOXES[ref] ?? { x: 0, y: 0, width: 10, height: 10 } };
    },
    ...extra,
  };
}

describe("a screen read as elements", () => {
  it("reads what is on it as kinds, names and references, nested as it is", async () => {
    const tool = elementsTool(fakeScreen());
    expect(await tool.run({ action: "read" })).toBe(
      [
        'page "Orders" [r1]',
        '  heading "Orders" [r2]',
        '  textbox "Search" = "shoes" [r3]',
        '  button "Export" (disabled) [r4]',
        "  paragraph [r5]",
        '    text "Three orders are waiting." [r6]',
        '  button "Send all" [r7]',
      ].join("\n"),
    );
  });

  it("reads only what can be worked, or only one part, when asked", async () => {
    const tool = elementsTool(fakeScreen());
    expect(await tool.run({ action: "read_page", filter: "interactive" })).toBe(
      ['textbox "Search" = "shoes" [r3]', 'button "Export" (disabled) [r4]', 'button "Send all" [r7]'].join("\n"),
    );
    expect(await tool.run({ action: "read", ref: "r5" })).toBe(['paragraph [r5]', '  text "Three orders are waiting." [r6]'].join("\n"));
  });

  it("refuses a reading that is too long, and says how to ask for less", async () => {
    const tool = elementsTool(fakeScreen(), { limit: 1_000 });
    const long = (): ScreenElement[] => Array.from({ length: 200 }, (_, at) => ({ ref: `x${at}`, role: "link", name: `A link with a long name ${at}` }));
    const wide = elementsTool(fakeScreen({}, long), { limit: 1_000 });
    await expect(wide.run({ action: "read" })).rejects.toThrow(/more than the 1000 one reading may return.*interactive/);
    expect(String(await tool.run({ action: "read" })).length).toBeLessThan(1_000);
  });

  it("finds by words from the kind, the name or the contents", async () => {
    const tool = elementsTool(fakeScreen());
    expect(await tool.run({ action: "find", query: "button send" })).toBe('button "Send all" [r7]');
    expect(await tool.run({ action: "find", query: "shoes" })).toBe('textbox "Search" = "shoes" [r3]');
    expect(await tool.run({ action: "find", query: "refund" })).toBe('Nothing on the screen matches "refund".');
  });

  it("gives the text of the screen without the rest", async () => {
    expect(await elementsTool(fakeScreen()).run({ action: "get_page_text" })).toBe("Three orders are waiting.");
  });

  it("clicks an element in the middle of where it is, with the pointer", async () => {
    const screen = fakeScreen();
    const tool = elementsTool(screen, { changes: false });
    expect(await tool.run({ action: "click", ref: "r3" })).toBe('Clicked textbox "Search" = "shoes" [r3].');
    expect(await tool.run({ action: "double_click", target: { type: "ref", ref: "r4" }, modifiers: "shift" })).toBe('Clicked button "Export" (disabled) [r4] 2 times.');
    expect(screen.did).toEqual([
      ["click", { x: 200, y: 50 }, { button: "left", count: 1, modifiers: [] }],
      ["click", { x: 440, y: 50 }, { button: "left", count: 2, modifiers: ["shift"] }],
    ]);
  });

  it("presses without the pointer on a screen that can, for a plain click only", async () => {
    const pressed: string[] = [];
    const screen = fakeScreen({ activate: async (ref) => void pressed.push(ref) });
    const tool = elementsTool(screen, { changes: false });
    await tool.run({ action: "click", ref: "r3" });
    await tool.run({ action: "right_click", ref: "r3" });
    expect(pressed).toEqual(["r3"]);
    expect(screen.did).toEqual([["click", { x: 200, y: 50 }, { button: "right", count: 1, modifiers: [] }]]);
  });

  it("will not point at what is not in view", async () => {
    const screen = fakeScreen();
    await expect(elementsTool(screen, { changes: false }).run({ action: "click", ref: "r7" })).rejects.toThrow(/is not in view/);
    expect(screen.did).toEqual([]);
  });

  it("says what appeared, went or changed after an action", async () => {
    let sent = false;
    const page = (): ScreenElement[] =>
      sent
        ? [
            { ref: "r3", role: "textbox", name: "Search" },
            { ref: "r4", role: "button", name: "Export" },
            { ref: "r9", role: "button", name: "Undo" },
          ]
        : [
            { ref: "r3", role: "textbox", name: "Search" },
            { ref: "r4", role: "button", name: "Export", states: ["disabled"] },
            { ref: "r8", role: "button", name: "Send" },
          ];
    const screen = fakeScreen({ click: async () => void (sent = true) }, page);
    const tool = elementsTool(screen, { settleMs: 0 });

    expect(await tool.run({ action: "click", ref: "r8" })).toBe(
      ['Clicked button "Send" [r8].', 'changed: button "Export" [r4]', 'appeared: button "Undo" [r9]', 'gone: button "Send" [r8]'].join("\n"),
    );
    expect(await tool.run({ action: "hover", ref: "r4" })).toBe('Pointing at button "Export" [r4]. Nothing that can be worked changed.');
  });

  it("fills a field on a screen that can, and does not offer to on one that cannot", async () => {
    const filled: unknown[] = [];
    const tool = elementsTool(fakeScreen({ fill: async (ref, value) => void filled.push([ref, value]) }), { changes: false });
    expect(await tool.run({ action: "form_input", ref: "r3", value: "boots" })).toBe("Filled [r3] with 5 character(s).");
    expect(filled).toEqual([["r3", "boots"]]);

    const without = elementsTool(fakeScreen());
    expect((without.parameters.properties as { action: { enum: string[] } }).action.enum).not.toContain("fill");
    await expect(without.run({ action: "fill", ref: "r3", value: "boots" })).rejects.toThrow(/cannot fill a field/);
  });

  it("a reference whose element has gone is refused, and the rest of the turn is not run through either tool", async () => {
    const screen = fakeScreen();
    const byElement = elementsTool(screen, { changes: false });
    const byPosition = computerTool(screen);
    const turn: { transcript: Message[] } = { transcript: [{ role: "assistant", content: "" }] };

    await expect(byElement.run({ action: "click", ref: "r99" }, turn)).rejects.toThrow(/no longer on the page/);
    expect(await byPosition.run({ action: "type", text: "into whatever is there" }, turn)).toBe(HALTED);
    expect(await byElement.run({ action: "click", ref: "r3" }, turn)).toBe(HALTED);
    expect(screen.did).toEqual([]);
  });

  it("tells an authority the kind and name of what is being pressed, and is not trusted", async () => {
    const tool = elementsTool(fakeScreen());
    expect(tool.trust).toBe("untrusted");
    expect(tool.effect).toBe("write");
    // Before anything is read, only the reference is known.
    expect(tool.action!({ action: "click", ref: "r7" })).toEqual({ operation: "elements.click", detail: { ref: "r7" } });
    await tool.run({ action: "read" });
    expect(tool.action!({ action: "left_click", ref: "r7" })).toEqual({ operation: "elements.click", detail: { ref: "r7", role: "button", name: "Send all" } });
    expect(tool.action!({ action: "form_input", ref: "r3", value: "x" })).toEqual({ operation: "elements.fill", detail: { ref: "r3", value: "x", role: "textbox", name: "Search" } });
  });

  it("needs a screen that can be read, and is a function like any other", () => {
    const { read: _read, ...blind } = fakeScreen();
    expect(() => elementsTool(blind)).toThrow(/has no `read`/);
    const spec = elements(fakeScreen());
    expect(spec.kind).toBe("function");
    expect(spec.native).toBeUndefined();
  });
});

interface Command {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

type Answer = (params: Record<string, unknown>) => Record<string, unknown> | Error;

function fakeBrowser(answers: Record<string, Answer> = {}) {
  const commands: Command[] = [];
  class FakeSocket implements Socket {
    private readonly heard = new Map<string, ((event: { data?: unknown }) => void)[]>();
    constructor(_url: string) {
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
      };
      const answer = answers[command.method]?.(command.params) ?? defaults[command.method] ?? {};
      queueMicrotask(() =>
        this.emit("message", {
          data: JSON.stringify(answer instanceof Error ? { id: command.id, error: { message: answer.message } } : { id: command.id, result: answer }),
        }),
      );
    }
    close(): void {}
  }
  const since = (from: number): [string, Record<string, unknown>][] => commands.slice(from).map((command) => [command.method, command.params]);
  return { WebSocket: FakeSocket, commands, since };
}

const ax = (nodeId: string, role: string, name: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({
  nodeId,
  ignored: false,
  role: { value: role },
  name: { value: name },
  backendDOMNodeId: Number(nodeId) + 100,
  ...more,
});

/** A page as the protocol describes one: layout and pieces of text among what matters. */
const TREE = [
  ax("1", "RootWebArea", "Orders", { childIds: ["2", "3", "9"], properties: [{ name: "focusable", value: { value: true } }] }),
  ax("2", "heading", "Orders", { parentId: "1", childIds: ["20"] }),
  ax("20", "StaticText", "Orders", { parentId: "2", childIds: ["21"] }),
  ax("21", "InlineTextBox", "Orders", { parentId: "20" }),
  ax("3", "generic", "", { parentId: "1", childIds: ["4", "5", "6"] }),
  ax("4", "textbox", "Search", { parentId: "3", value: { value: "shoes" }, properties: [{ name: "focusable", value: { value: true } }, { name: "focused", value: { value: true } }] }),
  ax("5", "button", "Export", { parentId: "3", properties: [{ name: "disabled", value: { value: true } }] }),
  { nodeId: "6", ignored: true, parentId: "3", childIds: ["7"] },
  ax("7", "checkbox", "Paid only", { parentId: "6", properties: [{ name: "checked", value: { value: "true" } }] }),
  ax("9", "paragraph", "", { parentId: "1", childIds: ["10"] }),
  ax("10", "StaticText", "Three orders are waiting.", { parentId: "9" }),
];

describe("a browser page read as elements", () => {
  const ENDPOINT = "ws://127.0.0.1:9222/devtools/browser/abc";
  const open = (answers: Record<string, Answer> = {}) => {
    const browser = fakeBrowser({ "Accessibility.getFullAXTree": () => ({ nodes: TREE }), ...answers });
    return browserScreen({ endpoint: ENDPOINT, WebSocket: browser.WebSocket }).then((screen) => ({ browser, screen, from: browser.commands.length }));
  };

  it("reads the accessibility tree without the layout around it or the pieces inside it", async () => {
    const { screen } = await open();
    expect(await elementsTool(screen).run({ action: "read" })).toBe(
      [
        'page "Orders" [ref_1]',
        '  heading "Orders" [ref_2]',
        '  textbox "Search" = "shoes" (focused) [ref_3]',
        '  button "Export" (disabled) [ref_4]',
        '  checkbox "Paid only" (checked) [ref_5]',
        "  paragraph [ref_6]",
        '    text "Three orders are waiting." [ref_7]',
      ].join("\n"),
    );
  });

  it("gives an element the same reference every time it is read, and reads one part by it", async () => {
    const { screen } = await open();
    const tool = elementsTool(screen);
    await tool.run({ action: "read" });
    expect(await tool.run({ action: "read", filter: "interactive" })).toBe(
      ['textbox "Search" = "shoes" (focused) [ref_3]', 'button "Export" (disabled) [ref_4]', 'checkbox "Paid only" (checked) [ref_5]'].join("\n"),
    );
    expect(await tool.run({ action: "read", ref: "ref_6" })).toBe(['paragraph [ref_6]', '  text "Three orders are waiting." [ref_7]'].join("\n"));
    expect(await tool.run({ action: "read", depth: 1 })).toBe('page "Orders" [ref_1]');
  });

  const there = (node: Record<string, unknown>): Record<string, Answer> => ({
    "Accessibility.getPartialAXTree": () => ({ nodes: [node] }),
    "DOM.getContentQuads": () => ({ quads: [[100, 40, 300, 40, 300, 60, 100, 60]] }),
  });

  it("clicks a reference where its element now is, after bringing it into view", async () => {
    const { browser, screen, from } = await open(there(TREE[6]!));
    const tool = elementsTool(screen, { changes: false });
    await tool.run({ action: "read" });
    const after = browser.commands.length;
    expect(await tool.run({ action: "click", ref: "ref_4" })).toBe('Clicked button "Export" (disabled) [ref_4].');
    expect(from).toBeLessThan(after);
    expect(browser.since(after).map(([method, params]) => [method, params.backendNodeId ?? params.type])).toEqual([
      ["DOM.scrollIntoViewIfNeeded", 105],
      ["Accessibility.getPartialAXTree", 105],
      ["DOM.getContentQuads", 105],
      ["Input.dispatchMouseEvent", "mouseMoved"],
      ["Input.dispatchMouseEvent", "mousePressed"],
      ["Input.dispatchMouseEvent", "mouseReleased"],
    ]);
    expect(browser.since(after)[4]![1]).toMatchObject({ x: 200, y: 50, button: "left" });
  });

  it("refuses a reference whose element has gone, is hidden, or is now something else", async () => {
    const gone = await open({ "DOM.scrollIntoViewIfNeeded": () => new Error("No node with given id found") });
    await elementsTool(gone.screen).run({ action: "read" });
    await expect(gone.screen.locate("ref_4")).rejects.toThrow("ref_4 is no longer on the page (No node with given id found); read the page again");

    const renamed = await open(there(ax("5", "button", "Delete everything")));
    await elementsTool(renamed.screen).run({ action: "read" });
    await expect(renamed.screen.locate("ref_4")).rejects.toThrow('ref_4 is no longer on the page (it is now button "Delete everything"); read the page again');

    const hidden = await open(there({ nodeId: "5", ignored: true, backendDOMNodeId: 105 }));
    await elementsTool(hidden.screen).run({ action: "read" });
    await expect(hidden.screen.locate("ref_4")).rejects.toThrow(/it is hidden/);

    await expect(hidden.screen.locate("ref_404")).rejects.toThrow(/not a reference this page has given/);
  });

  it("fills a field by clicking it, selecting what it holds and typing, and nothing that is not typed into", async () => {
    const { browser, screen } = await open(there(TREE[5]!));
    await elementsTool(screen).run({ action: "read" });
    const after = browser.commands.length;
    await screen.fill("ref_3", "boots");
    expect(browser.since(after).slice(3).map(([method, params]) => [method, params.type ?? params.text, params.commands])).toEqual([
      ["Input.dispatchMouseEvent", "mouseMoved", undefined],
      ["Input.dispatchMouseEvent", "mousePressed", undefined],
      ["Input.dispatchMouseEvent", "mouseReleased", undefined],
      ["Input.dispatchKeyEvent", "rawKeyDown", ["selectAll"]],
      ["Input.dispatchKeyEvent", "keyUp", undefined],
      ["Input.insertText", "boots", undefined],
    ]);

    const button = await open(there(TREE[6]!));
    await elementsTool(button.screen).run({ action: "read" });
    await expect(button.screen.fill("ref_4", "x")).rejects.toThrow(/is a button, which is not typed into/);
  });
});

const CHROMIUM = process.env.PRAECISE_TEST_CHROMIUM;

describe.skipIf(!CHROMIUM)("a real page read as elements", () => {
  const HTML =
    "<title>Orders</title><h1>Orders</h1>" +
    '<label>Name <input id="n" value="old"></label>' +
    "<button onclick=\"document.getElementById('o').textContent='Saved '+document.getElementById('n').value;this.remove()\">Save</button>" +
    '<p id="o">Not saved.</p><div style="height:3000px"></div><a href="#far">Far link</a>';

  it("reads it, fills a field, presses a button, is told what changed, and is refused a reference that has gone", async () => {
    const screen = await browserScreen({
      executable: CHROMIUM!,
      args: ["--no-sandbox"],
      url: `data:text/html,${encodeURIComponent(HTML)}`,
      allow: (url) => url.protocol === "data:",
    });
    try {
      const tool = elementsTool(screen, { settleMs: 200 });
      const read = String(await tool.run({ action: "read" }));
      expect(read).toMatch(/^page "Orders" \[ref_\d+\]/);
      expect(read).toMatch(/heading "Orders" \[ref_\d+\]/);
      expect(read).toMatch(/textbox "Name" = "old" \[ref_\d+\]/);
      expect(read).toContain('text "Not saved."');

      const field = /textbox "Name" = "old" \[(ref_\d+)\]/.exec(read)![1]!;
      const save = /button "Save" \[(ref_\d+)\]/.exec(read)![1]!;
      const filled = String(await tool.run({ action: "fill", ref: field, value: "new name" }));
      expect(filled).toContain('changed: textbox "Name" = "new name" (focused)');

      const clicked = String(await tool.run({ action: "click", ref: save }));
      expect(clicked).toContain(`Clicked button "Save" [${save}].`);
      expect(clicked).toContain(`gone: button "Save" [${save}]`);
      expect(await tool.run({ action: "text" })).toContain("Saved new name");

      await expect(tool.run({ action: "click", ref: save })).rejects.toThrow(/is no longer on the page/);

      const far = /link "Far link" \[(ref_\d+)\]/.exec(String(await tool.run({ action: "find", query: "far link" })))![1]!;
      expect(await tool.run({ action: "scroll_to", ref: far })).toMatch(/is in view at \[\d+, \d+\]/);
      expect(await tool.run({ action: "click", ref: far })).toContain('Clicked link "Far link"');

      await tool.run({ action: "fill", ref: field, value: "" });
      expect(String(await tool.run({ action: "read", filter: "interactive" }))).toMatch(/textbox "Name" (\(focused\) )?\[ref_\d+\]/);
    } finally {
      await screen.close();
    }
  }, 60_000);
});
