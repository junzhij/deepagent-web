import asyncio

import pytest

from deepagent_web.demo_agent import build_demo_agent
from deepagent_web.tracer import ROOT, RunRecorder, normalize_files, run_agent, tool_output


@pytest.fixture(autouse=True)
def fast_demo(monkeypatch):
    monkeypatch.setenv("DEMO_DELAY", "0")


async def _run(prompt="Compare vector databases"):
    rec = RunRecorder("t", {"model": "demo"}, asyncio.get_running_loop())
    await run_agent(build_demo_agent(), prompt, rec, agent_name="research-lead")
    return rec


async def test_demo_run_produces_complete_trace():
    rec = await _run()
    types = [e["type"] for e in rec.events]
    assert rec.status == "done"
    assert types[0] == "run_start" and types[-1] == "run_end"
    assert [e["seq"] for e in rec.events] == list(range(len(rec.events)))

    agents = {e["agent"]: e for e in rec.events if e["type"] == "agent_start"}
    assert agents[ROOT]["parent"] is None
    subs = [a for a in agents.values() if a["parent"] == ROOT]
    assert sorted(a["name"] for a in subs) == ["critic", "researcher", "researcher"]

    # Every model/tool call is attributed to a known agent.
    for e in rec.events:
        if e["type"] in ("llm_start", "tool_start"):
            assert e["agent"] in agents

    # Subagent tool calls are attributed to the subagent, not the parent.
    researcher_ids = {a["agent"] for a in subs if a["name"] == "researcher"}
    searches = [e for e in rec.events if e["type"] == "tool_start" and e["name"] == "web_search"]
    assert searches and all(e["agent"] in researcher_ids for e in searches)

    # Starts and ends pair up.
    starts = {e["id"] for e in rec.events if e["type"] == "tool_start"}
    ends = {e["id"] for e in rec.events if e["type"] == "tool_end"}
    assert starts == ends
    assert {e["id"] for e in rec.events if e["type"] == "llm_start"} == {e["id"] for e in rec.events if e["type"] == "llm_end"}


async def test_state_updates_capture_todos_and_files():
    rec = await _run()
    todos = [e for e in rec.events if e["type"] == "todos"]
    assert todos and all(t["status"] == "completed" for t in todos[-1]["todos"])
    written = {}
    for e in rec.events:
        if e["type"] == "files":
            written.update(e["files"])
    assert {"/report.md", "/research/background.md", "/research/recent.md", "/research/critique.md"} <= set(written)
    assert "## Sources" in written["/report.md"]  # edit_file result is captured
    # The critic's file write is attributed to the critic subagent.
    critic = next(e["agent"] for e in rec.events if e["type"] == "agent_start" and e["name"] == "critic")
    assert any(e["type"] == "files" and e["agent"] == critic and "/research/critique.md" in e["files"] for e in rec.events)


async def test_tokens_are_streamed_and_final_answer_recorded():
    rec = await _run("WebAssembly on the server")
    assert any(e["type"] == "llm_token" for e in rec.events)
    end = rec.events[-1]
    assert end["status"] == "done" and "WebAssembly on the server" in end["final"]


async def test_failing_agent_ends_with_error():
    class Boom:
        async def astream(self, *a, **k):
            raise RuntimeError("kaboom")
            yield  # pragma: no cover

    rec = RunRecorder("e", {}, asyncio.get_running_loop())
    await run_agent(Boom(), "hi", rec)
    assert rec.status == "error"
    assert rec.events[-1]["type"] == "run_end" and "kaboom" in rec.events[-1]["error"]


async def test_follow_streams_live_events():
    rec = RunRecorder("f", {}, asyncio.get_running_loop())
    got = []

    async def consume():
        async for ev in rec.follow():
            if ev is not None:
                got.append(ev["type"])

    task = asyncio.create_task(consume())
    await asyncio.sleep(0)
    rec.emit("a")
    await asyncio.sleep(0)
    rec.emit("b")
    rec.status = "done"
    rec.emit("run_end")
    await asyncio.wait_for(task, 2)
    assert got == ["a", "b", "run_end"]


def test_helpers():
    assert normalize_files({"/a": {"content": ["x", "y"]}, "/b": None, "/c": {"content": "z"}}) == {"/a": "x\ny", "/b": None, "/c": "z"}
    assert tool_output("plain") == ("plain", "success")
