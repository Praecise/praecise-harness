/**
 * The dev surface. Server-rendered HTML with inline styles and vanilla script —
 * no build step, no assets to serve, nothing to install. It is an instrument
 * panel rather than a product page: dark, monospaced where it matters, and
 * honest about what the runtime actually did on every answer.
 */

import type { App } from "../app.js";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CSS = `
*, *::before, *::after { box-sizing: border-box; }
:root {
  --void: #0b0b0d; --panel: #101013; --edge: #222227;
  --bone: #ededef; --fog: #8e8e96; --dim: #54545c;
  --pulse: #64f0dc; --ember: #ff4e1a;
  --sans: Archivo, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
html, body { margin: 0; height: 100%; }
body {
  background: var(--void); color: var(--bone);
  font: 400 15px/1.55 var(--sans);
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-decoration: none; }
h1, h2, h3 { font-weight: 600; letter-spacing: -0.01em; margin: 0; }
.mono { font-family: var(--mono); font-size: 12px; letter-spacing: 0.02em; }
.shell { display: grid; grid-template-columns: 236px 1fr; min-height: 100%; }
.rail {
  border-right: 1px solid var(--edge); background: var(--panel);
  padding: 20px 0; display: flex; flex-direction: column; gap: 22px;
}
.brand { padding: 0 20px; }
.brand .name { font-size: 14px; font-weight: 600; }
.brand .sub { color: var(--dim); font-family: var(--mono); font-size: 11px; margin-top: 2px; }
.group { display: flex; flex-direction: column; }
.group h3 {
  padding: 0 20px 8px; color: var(--dim); font-family: var(--mono);
  font-size: 10px; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase;
}
.group a {
  padding: 6px 20px; color: var(--fog); font-size: 13px;
  border-left: 2px solid transparent;
}
.group a:hover { color: var(--bone); background: #16161a; }
.group a.on { color: var(--bone); border-left-color: var(--pulse); background: #16161a; }
.group .none { padding: 2px 20px 0; color: var(--dim); font-size: 12px; }
.main { padding: 32px 40px 56px; max-width: 900px; }
.head { border-bottom: 1px solid var(--edge); padding-bottom: 18px; margin-bottom: 24px; }
.head h1 { font-size: 22px; }
.head p { color: var(--fog); margin: 6px 0 0; font-size: 14px; }
.row {
  display: flex; align-items: baseline; gap: 14px;
  padding: 12px 0; border-bottom: 1px solid var(--edge);
}
.row .k { font-family: var(--mono); font-size: 12px; color: var(--bone); min-width: 150px; }
.row .v { color: var(--fog); font-size: 13px; flex: 1; }
.tag {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--dim);
  border: 1px solid var(--edge); border-radius: 2px; padding: 2px 6px;
}
.warn {
  border-left: 2px solid var(--ember); background: #16100d;
  padding: 12px 16px; margin-bottom: 24px;
}
.warn h3 { color: var(--ember); font-family: var(--mono); font-size: 11px;
  letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 6px; }
.warn li { color: var(--fog); font-size: 13px; }
.warn ul { margin: 0; padding-left: 18px; }
.warn > div { white-space: pre-wrap; }
pre.block {
  background: var(--panel); border: 1px solid var(--edge); border-radius: 3px;
  padding: 12px 14px; overflow-x: auto; font-family: var(--mono);
  font-size: 12px; color: var(--fog); margin: 0;
}
.chat { display: flex; flex-direction: column; height: 100vh; }
.chat .head { padding: 24px 40px 18px; margin: 0; }
.log { flex: 1; overflow-y: auto; padding: 24px 40px; }
.turn { max-width: 720px; margin-bottom: 22px; }
.turn .who {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--dim); margin-bottom: 6px;
}
.turn.you .who { color: var(--fog); }
.turn.bot .who { color: var(--pulse); }
.turn .body { white-space: pre-wrap; word-wrap: break-word; }
.turn .meta {
  margin-top: 8px; font-family: var(--mono); font-size: 11px; color: var(--dim);
  display: flex; gap: 14px; flex-wrap: wrap;
}
.turn.err .body { color: var(--ember); }
.composer { border-top: 1px solid var(--edge); padding: 16px 40px 24px; background: var(--panel); }
.composer form { display: flex; gap: 12px; align-items: flex-end; max-width: 720px; }
textarea, input[type=text] {
  flex: 1; background: var(--void); color: var(--bone);
  border: 1px solid var(--edge); border-radius: 3px; padding: 10px 12px;
  font: 400 14px/1.5 var(--sans); resize: none;
}
textarea:focus, input:focus { outline: none; border-color: var(--dim); }
button {
  background: var(--pulse); color: var(--void); border: 0; border-radius: 3px;
  padding: 10px 18px; font: 600 13px var(--sans); cursor: pointer;
}
button:disabled { background: var(--edge); color: var(--dim); cursor: default; }
button.ghost { background: transparent; color: var(--fog); border: 1px solid var(--edge); }
button.ghost:hover { color: var(--bone); border-color: var(--dim); }
.field { margin-bottom: 14px; max-width: 560px; }
.field label { display: block; font-family: var(--mono); font-size: 11px;
  color: var(--fog); margin-bottom: 5px; }
.field input { width: 100%; }
.event { display: flex; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--edge);
  font-family: var(--mono); font-size: 12px; }
.event .s { color: var(--bone); min-width: 200px; }
.event .kind { color: var(--dim); min-width: 70px; }
.event .d { color: var(--fog); flex: 1; }
.dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.dot.running { background: var(--pulse); }
.dot.waiting { background: var(--ember); }
.dot.done { background: var(--dim); }
.dot.failed { background: var(--ember); }
`;

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const LIVE_RELOAD = `
new EventSource("/_dev/reload").onmessage = () => location.reload();
`;

interface PageOptions {
  app: App;
  title: string;
  active?: string;
  body: string;
  script?: string;
  full?: boolean;
}

function rail(app: App, active?: string): string {
  const link = (href: string, label: string) =>
    `<a href="${href}" class="${active === href ? "on" : ""}">${escapeHtml(label)}</a>`;

  const agents = app.agentNames.length
    ? app.agentNames.map((n) => link(`/${n}`, n)).join("")
    : `<div class="none">none yet</div>`;
  const workflows = app.workflowNames.length
    ? app.workflowNames.map((n) => link(`/w/${n}`, n)).join("")
    : `<div class="none">none yet</div>`;

  return `<nav class="rail">
  <div class="brand">
    <a href="/"><div class="name">${escapeHtml(app.name)}</div></a>
    <div class="sub">praecise dev</div>
  </div>
  <div class="group"><h3>Agents</h3>${agents}</div>
  <div class="group"><h3>Workflows</h3>${workflows}</div>
</nav>`;
}

export function page(options: PageOptions): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${CSS}</style>
</head><body>
<div class="shell">
${rail(options.app, options.active)}
${options.full ? options.body : `<main class="main">${options.body}</main>`}
</div>
${options.script ? `<script>${options.script}</script>` : ""}
<script>${LIVE_RELOAD}</script>
</body></html>`;
}

export function dashboard(app: App, port: number): string {
  const problems = app.problems;
  const warn = problems.length
    ? `<div class="warn"><h3>Needs attention</h3><ul>${problems
        .map((p) => `<li>${escapeHtml(p)}</li>`)
        .join("")}</ul></div>`
    : "";

  const agents = app.agentNames
    .map((name) => {
      const plan = app.plans[name]!;
      const models = plan.rungs.map((r) => `${r.provider}/${r.model}`).join(" → ") || "no model";
      return `<div class="row">
        <a class="k" href="/${name}">${escapeHtml(name)}</a>
        <div class="v">${escapeHtml(plan.description)}</div>
        <span class="tag">${escapeHtml(plan.quality)}</span>
      </div>
      <div class="row" style="border:0;padding:0 0 12px">
        <div class="k"></div><div class="v mono" style="color:var(--dim)">${escapeHtml(models)}</div>
      </div>`;
    })
    .join("");

  const workflows = app.workflowNames
    .map((name) => {
      const spec = app.project.workflows[name]!;
      return `<div class="row">
        <a class="k" href="/w/${name}">${escapeHtml(name)}</a>
        <div class="v">${escapeHtml(spec.description ?? count(spec.steps.length, "step"))}</div>
        <span class="tag">${spec.steps.length} steps</span>
      </div>`;
    })
    .join("");

  const body = `
<div class="head">
  <h1>${escapeHtml(app.name)}</h1>
  <p>${count(app.agentNames.length, "agent")} · ${count(app.workflowNames.length, "workflow")} ·
     ${count(app.project.knowledge.length, "knowledge file")}</p>
</div>
${warn}
${agents ? `<h2 style="font-size:13px;color:var(--fog);margin-bottom:4px">Agents</h2>${agents}` : ""}
${workflows ? `<h2 style="font-size:13px;color:var(--fog);margin:28px 0 4px">Workflows</h2>${workflows}` : ""}
${
  !agents && !workflows
    ? `<p style="color:var(--fog)">Nothing loaded yet. Create <span class="mono">agents/support.ts</span>:</p>
<pre class="block">import { agent } from "praecise";

export default agent({
  role: "Customer support for Acme",
  knows: ["memory/*.md"],
});</pre>`
    : ""
}
<h2 style="font-size:13px;color:var(--fog);margin:32px 0 8px">Endpoints</h2>
<pre class="block">POST http://localhost:${port}/api/agents/&lt;name&gt;      {"input": "..."}
POST http://localhost:${port}/api/workflows/&lt;name&gt;   {"input": {...}}
POST http://localhost:${port}/mcp                    JSON-RPC (agents + workflows as tools)</pre>`;

  return page({ app, title: app.name, active: "/", body });
}

export function chat(app: App, name: string): string {
  const plan = app.plans[name]!;
  const greeting = plan.greeting ?? `Ask ${name} something.`;
  const problems = plan.problems.length
    ? `<div class="warn" style="margin:16px 40px 0"><h3>Needs attention</h3><ul>${plan.problems
        .map((p) => `<li>${escapeHtml(p)}</li>`)
        .join("")}</ul></div>`
    : "";

  const body = `<main class="chat">
  <div class="head">
    <h1>${escapeHtml(name)}</h1>
    <p>${escapeHtml(plan.description)}</p>
  </div>
  ${problems}
  <div class="log" id="log">
    <div class="turn bot"><div class="who">${escapeHtml(name)}</div>
      <div class="body">${escapeHtml(greeting)}</div></div>
  </div>
  <div class="composer">
    <form id="f">
      <textarea id="q" rows="2" placeholder="Message ${escapeHtml(name)}…" autofocus></textarea>
      <button id="send" type="submit">Send</button>
    </form>
  </div>
</main>`;

  const script = `
const agent = ${JSON.stringify(name)};
const log = document.getElementById("log");
const form = document.getElementById("f");
const box = document.getElementById("q");
const send = document.getElementById("send");
const history = [];

function turn(who, cls, text) {
  const el = document.createElement("div");
  el.className = "turn " + cls;
  const w = document.createElement("div"); w.className = "who"; w.textContent = who;
  const b = document.createElement("div"); b.className = "body"; b.textContent = text;
  el.append(w, b);
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return { el, body: b };
}

function meta(el, answer) {
  const m = document.createElement("div");
  m.className = "meta";
  const bits = [];
  if (answer.path && answer.path.length) bits.push(answer.path.join(" → "));
  if (typeof answer.confidence === "number") bits.push("confidence " + answer.confidence.toFixed(2));
  if (answer.toolCalls && answer.toolCalls.length)
    bits.push(answer.toolCalls.map((t) => t.name).join(", "));
  if (answer.harness) bits.push(answer.harness);
  for (const bit of bits) {
    const s = document.createElement("span"); s.textContent = bit; m.append(s);
  }
  el.append(m);
  for (const note of answer.notes || []) {
    const n = document.createElement("div");
    n.className = "meta"; n.style.color = "var(--ember)"; n.textContent = note;
    el.append(n);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = box.value.trim();
  if (!input) return;
  box.value = ""; send.disabled = true;
  turn("you", "you", input);
  const pending = turn(agent, "bot", "…");
  try {
    const res = await fetch("/api/agents/" + agent, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input, history }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    pending.body.textContent = data.text;
    meta(pending.el, data);
    history.push({ role: "user", content: input });
    history.push({ role: "assistant", content: data.text });
  } catch (err) {
    pending.el.className = "turn err";
    pending.body.textContent = String(err.message || err);
  } finally {
    send.disabled = false; box.focus();
    log.scrollTop = log.scrollHeight;
  }
});

box.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});
`;

  return page({ app, title: `${name} · ${app.name}`, active: `/${name}`, body, script, full: true });
}

export function workflowPage(app: App, name: string): string {
  const spec = app.project.workflows[name]!;
  const inputs = Object.entries(spec.input ?? {});
  const fields = inputs.length
    ? inputs
        .map(
          ([key, hint]) => `<div class="field">
        <label for="in-${escapeHtml(key)}">${escapeHtml(key)} — ${escapeHtml(hint)}</label>
        <input type="text" id="in-${escapeHtml(key)}" data-key="${escapeHtml(key)}">
      </div>`,
        )
        .join("")
    : `<p style="color:var(--fog);font-size:13px">This workflow takes no declared input.</p>`;

  const steps = spec.steps
    .map((step) => {
      const kind = "ask" in step ? "ask" : "use" in step ? "use" : "approve" in step
        ? "approve" : "each" in step ? "each" : "when";
      return `<div class="event"><span class="s">${escapeHtml(step.id)}</span>
        <span class="kind">${kind}</span></div>`;
    })
    .join("");

  const body = `
<div class="head">
  <h1>${escapeHtml(name)}</h1>
  <p>${escapeHtml(spec.description ?? count(spec.steps.length, "step"))}</p>
</div>
<form id="f">${fields}
  <button type="submit" id="go">Run</button>
</form>
<h2 style="font-size:13px;color:var(--fog);margin:32px 0 4px">Steps</h2>
${steps}
<div id="out" style="margin-top:32px"></div>`;

  const script = `
const workflow = ${JSON.stringify(name)};
const form = document.getElementById("f");
const out = document.getElementById("out");
const go = document.getElementById("go");
let current = null;

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function render(run) {
  current = run;
  out.textContent = "";
  const head = h("div", "row");
  head.append(h("span", "dot " + run.status), h("div", "k", run.id), h("div", "v", run.status));
  out.append(head);

  for (const event of run.events) {
    const row = h("div", "event");
    row.append(h("span", "s", event.step), h("span", "kind", event.kind),
      h("span", "d", event.detail || ""));
    out.append(row);
  }

  if (run.status === "waiting" && run.waitingFor) {
    const box = h("div", "warn");
    box.append(h("h3", null, "Approval needed"), h("div", null, run.waitingFor.prompt));
    const bar = h("div"); bar.style.marginTop = "12px"; bar.style.display = "flex"; bar.style.gap = "8px";
    const yes = h("button", null, "Approve");
    const no = h("button", "ghost", "Reject");
    yes.onclick = () => decide(true);
    no.onclick = () => decide(false);
    bar.append(yes, no); box.append(bar); out.append(box);
  }

  if (run.status === "done" || run.status === "failed") {
    const pre = h("pre", "block",
      run.error || (typeof run.result === "string" ? run.result : JSON.stringify(run.result, null, 2)));
    pre.style.marginTop = "16px";
    out.append(pre);
  }
}

async function post(url, payload) {
  go.disabled = true;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    render(data);
  } catch (err) {
    out.textContent = "";
    const box = h("div", "warn"); box.append(h("h3", null, "Failed"), h("div", null, String(err.message || err)));
    out.append(box);
  } finally {
    go.disabled = false;
  }
}

function decide(approved) {
  post("/api/runs/" + encodeURIComponent(current.id), { approved });
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = {};
  for (const el of form.querySelectorAll("input[data-key]")) input[el.dataset.key] = el.value;
  out.textContent = "";
  out.append(h("div", "row", "running…"));
  post("/api/workflows/" + workflow, { input });
});
`;

  return page({ app, title: `${name} · ${app.name}`, active: `/w/${name}`, body, script });
}

export function notFound(app: App, what: string): string {
  return page({
    app,
    title: "not found",
    body: `<div class="head"><h1>Not found</h1><p>${escapeHtml(what)}</p></div>
    <p style="color:var(--fog)"><a href="/" style="color:var(--pulse)">Back to the dashboard</a></p>`,
  });
}
