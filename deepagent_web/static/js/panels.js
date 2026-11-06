// Transcript, plan (todos), virtual filesystem and inspector panels.

import { agentsDfs } from "./store.js";
import { agentColor, argSummary, esc, fmtMs, fmtNum, h, lineDiff, md, prettyJson, toolIcon, truncate } from "./util.js";

const chip = (state, agentId) => {
  const a = state.agents.get(agentId);
  const name = a?.name ?? "agent";
  return `<span class="chip" style="--c:${agentColor(name)}" data-select="agent:${esc(agentId)}">${esc(name)}</span>`;
};

const statusIcon = (st) => ({ running: `<span class="spin"></span>`, done: "✓", error: "✕", cancelled: "■" })[st] ?? "";

function clip(text, n = 1500) {
  text = String(text ?? "");
  if (text.length <= n) return `<pre>${esc(text)}</pre>`;
  return `<details class="more"><summary><pre>${esc(text.slice(0, n))}…</pre><span class="show-more">show all ${fmtNum(text.length)} chars</span></summary><pre>${esc(text)}</pre></details>`;
}

// ------------------------------------------------------------------ transcript

export class TranscriptView {
  constructor(el, { onSelect }) {
    this.el = el;
    this.list = h("div", { class: "tx-list" });
    this.filter = "all";
    this.entries = new Map();
    el.append(this.list);
    el.addEventListener("click", (e) => {
      const sel = e.target.closest("[data-select]");
      if (sel) {
        const [kind, ...rest] = sel.dataset.select.split(":");
        onSelect?.({ kind, id: rest.join(":") });
        return;
      }
      const entry = e.target.closest(".tx-entry");
      if (entry && !e.target.closest("details, pre, a")) onSelect?.({ kind: entry.dataset.kind, id: entry.dataset.id });
    });
  }

  setFilter(f) {
    this.filter = f;
    this.list.replaceChildren();
    this.entries.clear();
    this.last && this.render(this.last);
  }

  #rows(state) {
    const rows = [];
    for (const a of state.agents.values()) {
      if (a.parent) rows.push({ key: `spawn:${a.id}`, t: a.start, agent: a.parent, kind: "spawn", a });
      for (const iid of a.items) {
        const it = state.items.get(iid);
        if (it && !(it.kind === "tool" && it.name === "task")) rows.push({ key: iid, t: it.start, agent: a.id, kind: it.kind, it });
      }
      if (a.end != null && a.parent) rows.push({ key: `end:${a.id}`, t: a.end, agent: a.id, kind: "agentend", a });
    }
    if (state.run.status !== "running" && state.run.status !== "idle")
      rows.push({ key: "final", t: state.run.end ?? state.now, agent: "root", kind: "final" });
    rows.sort((x, y) => x.t - y.t);
    if (this.filter === "all") return rows;
    return rows.filter((r) => r.agent === this.filter || r.a?.id === this.filter);
  }

  #html(row, state) {
    const now = state.now;
    if (row.kind === "spawn") {
      return `<div class="tx-marker">${chip(state, row.agent)} spawned ${chip(state, row.a.id)} <span class="muted">${esc(truncate(row.a.description, 140))}</span></div>`;
    }
    if (row.kind === "agentend") {
      return `<div class="tx-marker">${statusIcon(row.a.status)} ${chip(state, row.a.id)} finished in ${fmtMs(row.a.end - row.a.start)}</div>`;
    }
    if (row.kind === "final") {
      const r = state.run;
      if (r.status === "error")
        return `<div class="tx-final error"><div class="tx-h">Run failed</div><pre>${esc(r.error)}</pre>${r.traceback ? `<details><summary>traceback</summary><pre>${esc(r.traceback)}</pre></details>` : ""}</div>`;
      return `<div class="tx-final"><div class="tx-h">Final answer · ${esc(r.status)}</div><div class="md">${md(r.final || "(no text)")}</div></div>`;
    }
    const it = row.it;
    const dur = fmtMs((it.end ?? now) - it.start);
    if (it.kind === "llm") {
      const usage = it.usage ? ` · ${fmtNum(it.usage.input_tokens)} in / ${fmtNum(it.usage.output_tokens)} out` : "";
      const calls = it.toolCalls
        .map((tc) => `<span class="callchip" data-select="tool:${esc(tc.id)}">${toolIcon(tc.name)} ${esc(tc.name)} <span class="muted">${esc(argSummary(tc.name, tc.args))}</span></span>`)
        .join("");
      return `<div class="tx-h">${chip(state, it.agent)} <span class="kind">◆ model call ${it.index}</span> <span class="muted">${dur}${usage}</span> ${statusIcon(it.status)}</div>
        ${it.reasoning ? `<details class="reasoning"><summary>reasoning</summary><pre>${esc(it.reasoning)}</pre></details>` : ""}
        ${it.text ? `<div class="md">${md(it.text)}${it.status === "running" ? `<span class="cursor"></span>` : ""}</div>` : it.status === "running" ? `<div class="muted">thinking…</div>` : ""}
        ${it.error ? `<pre class="err">${esc(it.error)}</pre>` : ""}
        ${calls ? `<div class="calls">${calls}</div>` : ""}`;
    }
    return `<div class="tx-h">${chip(state, it.agent)} <span class="kind">${toolIcon(it.name)} ${esc(it.name)}</span> <span class="muted">${esc(argSummary(it.name, it.args))} · ${dur}</span> ${statusIcon(it.status)}</div>
      <details class="args"><summary>arguments</summary><pre>${esc(prettyJson(it.args))}</pre></details>
      ${it.status !== "running" ? `<div class="out ${it.status}">${clip(it.output, 600)}</div>` : ""}`;
  }

  render(state) {
    this.last = state;
    const rows = this.#rows(state);
    const nearBottom = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 80;
    const keep = new Set();
    let prev = null;
    for (const row of rows) {
      keep.add(row.key);
      let el = this.entries.get(row.key);
      if (!el) {
        el = h("div", { class: `tx-entry tx-${row.kind}` });
        el.dataset.kind = row.kind === "spawn" || row.kind === "agentend" ? "agent" : row.kind;
        el.dataset.id = row.it?.id ?? row.a?.id ?? "root";
        this.entries.set(row.key, el);
      }
      const color = agentColor(state.agents.get(row.agent)?.name);
      el.style.setProperty("--c", color);
      el.style.marginLeft = `${(state.agents.get(row.agent)?.depth ?? 0) * 18}px`;
      const html = this.#html(row, state);
      if (el._html !== html) {
        // Preserve <details> open state across re-renders.
        const open = [...el.querySelectorAll("details")].map((d) => d.open);
        el.innerHTML = html;
        el.querySelectorAll("details").forEach((d, i) => (d.open = open[i] ?? false));
        el._html = html;
      }
      el.classList.toggle("selected", this.selected === el.dataset.id);
      const expectedNext = prev ? prev.nextSibling : this.list.firstChild;
      if (expectedNext !== el) this.list.insertBefore(el, expectedNext);
      prev = el;
    }
    for (const [k, el] of this.entries) if (!keep.has(k)) el.remove(), this.entries.delete(k);
    if (!rows.length) this.list.innerHTML = `<div class="empty">Events will appear here as the agent works.</div>`;
    else this.list.querySelector(".empty")?.remove();
    if (nearBottom && this.follow !== false) this.el.scrollTop = this.el.scrollHeight;
  }

  select(id) {
    this.selected = id;
    for (const el of this.entries.values()) el.classList.toggle("selected", el.dataset.id === id);
  }

  scrollTo(id) {
    const el = [...this.entries.values()].find((e) => e.dataset.id === id);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

// ------------------------------------------------------------------ todos

const TODO_ICON = { pending: "○", in_progress: "◐", completed: "●" };

export function renderTodos(el, state) {
  const groups = agentsDfs(state).filter((a) => state.todos.has(a.id));
  if (!groups.length) {
    setHtml(el, `<div class="empty">No plan yet. Todos appear when an agent calls <code>write_todos</code>.</div>`);
    return;
  }
  const html = groups
    .map((a) => {
      const entry = state.todos.get(a.id);
      const todos = entry.todos;
      const done = todos.filter((t) => t.status === "completed").length;
      const prev = new Map((entry.prev || []).map((t) => [t.content, t.status]));
      const items = todos
        .map((t) => {
          const changed = prev.size && prev.get(t.content) !== t.status;
          return `<li class="todo ${esc(t.status)} ${changed ? "changed" : ""}"><span class="ti">${TODO_ICON[t.status] ?? "○"}</span><span>${esc(t.content)}</span></li>`;
        })
        .join("");
      return `<div class="todo-group">
        <div class="todo-head">${chip(state, a.id)}<span class="muted">${done}/${todos.length} · v${entry.history.length} · ${fmtMs(entry.t)}</span></div>
        <div class="progress"><div style="width:${todos.length ? (done / todos.length) * 100 : 0}%;background:${agentColor(a.name)}"></div></div>
        <ul>${items}</ul>
      </div>`;
    })
    .join("");
  setHtml(el, html);
}

// ------------------------------------------------------------------ files

export function renderFiles(el, state, { onOpen }) {
  const files = [...state.files.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (!files.length) {
    setHtml(el, `<div class="empty">The virtual filesystem is empty.</div>`);
    return;
  }
  const recent = state.lastChange?.kind === "file" ? state.lastChange.id : null;
  const html = `<ul class="files">${files
    .map((f) => {
      const last = f.history.at(-1);
      const depth = f.path.split("/").length - 2;
      const name = f.path.split("/").pop();
      const dir = f.path.slice(0, f.path.length - name.length);
      const color = agentColor(state.agents.get(last?.agent)?.name);
      const size = f.content ? `${fmtNum(f.content.length)} B` : "";
      return `<li class="file ${f.deleted ? "deleted" : ""} ${recent === f.path ? "recent" : ""}" data-path="${esc(f.path)}" title="${esc(f.path)}">
        <span class="fi">${f.deleted ? "✕" : "▢"}</span>
        <span class="fpath" style="padding-left:${Math.max(0, depth) * 4}px"><span class="muted">${esc(dir)}</span>${esc(name)}</span>
        <span class="fmeta">${f.history.length > 1 ? `v${f.history.length} · ` : ""}${size}</span>
        <span class="fdot" style="background:${color}"></span>
      </li>`;
    })
    .join("")}</ul>`;
  if (setHtml(el, html)) {
    el.querySelectorAll(".file").forEach((li) => li.addEventListener("click", () => onOpen(li.dataset.path)));
  }
}

export function openFileViewer(dialog, state, path) {
  const f = state.files.get(path);
  if (!f) return;
  let version = f.history.length - 1;
  let mode = "content";
  const draw = () => {
    const v = f.history[version];
    const prevV = f.history[version - 1];
    const a = state.agents.get(v?.agent);
    const body =
      v?.content == null
        ? `<div class="empty">File deleted in this version.</div>`
        : mode === "diff"
          ? `<pre class="diff">${lineDiff(prevV?.content ?? "", v.content)
              .map((l) => `<span class="dl ${l.op}">${l.op === "add" ? "+" : l.op === "del" ? "-" : " "} ${esc(l.t)}</span>`)
              .join("\n")}</pre>`
          : `<pre class="code">${v.content
              .split("\n")
              .map((l, i) => `<span class="ln">${i + 1}</span>${esc(l)}`)
              .join("\n")}</pre>`;
    dialog.innerHTML = `<form method="dialog" class="dlg">
      <header><strong>${esc(path)}</strong>
        <span class="muted">version ${version + 1}/${f.history.length} · written by ${chip(state, v?.agent)} at ${fmtMs(v?.t)}</span>
        <span class="spacer"></span>
        <button type="button" data-v="-1" ${version === 0 ? "disabled" : ""}>◀</button>
        <button type="button" data-v="1" ${version === f.history.length - 1 ? "disabled" : ""}>▶</button>
        <span class="seg"><button type="button" data-m="content" class="${mode === "content" ? "on" : ""}">Content</button><button type="button" data-m="diff" class="${mode === "diff" ? "on" : ""}">Diff</button></span>
        <button value="close" class="close">✕</button>
      </header>
      <div class="dlg-body">${body}</div>
      <footer class="muted">${a ? `${esc(a.name)}` : ""}</footer>
    </form>`;
    dialog.querySelectorAll("[data-v]").forEach((b) =>
      b.addEventListener("click", () => {
        version = Math.min(f.history.length - 1, Math.max(0, version + +b.dataset.v));
        draw();
      }),
    );
    dialog.querySelectorAll("[data-m]").forEach((b) =>
      b.addEventListener("click", () => {
        mode = b.dataset.m;
        draw();
      }),
    );
  };
  draw();
  if (!dialog.open) dialog.showModal();
}

// ------------------------------------------------------------------ inspector

export function renderInspector(el, state, sel) {
  let html = "";
  if (!sel || sel.kind === "final" || (sel.kind === "agent" && !state.agents.has(sel.id))) {
    const r = state.run;
    html = `<div class="insp-title">Run</div>
      <dl>
        <dt>Status</dt><dd><span class="status st-${esc(r.status)}">${esc(r.status)}</span></dd>
        <dt>Agent</dt><dd>${esc(r.agentName || "–")}</dd>
        <dt>Model</dt><dd>${esc(r.model || "(agent default)")}</dd>
        <dt>Duration</dt><dd>${fmtMs(r.end ?? state.now)}</dd>
      </dl>
      <div class="insp-sec">Prompt</div><div class="md">${md(r.prompt || "–")}</div>
      ${r.final ? `<div class="insp-sec">Final answer</div><div class="md">${md(r.final)}</div>` : ""}
      ${r.error ? `<div class="insp-sec">Error</div><pre class="err">${esc(r.error)}</pre>` : ""}
      <p class="hint">Click any node, bar or transcript entry to inspect it.</p>`;
  } else if (sel.kind === "agent") {
    const a = state.agents.get(sel.id);
    const parent = a.parent ? state.agents.get(a.parent) : null;
    html = `<div class="insp-title">${chip(state, a.id)} ${a.parent ? "subagent" : "main agent"}</div>
      <dl>
        <dt>Status</dt><dd><span class="status st-${esc(a.status)}">${esc(a.status)}</span></dd>
        ${parent ? `<dt>Spawned by</dt><dd>${chip(state, parent.id)} via <a data-select="tool:${esc(a.id)}">task call</a></dd>` : ""}
        <dt>Started</dt><dd>${fmtMs(a.start)}</dd>
        <dt>Duration</dt><dd>${fmtMs((a.end ?? state.now) - a.start)}</dd>
        <dt>Model calls</dt><dd>${a.llmCount}</dd>
        <dt>Tool calls</dt><dd>${a.toolCount}</dd>
        <dt>Tokens</dt><dd>${fmtNum(a.inTok)} in / ${fmtNum(a.outTok)} out</dd>
        ${a.children.length ? `<dt>Subagents</dt><dd>${a.children.map((c) => chip(state, c)).join(" ")}</dd>` : ""}
      </dl>
      <div class="insp-sec">${a.parent ? "Task" : "Prompt"}</div><div class="md">${md(a.description)}</div>
      ${a.output ? `<div class="insp-sec">Result</div><div class="md">${md(a.output)}</div>` : ""}`;
  } else {
    const it = state.items.get(sel.id);
    if (!it) html = `<div class="empty">Not reached yet at this point of the replay.</div>`;
    else if (it.kind === "llm") {
      html = `<div class="insp-title">${chip(state, it.agent)} ◆ model call ${it.index}</div>
        <dl>
          <dt>Status</dt><dd><span class="status st-${esc(it.status)}">${esc(it.status)}</span></dd>
          <dt>Model</dt><dd>${esc(it.model || "–")}</dd>
          <dt>Started</dt><dd>${fmtMs(it.start)}</dd>
          <dt>Latency</dt><dd>${fmtMs((it.end ?? state.now) - it.start)}</dd>
          <dt>Input msgs</dt><dd>${it.nMessages ?? "–"}</dd>
          <dt>Tokens</dt><dd>${it.usage ? `${fmtNum(it.usage.input_tokens)} in / ${fmtNum(it.usage.output_tokens)} out` : "–"}</dd>
        </dl>
        ${it.reasoning ? `<div class="insp-sec">Reasoning</div><pre>${esc(it.reasoning)}</pre>` : ""}
        <div class="insp-sec">Output</div><div class="md">${md(it.text || "(no text)")}</div>
        ${it.error ? `<pre class="err">${esc(it.error)}</pre>` : ""}
        ${it.toolCalls.length ? `<div class="insp-sec">Tool calls</div>${it.toolCalls.map((tc) => `<div class="callchip block" data-select="tool:${esc(tc.id)}">${toolIcon(tc.name)} ${esc(tc.name)}<pre>${esc(prettyJson(tc.args))}</pre></div>`).join("")}` : ""}`;
    } else {
      const child = it.childAgent ? state.agents.get(it.childAgent) : null;
      html = `<div class="insp-title">${chip(state, it.agent)} ${toolIcon(it.name)} ${esc(it.name)}</div>
        <dl>
          <dt>Status</dt><dd><span class="status st-${esc(it.status)}">${esc(it.status)}</span></dd>
          <dt>Call id</dt><dd><code>${esc(it.id)}</code></dd>
          <dt>Started</dt><dd>${fmtMs(it.start)}</dd>
          <dt>Duration</dt><dd>${fmtMs((it.end ?? state.now) - it.start)}</dd>
          ${it.llm ? `<dt>Requested by</dt><dd><a data-select="llm:${esc(it.llm)}">model call ${state.items.get(it.llm)?.index ?? ""}</a></dd>` : ""}
          ${child ? `<dt>Subagent</dt><dd>${chip(state, child.id)}</dd>` : ""}
        </dl>
        <div class="insp-sec">Arguments</div><pre>${esc(prettyJson(it.args))}</pre>
        <div class="insp-sec">Output</div>${it.status === "running" ? `<div class="muted">running…</div>` : `<div class="out ${it.status}">${clip(it.output, 4000)}</div>`}`;
    }
  }
  setHtml(el, html);
}

// Only touch the DOM when the markup actually changed. Returns true if updated.
function setHtml(el, html) {
  if (el._html === html) return false;
  el.innerHTML = html;
  el._html = html;
  return true;
}

export function bindSelectLinks(root, onSelect) {
  root.addEventListener("click", (e) => {
    const sel = e.target.closest("[data-select]");
    if (!sel) return;
    e.preventDefault();
    const [kind, ...rest] = sel.dataset.select.split(":");
    onSelect({ kind, id: rest.join(":") });
  });
}

