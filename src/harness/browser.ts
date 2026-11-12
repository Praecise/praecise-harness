/**
 * A browser as a screen, over the Chrome DevTools Protocol.
 *
 * The one `Screen` the framework ships, and it ships with nothing: the protocol is JSON
 * over a WebSocket, Node has had a WebSocket since 22, and the browser is one the app
 * already has and points to by path. No driver package, no bundled browser, no download
 * on install.
 *
 * A model working this screen sees what a page renders and nothing of how it is built:
 * no DOM, no selectors, no script evaluated in the page. That is the point of computer
 * use — the same vocabulary works on a canvas, a PDF viewer and a login form — and it is
 * also a line worth holding. Everything a model can do here it does through the pointer
 * and the keyboard, where the guard can see it.
 *
 * Coordinates are CSS pixels of the page, which the protocol's input events take and its
 * screenshots are made in once the device scale factor is pinned to one, as it is here.
 *
 * The protocol has no command for "the user typed this". Text is entered with
 * `Input.insertText`, which the protocol marks experimental and which every driver built
 * on it has relied on for years; a line break in it is pressed as Enter.
 */

import { spawn as spawnProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Button, Point, Region, Screen } from "./computer.js";
import type { Attachment } from "./types.js";

/** As much of a WebSocket as this needs. Node's own satisfies it, and so does a test's stand-in. */
export interface Socket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void;
}

export type SocketConstructor = new (url: string) => Socket;

/** As much of a child process as this needs. */
export interface Launched {
  stderr: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  on(event: "exit" | "error", listener: (detail: unknown) => void): unknown;
  kill(): unknown;
}

export interface BrowserScreenOptions {
  /** The path to a Chromium-family browser to start. The framework ships none and guesses at none. */
  executable?: string;
  /**
   * The DevTools WebSocket of a browser that is already running, instead of starting
   * one: `ws://127.0.0.1:9222/devtools/browser/<id>`. It is left running on `close()`.
   */
  endpoint?: string;
  /** The size of the page, which is the size of every screenshot. Default 1280 by 800. */
  width?: number;
  height?: number;
  /** The page to start on. Default a blank one. */
  url?: string;
  /** Run without a window. Default true. */
  headless?: boolean;
  /** Further arguments for the browser, when one is started. */
  args?: string[];
  /** Milliseconds to wait for the browser to start, a page to load, or a command to answer. Default 30,000. */
  timeoutMs?: number;
  /**
   * Whether an address may be gone to with `open`. Default: `http:` and `https:` only. A
   * model that can type an address can ask for `file:///etc/passwd`, so the door is
   * narrow unless the app widens it.
   */
  allow?: (url: URL) => boolean;
  /** The WebSocket to use. Default Node's own. */
  WebSocket?: SocketConstructor;
  /** How the browser is started. Default `child_process.spawn`. */
  spawn?: (command: string, args: string[]) => Launched;
}

/** A browser as a screen: everything `Screen` asks for, and the optional finer controls too. */
export type BrowserScreen = Required<Screen>;

interface Pending {
  resolve(value: Record<string, unknown>): void;
  reject(reason: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** The protocol's own framing: numbered commands out, their answers and unnumbered events back. */
class Connection {
  private next = 1;
  private readonly waiting = new Map<number, Pending>();
  private readonly listeners = new Set<(method: string, session: string | undefined) => void>();
  private closed: Error | undefined;
  private readonly socket: Socket;
  private readonly timeoutMs: number;

  private constructor(socket: Socket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    socket.addEventListener("message", (event) => this.receive(event.data));
    const lost = (): void => this.fail(new Error("the connection to the browser closed"));
    socket.addEventListener("close", lost);
    socket.addEventListener("error", lost);
  }

  static open(make: SocketConstructor, url: string, timeoutMs: number): Promise<Connection> {
    return new Promise((resolve, reject) => {
      let socket: Socket;
      try {
        socket = new make(url);
      } catch (err) {
        return reject(err as Error);
      }
      const timer = setTimeout(() => reject(new Error(`the browser at ${url} did not accept a connection in time`)), timeoutMs);
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`could not connect to the browser at ${url}`));
      });
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new Connection(socket, timeoutMs));
      });
    });
  }

  private receive(data: unknown): void {
    let message: { id?: number; method?: string; sessionId?: string; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      message = JSON.parse(typeof data === "string" ? data : String(data)) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      if (message.method) for (const listener of this.listeners) listener(message.method, message.sessionId);
      return;
    }
    const pending = this.waiting.get(message.id);
    if (!pending) return;
    this.waiting.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message ?? "the browser refused the command"));
    else pending.resolve(message.result ?? {});
  }

  private fail(reason: Error): void {
    this.closed ??= reason;
    for (const pending of this.waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.waiting.clear();
  }

  send(method: string, params: Record<string, unknown> = {}, session?: string): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`the browser did not answer ${method} in time`));
      }, this.timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
      } catch (err) {
        this.waiting.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  /** Resolves when an event arrives, or after a while without one: a page that never finishes loading is still a page. */
  event(method: string, session: string, withinMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.listeners.delete(heard);
        resolve();
      };
      const heard = (name: string, from: string | undefined): void => {
        if (name === method && from === session) done();
      };
      const timer = setTimeout(done, withinMs);
      this.listeners.add(heard);
    });
  }

  close(): void {
    this.fail(new Error("the browser screen was closed"));
    try {
      this.socket.close();
    } catch {
      // Already gone.
    }
  }
}

/** The protocol's bit for each key that is held rather than pressed. */
const HELD: Record<string, { bit: number; key: string; code: string; vk: number }> = {
  alt: { bit: 1, key: "Alt", code: "AltLeft", vk: 18 },
  ctrl: { bit: 2, key: "Control", code: "ControlLeft", vk: 17 },
  control: { bit: 2, key: "Control", code: "ControlLeft", vk: 17 },
  meta: { bit: 4, key: "Meta", code: "MetaLeft", vk: 91 },
  super: { bit: 4, key: "Meta", code: "MetaLeft", vk: 91 },
  cmd: { bit: 4, key: "Meta", code: "MetaLeft", vk: 91 },
  command: { bit: 4, key: "Meta", code: "MetaLeft", vk: 91 },
  win: { bit: 4, key: "Meta", code: "MetaLeft", vk: 91 },
  shift: { bit: 8, key: "Shift", code: "ShiftLeft", vk: 16 },
};

/** Keys with a name, by every name a model is likely to use for them: the DOM's and the X11 ones. */
const NAMED: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  kp_enter: { key: "Enter", code: "NumpadEnter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  insert: { key: "Insert", code: "Insert", vk: 45 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  page_up: { key: "PageUp", code: "PageUp", vk: 33 },
  prior: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  page_down: { key: "PageDown", code: "PageDown", vk: 34 },
  next: { key: "PageDown", code: "PageDown", vk: 34 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
};

interface Chord {
  modifiers: number;
  held: (typeof HELD)[string][];
  key: { key: string; code?: string; vk?: number; text?: string };
}

/** A key or chord as the protocol needs it: `"ctrl+shift+t"`, `"Return"`, `"F5"`, `"a"`. */
export function chordOf(combo: string): Chord {
  const parts = combo.split("+").map((part) => part.trim()).filter(Boolean);
  // A lone "+" is the key itself, and so is the one after "ctrl+".
  if (!parts.length || combo.trim().endsWith("+")) parts.push("+");
  const last = parts.pop()!;
  const held = parts.map((part) => HELD[part.toLowerCase()] ?? fail(`"${part}" in "${combo}" is not a key that can be held`));
  const modifiers = held.reduce((bits, each) => bits | each.bit, 0);
  const lower = last.toLowerCase();

  // A modifier pressed on its own.
  const alone = HELD[lower];
  if (alone) return { modifiers: modifiers | alone.bit, held, key: { key: alone.key, code: alone.code, vk: alone.vk } };

  const named = NAMED[lower];
  if (named) return { modifiers, held, key: named };

  const fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower);
  if (fn) return { modifiers, held, key: { key: `F${fn[1]}`, code: `F${fn[1]}`, vk: 111 + Number(fn[1]) } };

  if ([...last].length !== 1) fail(`"${last}" in "${combo}" is not a key this screen knows`);
  // Shift makes a letter its capital, as a keyboard does.
  const shifted = (modifiers & 8) !== 0;
  const char = shifted ? last.toUpperCase() : last;
  // With ctrl, alt or meta down a key is a command rather than a character, and enters none.
  const text = modifiers & 7 ? undefined : char;
  if (/^[a-z]$/i.test(last)) return { modifiers, held, key: { key: char, code: `Key${last.toUpperCase()}`, vk: last.toUpperCase().charCodeAt(0), text } };
  if (/^[0-9]$/.test(last)) return { modifiers, held, key: { key: last, code: `Digit${last}`, vk: last.charCodeAt(0), text } };
  return { modifiers, held, key: { key: char, text } };
}

function fail(message: string): never {
  throw new Error(message);
}

const BUTTONS: Record<Button, number> = { left: 1, right: 2, middle: 4 };

/** How far one click of the wheel moves a page, in its pixels. */
const WHEEL = 100;

/** How much a region may be enlarged by when it is zoomed into. */
const MAX_ZOOM = 4;

const bitsOf = (modifiers: readonly string[]): number =>
  modifiers.reduce((bits, name) => bits | (HELD[name.toLowerCase()]?.bit ?? fail(`"${name}" is not a key that can be held`)), 0);

/** Start a browser and find where it is listening, from the line it writes when it is ready. */
async function launch(options: BrowserScreenOptions, width: number, height: number, timeoutMs: number): Promise<{ url: string; stop(): Promise<void> }> {
  const executable = options.executable ?? fail("a browser screen needs `executable`, the path to a Chromium-family browser, or `endpoint`, one that is already running");
  // A profile of its own, so nothing a model does reaches the profile of whoever is at the machine.
  const profile = await mkdtemp(join(tmpdir(), "praecise-browser-"));
  const start = options.spawn ?? ((command: string, args: string[]) => spawnProcess(command, args, { stdio: ["ignore", "ignore", "pipe"] }) as unknown as Launched);
  const child = start(executable, [
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${width},${height}`,
    ...(options.headless === false ? [] : ["--headless=new"]),
    ...(options.args ?? []),
    "about:blank",
  ]);
  const stop = async (): Promise<void> => {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  };

  try {
    const url = await new Promise<string>((resolve, reject) => {
      let said = "";
      const timer = setTimeout(() => reject(new Error(`the browser at ${executable} did not say where it is listening in time`)), timeoutMs);
      const done = (settle: () => void): void => {
        clearTimeout(timer);
        settle();
      };
      child.stderr?.on("data", (chunk) => {
        said = `${said}${String(chunk)}`.slice(-4_000);
        const found = /DevTools listening on (ws:\/\/\S+)/.exec(said);
        if (found) done(() => resolve(found[1]!));
      });
      child.on("error", (err) => done(() => reject(new Error(`could not start the browser at ${executable}: ${(err as Error)?.message ?? String(err)}`))));
      child.on("exit", (code) => done(() => reject(new Error(`the browser at ${executable} exited (${String(code)}) before it was ready: ${said.trim().slice(-300)}`))));
    });
    return { url, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/**
 * A browser page to look at and work.
 *
 *     const screen = await browserScreen({ executable: "/usr/bin/chromium", url: "https://example.com" });
 *     // functions/computer.ts:  export default computer(screen);
 *     await screen.close();
 */
export async function browserScreen(options: BrowserScreenOptions = {}): Promise<BrowserScreen> {
  const width = Math.max(1, Math.round(options.width ?? 1280));
  const height = Math.max(1, Math.round(options.height ?? 800));
  const timeoutMs = options.timeoutMs ?? 30_000;
  const make = options.WebSocket ?? (globalThis.WebSocket as unknown as SocketConstructor | undefined) ?? fail("this runtime has no WebSocket; pass one as `WebSocket`");
  const allow = options.allow ?? ((url: URL) => url.protocol === "http:" || url.protocol === "https:");

  const started = options.endpoint ? undefined : await launch(options, width, height, timeoutMs);
  let connection: Connection | undefined;
  try {
    connection = await Connection.open(make, options.endpoint ?? started!.url, timeoutMs);
    const browser = connection;

    // The page a fresh browser opened with, or a new one where it has none.
    const { targetInfos } = (await browser.send("Target.getTargets")) as { targetInfos?: { targetId: string; type: string }[] };
    const page =
      targetInfos?.find((target) => target.type === "page")?.targetId ??
      String((await browser.send("Target.createTarget", { url: "about:blank" })).targetId);
    const session = String((await browser.send("Target.attachToTarget", { targetId: page, flatten: true })).sessionId);
    const send = (method: string, params: Record<string, unknown> = {}) => browser.send(method, params, session);

    await send("Page.enable");
    // One device pixel to one page pixel, so a position in a screenshot is a position on the page.
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

    const at: Point = { x: 0, y: 0 };
    /** Buttons that are down, as the protocol's bit field. */
    let down = 0;

    const mouse = (type: string, more: Record<string, unknown> = {}) =>
      send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, buttons: down, ...more });

    const goto = async (address: string): Promise<void> => {
      let url: URL;
      try {
        url = new URL(address);
      } catch {
        return fail(`"${address}" is not an address; give the whole of it, starting with https://`);
      }
      if (!allow(url)) fail(`this screen does not open ${url.protocol} addresses`);
      const loaded = browser.event("Page.loadEventFired", session, Math.min(timeoutMs, 15_000));
      const went = await send("Page.navigate", { url: url.href });
      if (typeof went.errorText === "string" && went.errorText) fail(`could not open ${url.href}: ${went.errorText}`);
      await loaded;
    };

    const keys = async (chord: Chord, press: () => Promise<void>): Promise<void> => {
      let bits = 0;
      for (const each of chord.held) {
        bits |= each.bit;
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: bits, key: each.key, code: each.code, windowsVirtualKeyCode: each.vk });
      }
      try {
        await press();
      } finally {
        for (const each of [...chord.held].reverse()) {
          bits &= ~each.bit;
          await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: bits, key: each.key, code: each.code, windowsVirtualKeyCode: each.vk });
        }
      }
    };
    const stroke = (chord: Chord, type: "down" | "up"): Promise<unknown> =>
      send("Input.dispatchKeyEvent", {
        // A key that enters a character is a keyDown carrying it; one that does not is raw.
        type: type === "up" ? "keyUp" : chord.key.text ? "keyDown" : "rawKeyDown",
        modifiers: chord.modifiers,
        key: chord.key.key,
        ...(chord.key.code ? { code: chord.key.code } : {}),
        ...(chord.key.vk ? { windowsVirtualKeyCode: chord.key.vk } : {}),
        ...(type === "down" && chord.key.text ? { text: chord.key.text, unmodifiedText: chord.key.text } : {}),
      });

    const screen: BrowserScreen = {
      width,
      height,

      async screenshot(region?: Region): Promise<Attachment> {
        const clip = region
          ? {
              ...region,
              // Enlarged to fill the screen's own size, and no further than is still a picture of something.
              scale: Math.max(1, Math.min(MAX_ZOOM, width / region.width, height / region.height)),
            }
          : undefined;
        const shot = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
        if (typeof shot.data !== "string" || !shot.data) fail("the browser returned no picture");
        return { mime: "image/png", data: shot.data, name: region ? "zoom.png" : "screenshot.png" };
      },

      async move(to: Point): Promise<void> {
        Object.assign(at, to);
        await mouse("mouseMoved");
      },

      async click(where: Point, { button, count, modifiers }): Promise<void> {
        const held = bitsOf(modifiers);
        Object.assign(at, where);
        await mouse("mouseMoved", { modifiers: held });
        // Each press says which click of the run it is; that count is what makes a double click one.
        for (let nth = 1; nth <= count; nth++) {
          await mouse("mousePressed", { button, buttons: down | BUTTONS[button], clickCount: nth, modifiers: held });
          await mouse("mouseReleased", { button, clickCount: nth, modifiers: held });
        }
      },

      async drag(from: Point, to: Point, modifiers: string[]): Promise<void> {
        const held = bitsOf(modifiers);
        Object.assign(at, from);
        await mouse("mouseMoved", { modifiers: held });
        down |= BUTTONS.left;
        await mouse("mousePressed", { button: "left", clickCount: 1, modifiers: held });
        try {
          // By way of the middle: a page that starts a drag on movement needs to see some.
          Object.assign(at, { x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) });
          await mouse("mouseMoved", { button: "left", modifiers: held });
          Object.assign(at, to);
          await mouse("mouseMoved", { button: "left", modifiers: held });
        } finally {
          down &= ~BUTTONS.left;
          await mouse("mouseReleased", { button: "left", clickCount: 1, modifiers: held });
        }
      },

      async scroll(where: Point, by: { dx: number; dy: number }, modifiers: string[]): Promise<void> {
        Object.assign(at, where);
        await mouse("mouseWheel", { deltaX: by.dx * WHEEL, deltaY: by.dy * WHEEL, modifiers: bitsOf(modifiers) });
      },

      async type(text: string): Promise<void> {
        const lines = text.replace(/\r\n?/g, "\n").split("\n");
        for (const [nth, line] of lines.entries()) {
          if (nth > 0) await screen.key("Enter");
          if (line) await send("Input.insertText", { text: line });
        }
      },

      async key(combo: string): Promise<void> {
        const chord = chordOf(combo);
        await keys(chord, async () => {
          await stroke(chord, "down");
          await stroke(chord, "up");
        });
      },

      async hold(combo: string, seconds: number, signal?: AbortSignal): Promise<void> {
        const chord = chordOf(combo);
        await keys(chord, async () => {
          await stroke(chord, "down");
          try {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, Math.max(0, seconds) * 1000);
              signal?.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
            });
          } finally {
            await stroke(chord, "up");
          }
        });
      },

      async cursor(): Promise<Point> {
        return { ...at };
      },

      async press(button: Button): Promise<void> {
        down |= BUTTONS[button];
        await mouse("mousePressed", { button, clickCount: 1 });
      },

      async release(button: Button): Promise<void> {
        down &= ~BUTTONS[button];
        await mouse("mouseReleased", { button, clickCount: 1 });
      },

      open: goto,

      async close(): Promise<void> {
        // A browser this started is this one's to stop; one it was pointed at is not.
        if (started) await browser.send("Browser.close").catch(() => undefined);
        browser.close();
        await started?.stop();
      },
    };

    if (options.url) await goto(options.url);
    return screen;
  } catch (err) {
    connection?.close();
    await started?.stop();
    throw err;
  }
}
