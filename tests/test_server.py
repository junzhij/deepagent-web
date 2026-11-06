import json
import sys
import textwrap
import time

import pytest
from fastapi.testclient import TestClient

from deepagent_web.server import create_app, load_agent_spec


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DEMO_DELAY", "0")
    with TestClient(create_app(agent_refs=[], runs_dir=tmp_path)) as c:
        yield c


def _wait_done(client, run_id, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        run = next(r for r in client.get("/api/runs").json() if r["id"] == run_id)
        if run["status"] != "running":
            return run
        time.sleep(0.1)
    raise AssertionError("run did not finish")


def test_index_and_config(client):
    assert "Deep Agent" in client.get("/").text
    cfg = client.get("/api/config").json()
    assert cfg["agents"][0]["id"] == "demo"
    assert any(m["id"] == "demo" and m["available"] for m in cfg["models"])


def test_run_lifecycle(client, tmp_path):
    run = client.post("/api/runs", json={"prompt": "hello", "model": "demo"}).json()
    assert run["status"] == "running"
    done = _wait_done(client, run["id"])
    assert done["status"] == "done"

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["events"][-1]["type"] == "run_end"
    assert (tmp_path / f"{run['id']}.json").exists()

    # SSE replays the full log for finished runs and then ends.
    with client.stream("GET", f"/api/runs/{run['id']}/stream") as resp:
        body = "".join(resp.iter_text())
    data = [json.loads(line[6:]) for line in body.splitlines() if line.startswith("data: {\"seq")]
    assert len(data) == len(detail["events"])
    assert "event: end" in body

    # Resume from an offset.
    with client.stream("GET", f"/api/runs/{run['id']}/stream?since=5") as resp:
        body = "".join(resp.iter_text())
    first = next(json.loads(l[6:]) for l in body.splitlines() if l.startswith("data: {\"seq"))
    assert first["seq"] == 5

    assert client.delete(f"/api/runs/{run['id']}").json() == {"deleted": True}
    assert client.get(f"/api/runs/{run['id']}").status_code == 404


def test_runs_persist_across_restart(tmp_path, monkeypatch):
    monkeypatch.setenv("DEMO_DELAY", "0")
    with TestClient(create_app(agent_refs=[], runs_dir=tmp_path)) as c:
        rid = c.post("/api/runs", json={"prompt": "persist me"}).json()["id"]
        _wait_done(c, rid)
    with TestClient(create_app(agent_refs=[], runs_dir=tmp_path)) as c:
        runs = c.get("/api/runs").json()
        assert runs[0]["id"] == rid and runs[0]["prompt"] == "persist me"


def test_bad_requests(client):
    assert client.post("/api/runs", json={"prompt": "x", "agent": "nope"}).status_code == 404
    assert client.post("/api/runs", json={"prompt": ""}).status_code == 422
    assert client.get("/api/runs/../../etc/passwd").status_code == 404


def test_custom_agent_reference(tmp_path, monkeypatch):
    mod = tmp_path / "my_agents.py"
    mod.write_text(
        textwrap.dedent(
            """
            from deepagent_web.demo_agent import build_demo_agent
            graph = build_demo_agent()
            def factory(model=None):
                return build_demo_agent(model)
            """
        )
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    sys.modules.pop("my_agents", None)
    compiled = load_agent_spec("my_agents:graph")
    assert not compiled.takes_model and hasattr(compiled.build(None), "astream")
    factory = load_agent_spec("my_agents:factory")
    assert factory.takes_model
    with pytest.raises(ValueError):
        load_agent_spec("no_colon")
