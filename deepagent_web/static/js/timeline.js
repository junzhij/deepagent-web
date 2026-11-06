// Swimlane timeline: one lane per agent, model calls on the first row, tool
// calls packed on the rows below, with connectors from `task` calls to the
// subagent lanes they spawned.

import { agentsDfs } from "./store.js";
import { agentColor, argSummary, esc, fmtMs, toolIcon } from "./util.js";

const LABEL_W = 190;
const ROW_H = 20;
const LANE_PAD = 10;
const AXIS_H = 26;

function niceStep(totalMs, px) {
  const target = (totalMs / px) * 90; // ~1 tick per 90px
  const steps = [50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000];
  return steps.find((s) => s >= target) ?? 600000;
}

export class TimelineView {
  constructor(container, { onSelect }) {
    this.el = container;
    this.onSelect = onSelect;
    this.selected = null;
    this.zoom = 1;
    this.el.addEventListener("click", (e) => {
      const t = e.target.closest("[data-id]");
      if (t) this.onSelect?.({ kind: t.dataset.kind, id: t.dataset.id });
    });
    this.el.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        this.zoom = Math.min(20, Math.max(1, this.zoom * Math.exp(-e.deltaY * 0.004)));
        this.last && this.render(this.last);
      },
      { passive: false },
    );
  }

  render(state) {
    this.last = state;
    const agents = agentsDfs(state);
    const width = Math.max(600, (this.el.clientWidth - 2) * this.zoom);
    const span = Math.max(state.run.end ?? state.now, 1);
    const plotW = width - LABEL_W - 24;
    const x = (t) => LABEL_W + (t / span) * plotW;

    // Pack bars into rows per lane.
    const lanes = [];
    let y = AXIS_H;
    const laneY = new Map();
    for (const a of agents) {
      const rows = [[]]; // row 0 = model calls
      const bars = [];
      for (const iid of a.items) {
        const it = state.items.get(iid);
        if (!it) continue;
        const end = it.end ?? state.now;
        let row = 0;
        if (it.kind === "tool") {
          row = 1;
          while (rows[row]?.some(([s0, e0]) => it.start < e0 && end > s0)) row++;
        }
        (rows[row] ??= []).push([it.start, end]);
        bars.push({ it, row, end });
      }
      const nRows = Math.max(2, rows.length);
      const h = nRows * ROW_H + LANE_PAD * 2;
      lanes.push({ a, bars, y, h });
      laneY.set(a.id, y);
      y += h;
    }
    const height = y + 8;

    const parts = [];
    // Axis + grid
    const step = niceStep(span, plotW);
    for (let t = 0; t <= span; t += step) {
      const gx = x(t);
      parts.push(`<line class="grid" x1="${gx}" x2="${gx}" y1="${AXIS_H - 6}" y2="${height}"/>`);
      parts.push(`<text class="tick" x="${gx}" y="${AXIS_H - 10}">${fmtMs(t)}</text>`);
    }

    for (const [i, lane] of lanes.entries()) {
      const { a, bars, y: ly, h } = lane;
      const color = agentColor(a.name);
      parts.push(`<rect class="lane ${i % 2 ? "odd" : ""}" x="0" y="${ly}" width="${width}" height="${h}"/>`);
      const indent = 12 + a.depth * 14;
      parts.push(
        `<g class="lane-label" data-kind="agent" data-id="${esc(a.id)}">
          <rect x="${indent - 6}" y="${ly + 12}" width="4" height="${h - 24}" rx="2" fill="${color}"/>
          <text x="${indent + 4}" y="${ly + 24}" class="lname">${esc(a.name)}</text>
          <text x="${indent + 4}" y="${ly + 39}" class="lsub">${a.status} · ${fmtMs((a.end ?? state.now) - a.start)}</text>
        </g>`,
      );
      // agent lifetime
      const ax1 = x(a.start);
      const ax2 = x(a.end ?? state.now);
      parts.push(`<rect class="life" x="${ax1}" y="${ly + 4}" width="${Math.max(1, ax2 - ax1)}" height="${h - 8}" rx="6" style="--c:${color}"/>`);

      for (const { it, row, end } of bars) {
        const bx = x(it.start);
        const bw = Math.max(3, x(end) - bx);
        const by = ly + LANE_PAD + row * ROW_H + 2;
        const sel = this.selected === it.id ? " selected" : "";
        const label = it.kind === "llm" ? `model ${it.index}` : `${toolIcon(it.name)} ${it.name}`;
        const title =
          it.kind === "llm"
            ? `model call ${it.index} · ${fmtMs(end - it.start)}${it.usage ? ` · ${it.usage.input_tokens}→${it.usage.output_tokens} tok` : ""}`
            : `${it.name}(${argSummary(it.name, it.args)}) · ${fmtMs(end - it.start)}`;
        parts.push(
          `<g class="bar ${it.kind} st-${it.status}${sel}" data-kind="${it.kind}" data-id="${esc(it.id)}" style="--c:${color}">
            <title>${esc(title)}</title>
            <rect x="${bx}" y="${by}" width="${bw}" height="${ROW_H - 4}" rx="4"/>
            ${bw > 46 ? `<text x="${bx + 6}" y="${by + 12}">${esc(label).slice(0, Math.floor(bw / 7))}</text>` : ""}
          </g>`,
        );
        if (it.kind === "tool" && it.childAgent && laneY.has(it.childAgent)) {
          const cy = laneY.get(it.childAgent) + 8;
          parts.push(
            `<path class="spawn-link" d="M${bx + 2},${by + ROW_H - 4} L${bx + 2},${cy}" style="--c:${agentColor(state.agents.get(it.childAgent)?.name)}"/>`,
          );
        }
      }
    }
    // Playhead
    if (state.run.status === "running" || state.now < span) {
      const px = x(state.now);
      parts.push(`<line class="playhead" x1="${px}" x2="${px}" y1="${AXIS_H - 6}" y2="${height}"/>`);
    }
    if (!lanes.length) parts.push(`<text class="empty" x="20" y="60">No run yet.</text>`);

    this.el.innerHTML = `<svg class="timeline-svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
  }

  select(id) {
    this.selected = id;
    if (this.last) this.render(this.last);
  }
}
