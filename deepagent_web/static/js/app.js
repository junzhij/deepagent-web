// App shell: run controls, run history, SSE streaming, replay player, wiring.

import { GraphView } from "./graph.js";
import { TranscriptView, bindSelectLinks, openFileViewer, renderFiles, renderInspector, renderTodos } from "./panels.js";
import { MILESTONES, agentsDfs, apply, describeEvent, emptyState } from "./store.js";
import { TimelineView } from "./timeline.js";
import { $, $$, esc, fmtMs, fmtNum, resetColors, truncate } from "./util.js";

const EXAMPLES = [
  "Compare vector databases for retrieval-augmented generation",
  "What are the trade-offs of WebAssembly on the server?",
  "Summarise the current state of solid-state batteries",
];

const app = {
  events: [],
  meta: null, // run summary
  runId: null,
  cursor: 0,
  live: true,
  playing: false,
  speed: 1,
  state: emptyState(),
  selection: null,
  es: null,
  lastEventWall: 0,
  tab: "graph",
  config: null,
};

const graph = new GraphView($("#graph"), { onSelect: select });
const timeline = new TimelineView($("#timeline"), { onSelect: select });
const transcript = new TranscriptView($("#transcript"), { onSelect: select });
bindSelectLinks($("#inspector"), select);
bindSelectLinks($("#todos"), select);
bindSelectLinks($("#file-dialog"), (s) => {
  $("#file-dialog").close();
  select(s);
});

// ------------------------------------------------------------------ helpers

function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {}
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.json();
}

// ------------------------------------------------------------------ state & render

function computeState() {
  if (app.cursor < app.state.applied) {
    app.state = emptyState();
  }
  for (let i = app.state.applied; i < app.cursor; i++) apply(app.state, app.events[i]);
  return app.state;
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const st = computeState();
  // While following a live run, let running bars grow with wall-clock time.
  if (app.live && st.run.status === "running" && app.lastEventWall) {
    st.now = Math.max(st.now, (app.events.at(-1)?.t ?? 0) + (performance.now() - app.lastEventWall));
  }
  $("#welcome").hidden = app.events.length > 0;
  if (app.tab === "graph") graph.render(st);
  if (app.tab === "timeline") timeline.render(st);
  if (app.tab === "transcript") transcript.render(st);
  renderTodos($("#todos"), st);
  renderFiles($("#files"), st, { onOpen: (p) => openFileViewer($("#file-dialog"), app.state, p) });
  $("#file-count").textContent = st.files.size ? `${st.files.size} file${st.files.size > 1 ? "s" : ""}` : "";
  renderInspector($("#inspector"), st, app.selection);
  renderStats(st);
  renderPlayer(st);
  renderFilterOptions(st);
}

function renderStats(st) {
  const r = st.run;
  const el = $("#statbar");
  if (!app.events.length) {
    el.innerHTML = `<span class="muted">No run selected.</span>`;
    return;
  }
  el.innerHTML = `
    <span class="status st-${esc(r.status)}">${esc(r.status)}</span>
    <span class="prompt" title="${esc(r.prompt)}">${esc(truncate(r.prompt, 90))}</span>
    <span class="spacer"></span>
    <span class="stat"><b>${st.agents.size}</b> agents</span>
    <span class="stat"><b>${st.totals.llm}</b> model calls</span>
    <span class="stat"><b>${st.totals.tools}</b> tool calls</span>
    <span class="stat"><b>${fmtNum(st.totals.inTok + st.totals.outTok)}</b> tokens</span>
    <span class="stat"><b>${fmtMs(r.end ?? st.now)}</b></span>
    ${r.model ? `<span class="stat model">${esc(r.model)}</span>` : ""}`;
}

function renderPlayer(st) {
  const slider = $("#p-slider");
  slider.max = app.events.length;
  slider.value = app.cursor;
  const ev = app.events[app.cursor - 1];
  $("#p-label").textContent = app.events.length
    ? `${app.cursor}/${app.events.length} · ${fmtMs(ev?.t ?? 0)} · ${ev ? describeEvent(ev, st) : "start"}`
    : "–";
  $("#p-play").textContent = app.playing ? "❚❚" : "▶";
  // Whether the *run* is still in progress (not the replayed state at the cursor).
  const lastEv = app.events.at(-1);
  const running = app.meta ? app.meta.status === "running" : !!lastEv && lastEv.type !== "run_end";
  const liveBtn = $("#p-live");
  liveBtn.classList.toggle("on", app.live && app.cursor === app.events.length);
  liveBtn.classList.toggle("running", running);
  liveBtn.textContent = running ? "● LIVE" : "⇥ END";
  $("#stop-btn").hidden = !(running && app.runId);
  $("#run-btn").disabled = false;
}

function renderFilterOptions(st) {
  const sel = $("#agent-filter");
  const opts = agentsDfs(st);
  const sig = opts.map((a) => a.id).join("|");
  if (sel._sig === sig) return;
  sel._sig = sig;
  const cur = sel.value;
  sel.innerHTML = `<option value="all">All agents</option>${opts
    .map((a) => `<option value="${esc(a.id)}">${"  ".repeat(a.depth)}${esc(a.name)}${a.id === "root" ? " (main)" : ""}</option>`)
    .join("")}`;
  sel.value = opts.some((a) => a.id === cur) ? cur : "all";
}

function select(sel) {
  if (sel?.kind === "spawn" || sel?.kind === "agentend") sel = { kind: "agent", id: sel.id };
  app.selection = sel;
  graph.selectedKind = sel?.kind;
  graph.select(sel?.id);
  timeline.select(sel?.id);
  transcript.select(sel?.id);
  scheduleRender();
}

// ------------------------------------------------------------------ runs

function resetView() {
  stopPlayback();
  app.es?.close();
  app.es = null;
  app.events = [];
  app.cursor = 0;
  app.state = emptyState();
  app.selection = null;
  app.live = true;
  resetColors();
  graph.collapsed.clear();
  graph.resetFollow();
  transcript.setFilter("all");
}

async function openRun(id) {
  resetView();
  app.runId = id;
  location.hash = `run=${encodeURIComponent(id)}`;
  highlightRun();
  try {
    const summary = (await api("/api/runs")).find((r) => r.id === id);
    app.meta = summary ?? null;
    if (summary && summary.status !== "running") {
      const data = await api(`/api/runs/${encodeURIComponent(id)}`);
      app.events = data.events;
      app.meta = data.run;
      app.cursor = app.events.length;
      app.live = false;
      scheduleRender();
      requestAnimationFrame(() => graph.fit());
      return;
    }
  } catch (e) {
    toast(`Could not load run: ${e.message}`);
    return;
  }
  // Live: replay everything so far, then follow.
  const es = new EventSource(`/api/runs/${encodeURIComponent(id)}/stream`);
  app.es = es;
  es.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    if (ev.seq < app.events.length) return; // duplicate after reconnect
    app.events.push(ev);
    app.lastEventWall = performance.now();
    if (app.live) app.cursor = app.events.length;
    if (ev.type === "run_end" && app.meta) {
      app.meta.status = ev.status;
      loadRunList();
    }
    scheduleRender();
  };
  es.addEventListener("end", () => {
    es.close();
    const last = app.events.at(-1);
    if (app.meta && last?.type === "run_end") app.meta.status = last.status;
    scheduleRender();
  });
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) toast("Lost connection to the server.");
  };
}

async function startRun(e) {
  e.preventDefault();
  const prompt = $("#prompt-input").value.trim();
  if (!prompt) return;
  const agent = $("#agent-select").value;
  const model = $("#model-input").value.trim() || "demo";
  $("#run-btn").disabled = true;
  try {
    const run = await api("/api/runs", { method: "POST", body: JSON.stringify({ prompt, agent, model }) });
    localStorage.setItem("dav:model", model);
    localStorage.setItem("dav:agent", agent);
    await loadRunList();
    await openRun(run.id);
  } catch (err) {
    toast(err.message, 6000);
  } finally {
    $("#run-btn").disabled = false;
  }
}

async function loadRunList() {
  let runs = [];
  try {
    runs = await api("/api/runs");
  } catch {
    return;
  }
  const ul = $("#run-list");
  if (!runs.length) {
    ul.innerHTML = `<li class="empty small">No runs yet.</li>`;
    return;
  }
  ul.innerHTML = runs
    .map(
      (r) => `<li data-id="${esc(r.id)}" class="run-item">
        <span class="status-dot st-${esc(r.status)}"></span>
        <div class="ri-main"><div class="ri-prompt">${esc(truncate(r.prompt, 60))}</div>
        <div class="ri-meta muted">${new Date((r.created ?? 0) * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" })} · ${esc(r.model || r.agent_name || "")}</div></div>
        <button class="icon del" title="Delete run" data-del="${esc(r.id)}">✕</button>
      </li>`,
    )
    .join("");
  highlightRun();
}

function highlightRun() {
  $$("#run-list .run-item").forEach((li) => li.classList.toggle("on", li.dataset.id === app.runId));
}

// ------------------------------------------------------------------ player

function seek(n, { live = false } = {}) {
  app.cursor = Math.max(0, Math.min(app.events.length, n));
  app.live = live;
  scheduleRender();
}

function step(dir) {
  stopPlayback();
  let i = app.cursor;
  do i += dir;
  while (i > 0 && i < app.events.length && !MILESTONES.has(app.events[i - 1].type));
  seek(i);
}

let rafId = null;
function startPlayback() {
  if (!app.events.length) return;
  if (app.cursor >= app.events.length) seek(0);
  app.playing = true;
  app.live = false;
  let playT = app.events[app.cursor - 1]?.t ?? 0;
  let last = performance.now();
  const tick = (now) => {
    if (!app.playing) return;
    playT += (now - last) * app.speed;
    last = now;
    const next = app.events[app.cursor];
    if (next && next.t - playT > 1500) playT = next.t - 300; // skip long idle gaps
    while (app.cursor < app.events.length && app.events[app.cursor].t <= playT) app.cursor++;
    if (app.cursor >= app.events.length) {
      // Reached the end: hand over to live-follow if the run is still going.
      app.playing = false;
      app.live = app.meta?.status === "running";
    }
    scheduleRender();
    if (app.playing) rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
  scheduleRender();
}

function stopPlayback() {
  app.playing = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

// ------------------------------------------------------------------ import / export

function exportRun() {
  if (!app.events.length) return toast("Nothing to export yet.");
  const data = { version: 1, run: app.meta ?? { id: app.runId, prompt: app.state.run.prompt }, events: app.events };
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `deepagent-run-${app.runId ?? "imported"}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importRun(file) {
  try {
    const data = JSON.parse(await file.text());
    const events = Array.isArray(data) ? data : data.events;
    if (!Array.isArray(events)) throw new Error("expected {events: [...]}");
    resetView();
    app.runId = null;
    app.meta = data.run ?? null;
    app.events = events;
    app.cursor = 0;
    app.live = false;
    history.replaceState(null, "", location.pathname);
    highlightRun();
    scheduleRender();
    toast(`Imported ${events.length} events. Press ▶ to replay.`);
  } catch (e) {
    toast(`Import failed: ${e.message}`, 6000);
  }
}

// ------------------------------------------------------------------ wiring

function setTab(tab) {
  app.tab = tab;
  $$(".tabs [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $$(".view").forEach((v) => (v.hidden = v.dataset.view !== tab));
  $$(".tab-tools").forEach((t) => (t.hidden = t.dataset.for !== tab));
  render();
  if (tab === "graph" && graph.follow) graph.fit();
}

$("#run-form").addEventListener("submit", startRun);
$("#stop-btn").addEventListener("click", async () => {
  if (app.runId) await api(`/api/runs/${encodeURIComponent(app.runId)}/cancel`, { method: "POST" }).catch((e) => toast(e.message));
});
$("#run-list").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    try {
      await api(`/api/runs/${encodeURIComponent(del.dataset.del)}`, { method: "DELETE" });
      if (app.runId === del.dataset.del) {
        resetView();
        app.runId = null;
        app.meta = null;
        history.replaceState(null, "", location.pathname);
        render();
      }
      loadRunList();
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  const li = e.target.closest(".run-item");
  if (li) openRun(li.dataset.id);
});
$("#refresh-runs").addEventListener("click", loadRunList);
$$(".tabs [data-tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
$("#turns-toggle").addEventListener("change", (e) => {
  graph.showTurns = e.target.checked;
  graph.follow = true;
  render();
});
$("#zoom-in").addEventListener("click", () => graph.zoom(1.25));
$("#zoom-out").addEventListener("click", () => graph.zoom(0.8));
$("#fit-btn").addEventListener("click", () => graph.resetFollow());
$("#agent-filter").addEventListener("change", (e) => {
  transcript.setFilter(e.target.value);
  render();
});
$("#insp-clear").addEventListener("click", () => select(null));
$("#p-slider").addEventListener("input", (e) => {
  stopPlayback();
  seek(+e.target.value);
});
$("#p-play").addEventListener("click", () => (app.playing ? stopPlayback() : startPlayback(), scheduleRender()));
$("#p-prev").addEventListener("click", () => step(-1));
$("#p-next").addEventListener("click", () => step(1));
$("#p-start").addEventListener("click", () => (stopPlayback(), seek(0)));
$("#p-end").addEventListener("click", () => (stopPlayback(), seek(app.events.length, { live: true })));
$("#p-live").addEventListener("click", () => (stopPlayback(), seek(app.events.length, { live: true })));
$("#p-speed").addEventListener("change", (e) => (app.speed = +e.target.value));
$("#export-btn").addEventListener("click", exportRun);
$("#import-btn").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", (e) => e.target.files[0] && importRun(e.target.files[0]));
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) importRun(f);
});
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select, dialog")) return;
  if (e.key === " ") (e.preventDefault(), app.playing ? stopPlayback() : startPlayback(), scheduleRender());
  else if (e.key === "ArrowRight") step(1);
  else if (e.key === "ArrowLeft") step(-1);
  else if (e.key === "Home") seek(0);
  else if (e.key === "End" || e.key === "l") seek(app.events.length, { live: true });
  else if (e.key === "f") graph.resetFollow();
  else if (e.key === "1") setTab("graph");
  else if (e.key === "2") setTab("timeline");
  else if (e.key === "3") setTab("transcript");
  else if (e.key === "Escape") select(null);
});
window.addEventListener("resize", () => {
  if (graph.follow) graph.fit();
  scheduleRender();
});
// Keep durations of running items ticking while live.
setInterval(() => {
  if (app.live && app.state.run.status === "running") scheduleRender();
}, 250);

async function init() {
  try {
    app.config = await api("/api/config");
  } catch (e) {
    toast(`Server not reachable: ${e.message}`);
    return;
  }
  const agentSel = $("#agent-select");
  agentSel.innerHTML = app.config.agents
    .map((a) => `<option value="${esc(a.id)}" title="${esc(a.description)}">${esc(a.name)}</option>`)
    .join("");
  agentSel.value = localStorage.getItem("dav:agent") ?? "demo";
  if (!agentSel.value) agentSel.value = "demo";
  $("#model-list").innerHTML = app.config.models
    .map((m) => `<option value="${esc(m.id)}">${esc(m.label)}${m.available ? "" : ` (needs ${esc(m.env)})`}</option>`)
    .join("");
  $("#model-input").value = localStorage.getItem("dav:model") ?? "demo";
  $("#examples").innerHTML = EXAMPLES.map((x) => `<button type="button" class="example">${esc(x)}</button>`).join("");
  $$("#examples .example").forEach((b) =>
    b.addEventListener("click", () => {
      $("#prompt-input").value = b.textContent;
      $("#run-form").requestSubmit();
    }),
  );
  await loadRunList();
  const m = location.hash.match(/run=([^&]+)/);
  if (m) openRun(decodeURIComponent(m[1]));
  render();
}

init();
