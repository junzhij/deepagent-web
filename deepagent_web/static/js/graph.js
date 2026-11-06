// Agent tree: main agent → (model turns) → tool calls → subagents → … laid out
// left-to-right as a tidy tree in pan/zoomable SVG. Nodes are keyed, so updates
// mutate existing elements and new nodes animate in once.

import { agentColor, argSummary, esc, fmtMs, fmtNum, s, toolIcon, truncate } from "./util.js";

const DIM = { agent: [230, 62], llm: [180, 44], tool: [220, 44] };
const HGAP = 56;
const VGAP = 10;

export class GraphView {
  constructor(svg, { onSelect }) {
    this.svg = svg;
    this.onSelect = onSelect;
    this.root = s("g", { class: "viewport" });
    this.edgeLayer = s("g", { class: "edges" });
    this.nodeLayer = s("g", { class: "nodes" });
    this.root.append(this.edgeLayer, this.nodeLayer);
    svg.append(this.root);
    this.nodes = new Map();
    this.edges = new Map();
    this.view = { x: 40, y: 40, k: 1 };
    this.follow = true; // auto-fit until the user pans/zooms
    this.showTurns = true;
    this.collapsed = new Set();
    this.selected = null;
    this.bounds = { w: 0, h: 0 };
    this.#bindPanZoom();
  }

  #bindPanZoom() {
    let drag = null;
    this.svg.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".gnode")) return;
      drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
      this.svg.setPointerCapture(e.pointerId);
      this.svg.classList.add("panning");
    });
    this.svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      this.follow = false;
      this.view.x = drag.vx + (e.clientX - drag.x);
      this.view.y = drag.vy + (e.clientY - drag.y);
      this.#applyView();
    });
    const end = () => {
      drag = null;
      this.svg.classList.remove("panning");
    };
    this.svg.addEventListener("pointerup", end);
    this.svg.addEventListener("pointercancel", end);
    this.svg.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.follow = false;
        const rect = this.svg.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
        const k = Math.min(2.5, Math.max(0.15, this.view.k * factor));
        this.view.x = mx - ((mx - this.view.x) * k) / this.view.k;
        this.view.y = my - ((my - this.view.y) * k) / this.view.k;
        this.view.k = k;
        this.#applyView();
      },
      { passive: false },
    );
  }

  #applyView() {
    const { x, y, k } = this.view;
    this.root.setAttribute("transform", `translate(${x},${y}) scale(${k})`);
  }

  zoom(factor) {
    const rect = this.svg.getBoundingClientRect();
    const mx = rect.width / 2;
    const my = rect.height / 2;
    const k = Math.min(2.5, Math.max(0.15, this.view.k * factor));
    this.view.x = mx - ((mx - this.view.x) * k) / this.view.k;
    this.view.y = my - ((my - this.view.y) * k) / this.view.k;
    this.view.k = k;
    this.follow = false;
    this.#applyView();
  }

  fit() {
    const rect = this.svg.getBoundingClientRect();
    if (!rect.width || !this.bounds.w) return;
    const pad = 32;
    const k = Math.min(1.1, (rect.width - pad * 2) / this.bounds.w, (rect.height - pad * 2) / this.bounds.h);
    this.view.k = Math.max(0.15, k);
    this.view.x = pad;
    this.view.y = Math.max(pad, (rect.height - this.bounds.h * this.view.k) / 2);
    this.#applyView();
  }

  resetFollow() {
    this.follow = true;
    this.fit();
  }

  // ---------------------------------------------------------------- model → tree

  #tree(state) {
    const mk = (kind, id, children = []) => ({ kind, id, children, w: DIM[kind][0], h: DIM[kind][1] });
    const agentNode = (aid) => {
      const a = state.agents.get(aid);
      const node = mk("agent", aid);
      if (!a || this.collapsed.has(aid)) return node;
      for (const iid of a.items) {
        const it = state.items.get(iid);
        if (!it) continue;
        if (this.showTurns) {
          if (it.kind === "llm") node.children.push(llmNode(it));
          else if (!it.llm || !state.items.has(it.llm)) node.children.push(toolNode(it));
        } else if (it.kind === "tool") node.children.push(toolNode(it));
      }
      return node;
    };
    const llmNode = (it) => mk("llm", it.id, it.tools.map((t) => state.items.get(t)).filter(Boolean).map(toolNode));
    const toolNode = (it) => mk("tool", it.id, it.childAgent && state.agents.has(it.childAgent) ? [agentNode(it.childAgent)] : []);
    return state.agents.has("root") ? agentNode("root") : null;
  }

  #layout(node, x, y) {
    node.x = x;
    if (!node.children.length) {
      node.y = y;
      return node.h;
    }
    let cy = y;
    for (const c of node.children) cy += this.#layout(c, x + node.w + HGAP, cy) + VGAP;
    const total = Math.max(node.h, cy - y - VGAP);
    const first = node.children[0];
    const last = node.children.at(-1);
    node.y = (first.y + first.h / 2 + last.y + last.h / 2) / 2 - node.h / 2;
    if (node.y < y) node.y = y;
    return total;
  }

  // ---------------------------------------------------------------- render

  render(state) {
    const tree = this.#tree(state);
    const seen = new Set();
    const seenEdges = new Set();
    let maxX = 0;
    let maxY = 0;
    if (tree) {
      this.#layout(tree, 0, 0);
      const walk = (n, parent) => {
        n.key = `${n.kind}:${n.id}`;
        seen.add(n.key);
        maxX = Math.max(maxX, n.x + n.w);
        maxY = Math.max(maxY, n.y + n.h);
        this.#upsertNode(n, state);
        if (parent) {
          const key = `${parent.key}->${n.key}`;
          seenEdges.add(key);
          this.#upsertEdge(key, parent, n, state);
        }
        for (const c of n.children) walk(c, n);
      };
      walk(tree, null);
    }
    for (const [id, el] of this.nodes) if (!seen.has(id)) el.remove(), this.nodes.delete(id);
    for (const [id, el] of this.edges) if (!seenEdges.has(id)) el.remove(), this.edges.delete(id);
    this.bounds = { w: maxX, h: maxY };
    if (this.follow) this.fit();
    else this.#applyView();
  }

  #status(state, n) {
    if (n.kind === "agent") return state.agents.get(n.id)?.status ?? "running";
    return state.items.get(n.id)?.status ?? "running";
  }

  #upsertEdge(key, p, c, state) {
    const x1 = p.x + p.w;
    const y1 = p.y + p.h / 2;
    const x2 = c.x;
    const y2 = c.y + c.h / 2;
    const mx = (x1 + x2) / 2;
    const d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    let el = this.edges.get(key);
    if (!el) {
      el = s("path", { class: "edge" });
      this.edgeLayer.append(el);
      this.edges.set(key, el);
    }
    el.setAttribute("d", d);
    const st = this.#status(state, c);
    el.setAttribute("class", `edge ${st === "running" ? "running" : ""} ${c.kind === "agent" ? "spawn" : ""}`);
    const agentId = c.kind === "agent" ? c.id : state.items.get(c.id)?.agent;
    el.style.setProperty("--c", agentColor(state.agents.get(agentId)?.name ?? "agent"));
  }

  #upsertNode(n, state) {
    let el = this.nodes.get(n.key);
    if (!el) {
      const fo = s("foreignObject", { width: n.w, height: n.h });
      const div = document.createElement("div");
      fo.append(div);
      el = s("g", { class: "gnode enter", "data-id": n.id });
      el.append(fo);
      el.addEventListener("click", () => this.onSelect?.({ kind: el.dataset.kind, id: n.id }));
      el.addEventListener("dblclick", () => {
        if (el.dataset.kind !== "agent" || n.id === "root") return;
        if (this.collapsed.has(n.id)) this.collapsed.delete(n.id);
        else this.collapsed.add(n.id);
        this.lastState && this.render(this.lastState);
      });
      this.nodeLayer.append(el);
      this.nodes.set(n.key, el);
      setTimeout(() => el.classList.remove("enter"), 400);
      el._div = div;
      el._fo = fo;
    }
    this.lastState = state;
    el.dataset.kind = n.kind;
    el.setAttribute("transform", `translate(${n.x},${n.y})`);
    el._fo.setAttribute("width", n.w);
    el._fo.setAttribute("height", n.h);
    const status = this.#status(state, n);
    const html = this.#html(n, state, status);
    if (el._html !== html) {
      el._div.innerHTML = html;
      el._html = html;
    }
    el.classList.toggle("selected", this.selected === n.id && (this.selectedKind ?? n.kind) === n.kind);
  }

  #html(n, state, status) {
    const now = state.now;
    if (n.kind === "agent") {
      const a = state.agents.get(n.id);
      const color = agentColor(a?.name ?? "agent");
      const dur = a ? fmtMs((a.end ?? now) - a.start) : "";
      const collapsed = this.collapsed.has(n.id) ? ` <span class="badge">collapsed</span>` : "";
      return `<div class="gn agent st-${status}" style="--c:${color}">
        <div class="gn-title"><span class="dot"></span>${esc(a?.name ?? n.id)}${n.id === "root" ? ` <span class="badge">main</span>` : ""}${collapsed}</div>
        <div class="gn-sub">${a?.llmCount ?? 0} model · ${a?.toolCount ?? 0} tools · ${dur}${a?.outTok ? ` · ${fmtNum(a.inTok + a.outTok)} tok` : ""}</div>
      </div>`;
    }
    const it = state.items.get(n.id);
    const color = agentColor(state.agents.get(it?.agent)?.name ?? "agent");
    if (n.kind === "llm") {
      const dur = fmtMs((it.end ?? now) - it.start);
      const sub =
        status === "running"
          ? truncate(it.text, 34) || "thinking…"
          : it.toolCalls.length
            ? `→ ${it.toolCalls.length} tool call${it.toolCalls.length > 1 ? "s" : ""}`
            : truncate(it.text, 34) || "reply";
      return `<div class="gn llm st-${status}" style="--c:${color}">
        <div class="gn-title"><span class="ico">◆</span>model call ${it.index}<span class="gn-dur">${dur}</span></div>
        <div class="gn-sub">${esc(sub)}</div>
      </div>`;
    }
    const dur = fmtMs((it.end ?? now) - it.start);
    return `<div class="gn tool tool-${esc(it.name)} st-${status}" style="--c:${color}">
      <div class="gn-title"><span class="ico">${toolIcon(it.name)}</span>${esc(it.name)}<span class="gn-dur">${dur}</span></div>
      <div class="gn-sub">${esc(argSummary(it.name, it.args))}</div>
    </div>`;
  }

  select(id) {
    this.selected = id;
    for (const el of this.nodes.values())
      el.classList.toggle("selected", el.dataset.id === id && (!this.selectedKind || el.dataset.kind === this.selectedKind));
  }

  centerOn(id) {
    const el = [...this.nodes.values()].find((e) => e.dataset.id === id);
    if (!el) return;
    const m = el.getAttribute("transform").match(/translate\(([-\d.]+),([-\d.]+)\)/);
    if (!m) return;
    const rect = this.svg.getBoundingClientRect();
    this.follow = false;
    this.view.x = rect.width / 2 - (+m[1] + 100) * this.view.k;
    this.view.y = rect.height / 2 - (+m[2] + 20) * this.view.k;
    this.#applyView();
  }
}
