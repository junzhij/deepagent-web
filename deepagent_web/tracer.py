"""Turn a deep agent run into a flat, replayable stream of JSON events.

Two sources are combined:

* LangChain **callbacks** give precise start/end times for every model call and
  tool call, streamed tokens, and - through ``lc_subagent_tool_call_id`` in the
  callback metadata - which (sub)agent each call belongs to.
* LangGraph **state updates** (``stream_mode="updates"``, ``subgraphs=True``)
  give the deep-agent state: the todo list and the virtual filesystem.

Every event is a dict with ``seq``, ``t`` (ms since the run started) and
``type``. The frontend rebuilds the whole UI by folding over these events, which
is what makes live view and replay the same code path.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
import traceback
import uuid
from collections.abc import Callable
from typing import Any
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import BaseMessage, ToolMessage
from langchain_core.outputs import LLMResult

ROOT = "root"


# --------------------------------------------------------------------------- helpers


def to_jsonable(value: Any, depth: int = 0) -> Any:
    """Best-effort conversion of arbitrary tool inputs/outputs to JSON."""
    if depth > 8:
        return repr(value)
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {str(k): to_jsonable(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_jsonable(v, depth + 1) for v in value]
    if isinstance(value, BaseMessage):
        return {"type": value.type, "content": content_text(value.content)}
    if hasattr(value, "model_dump"):
        try:
            return to_jsonable(value.model_dump(), depth + 1)
        except Exception:  # noqa: BLE001
            pass
    return repr(value)


def content_text(content: Any) -> str:
    """Flatten LangChain message content (str or list of blocks) into text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") in (None, "text", "output_text"):
                parts.append(str(block.get("text", "")))
        return "".join(parts)
    return "" if content is None else str(content)


def content_reasoning(message: BaseMessage) -> str:
    parts = []
    if isinstance(message.content, list):
        for block in message.content:
            if isinstance(block, dict) and block.get("type") in ("thinking", "reasoning"):
                parts.append(str(block.get("thinking") or block.get("reasoning") or block.get("text") or ""))
    rc = (message.additional_kwargs or {}).get("reasoning_content")
    if rc:
        parts.append(str(rc))
    return "\n".join(p for p in parts if p)


def tool_output(output: Any) -> tuple[str, str]:
    """Return ``(text, status)`` for whatever a tool returned."""
    status = "success"
    msg: Any = output
    update = getattr(output, "update", None)  # langgraph Command
    if isinstance(update, dict):
        msgs = update.get("messages") or []
        msg = msgs[-1] if msgs else json.dumps(to_jsonable({k: v for k, v in update.items() if k != "messages"}))
    if isinstance(msg, ToolMessage):
        status = msg.status or "success"
        return content_text(msg.content), status
    if isinstance(msg, BaseMessage):
        return content_text(msg.content), status
    if isinstance(msg, str):
        return msg, status
    try:
        return json.dumps(to_jsonable(msg), indent=2), status
    except Exception:  # noqa: BLE001
        return repr(msg), status


def normalize_files(files: Any) -> dict[str, str | None]:
    """Normalise a deepagents ``files`` state update to ``{path: text | None}``."""
    out: dict[str, str | None] = {}
    if not isinstance(files, dict):
        return out
    for path, data in files.items():
        if data is None:
            out[path] = None
        elif isinstance(data, dict):
            c = data.get("content", "")
            out[path] = "\n".join(c) if isinstance(c, list) else str(c)
        else:
            out[path] = str(data)
    return out


# --------------------------------------------------------------------------- recorder


class RunRecorder:
    """Thread-safe, append-only event log with async subscribers."""

    def __init__(self, run_id: str, meta: dict[str, Any], loop: asyncio.AbstractEventLoop | None = None) -> None:
        self.run_id = run_id
        self.meta = meta
        self.events: list[dict[str, Any]] = []
        self.status = "running"
        self._t0 = time.monotonic()
        self._lock = threading.Lock()
        self._loop = loop
        self._waiters: set[asyncio.Event] = set()

    def emit(self, type_: str, **data: Any) -> dict[str, Any]:
        with self._lock:
            event = {"seq": len(self.events), "t": round((time.monotonic() - self._t0) * 1000, 1), "type": type_, **data}
            self.events.append(event)
        self._notify()
        return event

    def _notify(self) -> None:
        if self._loop is None:
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            self._wake()
        else:
            self._loop.call_soon_threadsafe(self._wake)

    def _wake(self) -> None:
        for w in list(self._waiters):
            w.set()

    async def follow(self, start: int = 0):
        """Yield events from ``start`` onwards, then live events until the run ends."""
        idx = start
        while True:
            while idx < len(self.events):
                yield self.events[idx]
                idx += 1
            if self.status != "running":
                return
            waiter = asyncio.Event()
            self._waiters.add(waiter)
            try:
                if idx >= len(self.events) and self.status == "running":
                    try:
                        await asyncio.wait_for(waiter.wait(), timeout=15)
                    except TimeoutError:
                        yield None  # heartbeat
            finally:
                self._waiters.discard(waiter)

    def summary(self) -> dict[str, Any]:
        return {"id": self.run_id, "status": self.status, "events": len(self.events), **self.meta}

    def to_json(self) -> dict[str, Any]:
        return {"version": 1, "run": self.summary(), "events": self.events}


# --------------------------------------------------------------------------- callbacks


class VizCallbackHandler(BaseCallbackHandler):
    """Records model/tool lifecycle events, attributed to the owning (sub)agent."""

    run_inline = True  # call us directly on the event loop instead of in an executor
    raise_error = False

    def __init__(self, recorder: RunRecorder) -> None:
        self.rec = recorder
        self.tool_ids: dict[UUID, str] = {}  # callback run_id -> tool_call_id
        self.task_tools: set[str] = set()
        self.ns_to_agent: dict[str, str] = {}  # checkpoint namespace segment -> agent id
        self.llm_seen: set[UUID] = set()

    @staticmethod
    def _agent(metadata: dict[str, Any] | None) -> str:
        return (metadata or {}).get("lc_subagent_tool_call_id") or ROOT

    # -- models ------------------------------------------------------------------

    def on_chat_model_start(self, serialized, messages, *, run_id, metadata=None, **kwargs: Any) -> None:
        self.llm_seen.add(run_id)
        md = metadata or {}
        self.rec.emit(
            "llm_start",
            agent=self._agent(md),
            id=str(run_id),
            node=md.get("langgraph_node"),
            model=md.get("ls_model_name") or (serialized or {}).get("name"),
            n_messages=sum(len(m) for m in messages),
        )

    def on_llm_start(self, serialized, prompts, *, run_id, metadata=None, **kwargs: Any) -> None:
        if run_id not in self.llm_seen:
            self.on_chat_model_start(serialized, [[]], run_id=run_id, metadata=metadata)

    def on_llm_new_token(self, token: str, *, run_id, chunk=None, **kwargs: Any) -> None:
        text = token
        if chunk is not None and getattr(chunk, "message", None) is not None:
            text = content_text(chunk.message.content) or token
        if text:
            self.rec.emit("llm_token", id=str(run_id), text=text)

    def on_llm_end(self, response: LLMResult, *, run_id, **kwargs: Any) -> None:
        gen = response.generations[0][0] if response.generations and response.generations[0] else None
        msg = getattr(gen, "message", None)
        data: dict[str, Any] = {"id": str(run_id), "content": "", "reasoning": "", "tool_calls": [], "usage": None}
        if msg is not None:
            data["content"] = content_text(msg.content)
            data["reasoning"] = content_reasoning(msg)
            data["tool_calls"] = [
                {"id": tc.get("id"), "name": tc.get("name"), "args": to_jsonable(tc.get("args"))}
                for tc in getattr(msg, "tool_calls", None) or []
            ]
            usage = getattr(msg, "usage_metadata", None)
            if usage:
                data["usage"] = {k: usage.get(k) for k in ("input_tokens", "output_tokens", "total_tokens")}
        elif gen is not None:
            data["content"] = gen.text
        self.rec.emit("llm_end", **data)

    def on_llm_error(self, error: BaseException, *, run_id, **kwargs: Any) -> None:
        self.rec.emit("llm_error", id=str(run_id), error=f"{type(error).__name__}: {error}")

    # -- tools -------------------------------------------------------------------

    def on_tool_start(self, serialized, input_str, *, run_id, metadata=None, inputs=None, **kwargs: Any) -> None:
        md = metadata or {}
        agent = self._agent(md)
        name = kwargs.get("name") or (serialized or {}).get("name") or "tool"
        call_id = kwargs.get("tool_call_id") or str(run_id)
        self.tool_ids[run_id] = call_id
        args = to_jsonable(inputs) if inputs is not None else input_str
        if isinstance(args, dict):
            args = {k: v for k, v in args.items() if k not in ("runtime", "tool_call_id", "state")}
        self.rec.emit("tool_start", agent=agent, id=call_id, name=name, args=args)
        if name == "task" and isinstance(args, dict):
            self.task_tools.add(call_id)
            ns = str(md.get("langgraph_checkpoint_ns") or md.get("checkpoint_ns") or "").split("|")[-1]
            if ns:
                self.ns_to_agent[ns] = call_id
            self.rec.emit(
                "agent_start",
                agent=call_id,
                parent=agent,
                name=args.get("subagent_type") or "subagent",
                description=args.get("description", ""),
            )

    def on_tool_end(self, output: Any, *, run_id, **kwargs: Any) -> None:
        call_id = self.tool_ids.get(run_id, str(run_id))
        text, status = tool_output(output)
        self.rec.emit("tool_end", id=call_id, output=text, status=status)
        if call_id in self.task_tools:
            self.rec.emit("agent_end", agent=call_id, status="error" if status == "error" else "done", output=text)

    def on_tool_error(self, error: BaseException, *, run_id, **kwargs: Any) -> None:
        call_id = self.tool_ids.get(run_id, str(run_id))
        self.rec.emit("tool_end", id=call_id, output=f"{type(error).__name__}: {error}", status="error")
        if call_id in self.task_tools:
            self.rec.emit("agent_end", agent=call_id, status="error", output=str(error))


# --------------------------------------------------------------------------- run loop


def _update_events(handler: VizCallbackHandler, ns: tuple[str, ...], chunk: Any) -> None:
    if not isinstance(chunk, dict):
        return
    agent = handler.ns_to_agent.get(ns[-1], ROOT) if ns else ROOT
    rec = handler.rec
    for node, update in chunk.items():
        if node == "__interrupt__":
            rec.emit("interrupt", agent=agent, value=to_jsonable(update))
            continue
        if node not in ("model", "tools"):
            rec.emit("step", agent=agent, node=node)
        if not isinstance(update, dict):
            continue
        if "todos" in update and update["todos"] is not None:
            rec.emit("todos", agent=agent, todos=to_jsonable(update["todos"]))
        if "files" in update and update["files"]:
            files = normalize_files(update["files"])
            if files:
                rec.emit("files", agent=agent, files=files)


async def run_agent(
    agent: Any,
    prompt: str,
    recorder: RunRecorder,
    *,
    agent_name: str = "agent",
    on_done: Callable[[RunRecorder], None] | None = None,
    recursion_limit: int = 250,
) -> None:
    """Stream ``agent`` on ``prompt`` and record everything into ``recorder``."""
    handler = VizCallbackHandler(recorder)
    final = ""
    try:
        recorder.emit("run_start", **{**recorder.meta, "prompt": prompt})
        recorder.emit("agent_start", agent=ROOT, parent=None, name=agent_name, description=prompt)
        config = {"callbacks": [handler], "recursion_limit": recursion_limit, "configurable": {"thread_id": str(uuid.uuid4())}}
        async for item in agent.astream(
            {"messages": [{"role": "user", "content": prompt}]},
            config,
            stream_mode=["updates", "messages"],  # "messages" switches models into streaming mode
            subgraphs=True,
        ):
            ns, mode, chunk = item
            if mode == "updates":
                _update_events(handler, tuple(ns), chunk)
        for ev in reversed(recorder.events):
            if ev["type"] == "llm_end" and not ev["tool_calls"]:
                final = ev["content"]
                break
        recorder.emit("agent_end", agent=ROOT, status="done", output=final)
        recorder.status = "done"
        recorder.emit("run_end", status="done", final=final)
    except asyncio.CancelledError:
        recorder.emit("agent_end", agent=ROOT, status="cancelled", output="")
        recorder.status = "cancelled"
        recorder.emit("run_end", status="cancelled", final=final)
        raise
    except Exception as exc:  # noqa: BLE001
        recorder.emit("agent_end", agent=ROOT, status="error", output=str(exc))
        recorder.status = "error"
        recorder.emit("run_end", status="error", error=f"{type(exc).__name__}: {exc}", traceback=traceback.format_exc())
    finally:
        if on_done:
            on_done(recorder)
