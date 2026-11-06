"""FastAPI server: starts deep agent runs and streams their events to the browser."""

from __future__ import annotations

import asyncio
import importlib
import inspect
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .demo_agent import DEMO_MODEL, build_demo_agent
from .tracer import RunRecorder, run_agent

STATIC_DIR = Path(__file__).parent / "static"

MODEL_SUGGESTIONS = [
    {"id": DEMO_MODEL, "label": "Demo (scripted, offline)", "env": None},
    {"id": "anthropic:claude-sonnet-5-5", "label": "Claude Sonnet 5.5", "env": "ANTHROPIC_API_KEY"},
    {"id": "anthropic:claude-opus-5-5", "label": "Claude Opus 5.5", "env": "ANTHROPIC_API_KEY"},
    {"id": "anthropic:claude-haiku-5-5", "label": "Claude Haiku 5.5", "env": "ANTHROPIC_API_KEY"},
    {"id": "openai:gpt-5.5", "label": "OpenAI GPT-5.5", "env": "OPENAI_API_KEY"},
]


# --------------------------------------------------------------------------- agents


class AgentSpec:
    """An agent the UI can run: the built-in demo or a user-supplied ``module:attr``."""

    def __init__(self, id_: str, name: str, target: Any, description: str = "", takes_model: bool = True) -> None:
        self.id = id_
        self.name = name
        self.target = target
        self.description = description
        self.takes_model = takes_model
        self._cache: dict[str, Any] = {}

    def build(self, model: str | None) -> Any:
        if hasattr(self.target, "astream"):  # already-compiled graph
            return self.target
        key = model or ""
        if key not in self._cache:
            self._cache[key] = self.target(model) if self.takes_model else self.target()
        return self._cache[key]

    def info(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "description": self.description, "takes_model": self.takes_model}


def load_agent_spec(ref: str) -> AgentSpec:
    """Load ``package.module:attribute`` - a compiled graph or a factory ``(model) -> graph``."""
    if ":" not in ref:
        raise ValueError(f"Agent reference must look like 'module:attribute', got {ref!r}")
    mod_name, attr = ref.split(":", 1)
    target: Any = importlib.import_module(mod_name)
    for part in attr.split("."):
        target = getattr(target, part)
    takes_model = False
    if not hasattr(target, "astream"):
        if not callable(target):
            raise TypeError(f"{ref} is neither a compiled graph nor a callable")
        try:
            takes_model = len(inspect.signature(target).parameters) > 0
        except (TypeError, ValueError):
            takes_model = True
    name = getattr(target, "name", None) if hasattr(target, "astream") else None
    return AgentSpec(ref, name or attr, target, description=f"Loaded from {ref}", takes_model=takes_model)


# --------------------------------------------------------------------------- app


class RunRequest(BaseModel):
    prompt: str = Field(min_length=1)
    agent: str = "demo"
    model: str | None = DEMO_MODEL


def create_app(agent_refs: list[str] | None = None, runs_dir: str | os.PathLike[str] | None = None) -> FastAPI:
    app = FastAPI(title="Deep Agent Web", version="0.1.0")
    agents: dict[str, AgentSpec] = {
        "demo": AgentSpec(
            "demo",
            "research-lead",
            build_demo_agent,
            "Built-in demo: a research lead with 'researcher' and 'critic' subagents, todos and a virtual filesystem.",
        )
    }
    refs = agent_refs if agent_refs is not None else [r for r in os.environ.get("DEEPAGENT_WEB_AGENTS", "").split(",") if r.strip()]
    for ref in refs:
        spec = load_agent_spec(ref.strip())
        agents[spec.id] = spec

    runs: dict[str, RunRecorder] = {}
    tasks: dict[str, asyncio.Task[None]] = {}
    store = Path(runs_dir or os.environ.get("DEEPAGENT_WEB_RUNS_DIR", "runs"))
    store.mkdir(parents=True, exist_ok=True)

    def persist(rec: RunRecorder) -> None:
        (store / f"{rec.run_id}.json").write_text(json.dumps(rec.to_json()))

    # Load saved runs so they can be replayed after a restart.
    for path in sorted(store.glob("*.json")):
        try:
            data = json.loads(path.read_text())
            info = dict(data["run"])
            rec = RunRecorder(info.pop("id"), {k: v for k, v in info.items() if k not in ("status", "events")})
            rec.events = data["events"]
            rec.status = info.get("status", "done")
            runs[rec.run_id] = rec
        except Exception:  # noqa: BLE001
            continue

    @app.get("/api/config")
    def config() -> dict[str, Any]:
        return {
            "agents": [a.info() for a in agents.values()],
            "models": [{**m, "available": m["env"] is None or bool(os.environ.get(m["env"]))} for m in MODEL_SUGGESTIONS],
        }

    @app.get("/api/runs")
    def list_runs() -> list[dict[str, Any]]:
        return sorted((r.summary() for r in runs.values()), key=lambda r: r.get("created", 0), reverse=True)

    @app.post("/api/runs")
    async def create_run(req: RunRequest) -> dict[str, Any]:
        spec = agents.get(req.agent)
        if spec is None:
            raise HTTPException(404, f"Unknown agent {req.agent!r}")
        model = (req.model or "").strip() or None
        try:
            graph = spec.build(model)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, f"Could not build agent: {type(exc).__name__}: {exc}") from exc
        run_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        meta = {
            "created": time.time(),
            "prompt": req.prompt,
            "agent": spec.id,
            "agent_name": spec.name,
            "model": model if spec.takes_model else None,
        }
        rec = RunRecorder(run_id, meta, asyncio.get_running_loop())
        runs[run_id] = rec
        tasks[run_id] = asyncio.create_task(
            run_agent(graph, req.prompt, rec, agent_name=spec.name, on_done=persist), name=f"run-{run_id}"
        )
        tasks[run_id].add_done_callback(lambda _t: tasks.pop(run_id, None))
        return rec.summary()

    def get_run(run_id: str) -> RunRecorder:
        if not re.fullmatch(r"[\w.-]+", run_id) or run_id not in runs:
            raise HTTPException(404, "Run not found")
        return runs[run_id]

    @app.get("/api/runs/{run_id}")
    def run_detail(run_id: str) -> JSONResponse:
        return JSONResponse(get_run(run_id).to_json())

    @app.post("/api/runs/{run_id}/cancel")
    def cancel_run(run_id: str) -> dict[str, Any]:
        rec = get_run(run_id)
        task = tasks.get(run_id)
        if task:
            task.cancel()
        return rec.summary()

    @app.delete("/api/runs/{run_id}")
    def delete_run(run_id: str) -> dict[str, bool]:
        get_run(run_id)
        if run_id in tasks:
            raise HTTPException(409, "Run is still in progress")
        runs.pop(run_id, None)
        (store / f"{run_id}.json").unlink(missing_ok=True)
        return {"deleted": True}

    @app.get("/api/runs/{run_id}/stream")
    async def stream_run(run_id: str, request: Request, since: int = 0) -> StreamingResponse:
        """Server-sent events: replays the log from ``since`` then follows live."""
        rec = get_run(run_id)
        last_id = request.headers.get("last-event-id")
        start = int(last_id) + 1 if last_id and last_id.isdigit() else since

        async def gen():
            yield "retry: 2000\n\n"
            async for ev in rec.follow(start):
                if await request.is_disconnected():
                    return
                if ev is None:
                    yield ": keep-alive\n\n"
                    continue
                yield f"id: {ev['seq']}\ndata: {json.dumps(ev)}\n\n"
            yield "event: end\ndata: {}\n\n"

        return StreamingResponse(
            gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
        )

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app
