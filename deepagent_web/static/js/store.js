// Folds the backend's event log into a view model. The UI is a pure function of
// `events.slice(0, cursor)`, so live streaming and replay share one code path.

export function emptyState() {
  return {
    run: { prompt: "", model: null, agentName: "", status: "idle", final: "", error: null },
    agents: new Map(), // id -> agent
    items: new Map(), // id -> llm | tool item
    llmByRun: new Map(),
    todos: new Map(), // agent id -> { todos, t, history: [{t, todos}] }
    files: new Map(), // path -> { content, history: [{t, seq, agent, content}], deleted }
    order: [], // agent ids in spawn order
    now: 0,
    applied: 0,
    totals: { llm: 0, tools: 0, inTok: 0, outTok: 0, subagents: 0 },
    lastSeq: -1,
    lastChange: null, // { kind, id, t } for highlighting
  };
}

function agentOf(state, id) {
  return state.agents.get(id) ?? state.agents.get("root");
}

export function apply(state, ev) {
  state.now = Math.max(state.now, ev.t ?? 0);
  state.applied += 1;
  state.lastSeq = ev.seq;
  switch (ev.type) {
    case "run_start":
      state.run = {
        ...state.run,
        prompt: ev.prompt,
        model: ev.model,
        agentName: ev.agent_name,
        status: "running",
        created: ev.created,
      };
      break;

    case "agent_start": {
      const parent = ev.parent ? state.agents.get(ev.parent) : null;
      state.agents.set(ev.agent, {
        id: ev.agent,
        name: ev.name,
        parent: ev.parent,
        description: ev.description,
        status: "running",
        start: ev.t,
        end: null,
        output: "",
        items: [],
        depth: parent ? parent.depth + 1 : 0,
        children: [],
        llmCount: 0,
        toolCount: 0,
        inTok: 0,
        outTok: 0,
      });
      if (parent) {
        parent.children.push(ev.agent);
        state.totals.subagents += 1;
        const call = state.items.get(ev.agent);
        if (call) call.childAgent = ev.agent;
      }
      state.order.push(ev.agent);
      break;
    }

    case "agent_end": {
      const a = state.agents.get(ev.agent);
      if (a) Object.assign(a, { status: ev.status, end: ev.t, output: ev.output });
      break;
    }

    case "llm_start": {
      const a = agentOf(state, ev.agent);
      const item = {
        kind: "llm",
        id: ev.id,
        agent: a?.id ?? "root",
        start: ev.t,
        end: null,
        status: "running",
        text: "",
        reasoning: "",
        toolCalls: [],
        usage: null,
        model: ev.model,
        nMessages: ev.n_messages,
        index: a ? a.llmCount + 1 : 1,
        tools: [],
      };
      state.items.set(ev.id, item);
      if (a) {
        a.items.push(ev.id);
        a.llmCount += 1;
      }
      state.totals.llm += 1;
      break;
    }

    case "llm_token": {
      const it = state.items.get(ev.id);
      if (it) it.text += ev.text;
      break;
    }

    case "llm_end": {
      const it = state.items.get(ev.id);
      if (!it) break;
      Object.assign(it, {
        end: ev.t,
        status: "done",
        text: ev.content || it.text,
        reasoning: ev.reasoning,
        toolCalls: ev.tool_calls || [],
        usage: ev.usage,
      });
      for (const tc of it.toolCalls) {
        const tool = state.items.get(tc.id);
        if (tool) tool.llm = it.id;
      }
      const a = state.agents.get(it.agent);
      if (ev.usage) {
        state.totals.inTok += ev.usage.input_tokens || 0;
        state.totals.outTok += ev.usage.output_tokens || 0;
        if (a) {
          a.inTok += ev.usage.input_tokens || 0;
          a.outTok += ev.usage.output_tokens || 0;
        }
      }
      break;
    }

    case "llm_error": {
      const it = state.items.get(ev.id);
      if (it) Object.assign(it, { end: ev.t, status: "error", error: ev.error });
      break;
    }

    case "tool_start": {
      const a = agentOf(state, ev.agent);
      // The tool was requested by the most recent finished model call of this agent.
      let llm = null;
      if (a) {
        for (let i = a.items.length - 1; i >= 0; i--) {
          const prev = state.items.get(a.items[i]);
          if (prev?.kind === "llm") {
            llm = prev;
            break;
          }
        }
      }
      const item = {
        kind: "tool",
        id: ev.id,
        agent: a?.id ?? "root",
        name: ev.name,
        args: ev.args,
        start: ev.t,
        end: null,
        status: "running",
        output: "",
        llm: llm?.id ?? null,
        childAgent: null,
      };
      state.items.set(ev.id, item);
      if (llm) llm.tools.push(ev.id);
      if (a) {
        a.items.push(ev.id);
        a.toolCount += 1;
      }
      state.totals.tools += 1;
      break;
    }

    case "tool_end": {
      const it = state.items.get(ev.id);
      if (it) Object.assign(it, { end: ev.t, status: ev.status === "error" ? "error" : "done", output: ev.output });
      break;
    }

    case "todos": {
      const entry = state.todos.get(ev.agent) ?? { todos: [], t: 0, history: [] };
      entry.prev = entry.todos;
      entry.todos = ev.todos || [];
      entry.t = ev.t;
      entry.history.push({ t: ev.t, seq: ev.seq, todos: entry.todos });
      state.todos.set(ev.agent, entry);
      state.lastChange = { kind: "todos", id: ev.agent, t: ev.t };
      break;
    }

    case "files": {
      for (const [path, content] of Object.entries(ev.files || {})) {
        const f = state.files.get(path) ?? { path, content: null, history: [], deleted: false };
        if (content === null) {
          if (!f.deleted) f.history.push({ t: ev.t, seq: ev.seq, agent: ev.agent, content: null });
          f.deleted = true;
        } else if (content !== f.content) {
          // Subagent writes are re-emitted when merged into the parent's state;
          // only record a version when the content actually changes.
          f.history.push({ t: ev.t, seq: ev.seq, agent: ev.agent, content });
          f.content = content;
          f.deleted = false;
        }
        state.files.set(path, f);
        state.lastChange = { kind: "file", id: path, t: ev.t };
      }
      break;
    }

    case "run_end":
      state.run.status = ev.status;
      state.run.final = ev.final || "";
      state.run.error = ev.error || null;
      state.run.traceback = ev.traceback || null;
      state.run.end = ev.t;
      break;

    default:
      break;
  }
  return state;
}

export function build(events, upto = events.length) {
  const st = emptyState();
  for (let i = 0; i < upto; i++) apply(st, events[i]);
  return st;
}

// Agents in depth-first order (parent before children), for lanes and lists.
export function agentsDfs(state) {
  const out = [];
  const visit = (id) => {
    const a = state.agents.get(id);
    if (!a) return;
    out.push(a);
    for (const c of a.children) visit(c);
  };
  if (state.agents.has("root")) visit("root");
  for (const id of state.order) if (!out.some((a) => a.id === id)) visit(id);
  return out;
}

// Event types worth stopping at when stepping through a replay.
export const MILESTONES = new Set([
  "run_start",
  "agent_start",
  "agent_end",
  "llm_start",
  "llm_end",
  "tool_start",
  "tool_end",
  "todos",
  "files",
  "run_end",
  "interrupt",
]);

export function describeEvent(ev, state) {
  const agentName = (id) => state?.agents.get(id)?.name ?? (id === "root" ? "main" : "subagent");
  switch (ev.type) {
    case "run_start":
      return "Run started";
    case "agent_start":
      return ev.parent ? `Spawned subagent "${ev.name}"` : `Agent "${ev.name}" started`;
    case "agent_end":
      return `Agent "${agentName(ev.agent)}" ${ev.status}`;
    case "llm_start":
      return `${agentName(ev.agent)} → model call`;
    case "llm_end":
      return ev.tool_calls?.length ? `Model requested ${ev.tool_calls.map((t) => t.name).join(", ")}` : "Model replied";
    case "llm_token":
      return "streaming…";
    case "tool_start":
      return `${agentName(ev.agent)} → ${ev.name}`;
    case "tool_end":
      return `Tool ${ev.status === "error" ? "failed" : "returned"}`;
    case "todos":
      return `Plan updated (${(ev.todos || []).length} todos)`;
    case "files":
      return `Files: ${Object.keys(ev.files || {}).join(", ")}`;
    case "step":
      return `Middleware: ${ev.node}`;
    case "run_end":
      return `Run ${ev.status}`;
    default:
      return ev.type;
  }
}
