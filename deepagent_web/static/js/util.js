// Small shared helpers: DOM, formatting, colours, a tiny safe markdown renderer.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}

export const SVG_NS = "http://www.w3.org/2000/svg";
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}

export function fmtMs(ms) {
  if (ms == null || Number.isNaN(ms)) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
  const m = Math.floor(ms / 60000);
  return `${m}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function fmtNum(n) {
  if (n == null) return "–";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString();
}

export function truncate(str, n = 80) {
  str = String(str ?? "").replace(/\s+/g, " ").trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

export function prettyJson(value) {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

// A one-line summary of tool arguments for node labels.
export function argSummary(name, args) {
  if (args == null) return "";
  if (typeof args !== "object") return truncate(args, 48);
  if (name === "task") return `${args.subagent_type ?? ""}: ${truncate(args.description, 40)}`;
  if (name === "write_todos") return `${(args.todos || []).length} todos`;
  const key = ["file_path", "path", "pattern", "query", "command"].find((k) => k in args);
  if (key) return truncate(args[key], 48);
  const first = Object.values(args)[0];
  return truncate(typeof first === "string" ? first : JSON.stringify(first ?? ""), 48);
}

// Colour per agent *type* so all "researcher" subagents share a hue.
const PALETTE = ["#7c9cff", "#3ecf8e", "#f5a524", "#e5609d", "#38bdf8", "#a78bfa", "#f97362", "#2dd4bf", "#facc15"];
const assigned = new Map();
export function agentColor(name) {
  if (!assigned.has(name)) assigned.set(name, PALETTE[assigned.size % PALETTE.length]);
  return assigned.get(name);
}
export function resetColors() {
  assigned.clear();
}

export const TOOL_ICONS = {
  task: "⑂",
  write_todos: "☑",
  ls: "▤",
  read_file: "◧",
  write_file: "✎",
  edit_file: "✐",
  delete: "✕",
  glob: "✱",
  grep: "⌕",
  execute: "❯",
  web_search: "◍",
};
export const toolIcon = (name) => TOOL_ICONS[name] ?? "⚙";

// Minimal, escape-first markdown: headings, bold, italics, code, lists, paragraphs.
export function md(text) {
  const lines = esc(text ?? "").split("\n");
  let out = "";
  let inList = false;
  let inCode = false;
  const inline = (t) =>
    t
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inList) (out += "</ul>"), (inList = false);
      out += inCode ? "</pre>" : "<pre>";
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out += `${line}\n`;
      continue;
    }
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (li) {
      if (!inList) (out += "<ul>"), (inList = true);
      out += `<li>${inline(li[1])}</li>`;
      continue;
    }
    if (inList) (out += "</ul>"), (inList = false);
    const hd = line.match(/^(#{1,4})\s+(.*)/);
    if (hd) out += `<h${hd[1].length + 2}>${inline(hd[2])}</h${hd[1].length + 2}>`;
    else if (line.trim()) out += `<p>${inline(line)}</p>`;
  }
  if (inList) out += "</ul>";
  if (inCode) out += "</pre>";
  return out;
}

// Line diff (LCS) used by the file viewer to highlight what a write changed.
export function lineDiff(before, after) {
  const a = (before ?? "").split("\n");
  const b = (after ?? "").split("\n");
  if (a.length * b.length > 250000) return b.map((t) => ({ op: "same", t }));
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) out.push({ op: "same", t: b[j] }), i++, j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "del", t: a[i++] });
    else out.push({ op: "add", t: b[j++] });
  }
  while (i < a.length) out.push({ op: "del", t: a[i++] });
  while (j < b.length) out.push({ op: "add", t: b[j++] });
  return out;
}
