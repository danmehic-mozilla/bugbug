"""Tests for the local runner's server.py, which is a PEP 723 script, not a package.

From the repo root:

    uv run --no-project --python 3.14 --with pytest --with fastapi --with httpx \
        --with python-dotenv --with pillow --with requests --with uvicorn \
        --with anthropic pytest -q agents/autowebcompat-etp/local_runner/tests
"""

import importlib.util
import json
import os
import queue
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

SERVER_PY = Path(__file__).resolve().parents[1] / "server.py"

# Keep the import from touching ~/hackbot; each test points the globals at its
# own tmp_path.
os.environ["HACKBOT_ARTIFACTS"] = str(Path(tempfile.mkdtemp()) / "artifacts")
spec = importlib.util.spec_from_file_location("etp_local_runner_server", SERVER_PY)
server = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = server
spec.loader.exec_module(server)

EASYLIST = (
    "[Adblock Plus 2.0]\n! Version: 202611170830\n! Title: EasyList\n||ads.example^\n"
)
EASYPRIVACY = "[Adblock Plus 2.0]\n! Version: 202611170900\n||track.example^\n"


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    monkeypatch.setattr(server, "ARTIFACTS_ROOT", artifacts)
    monkeypatch.setattr(server, "FILTER_LISTS_DIR", tmp_path / "filter-lists")
    monkeypatch.setattr(server, "LOCAL_FIREFOX", None)
    monkeypatch.setattr(server, "PORT", 8123)
    monkeypatch.setattr(server, "RUNS", {})
    # The worker threads wait on the original queue, so nothing queued here runs.
    monkeypatch.setattr(server, "RUN_QUEUE", queue.Queue())
    monkeypatch.setattr(server, "MODELS_CACHE", None)
    return artifacts


@pytest.fixture
def client():
    return TestClient(server.app)


def cache_lists(**lists):
    server.FILTER_LISTS_DIR.mkdir(parents=True, exist_ok=True)
    for name, text in lists.items():
        (server.FILTER_LISTS_DIR / f"{name}.txt").write_text(text)


class FakeResponse:
    def __init__(self, text, status=200):
        self.text = text
        self.content = text.encode()
        self.status = status

    def raise_for_status(self):
        if self.status >= 400:
            raise server.requests.HTTPError(f"HTTP {self.status}")


class FakePopen:
    calls = []

    def __init__(self, cmd, **kwargs):
        FakePopen.calls.append((cmd, kwargs))
        self.stdout = [b"agent output\n"]
        self.pid = 1

    def wait(self):
        return 0


@pytest.fixture
def popen(monkeypatch):
    FakePopen.calls = []
    monkeypatch.setattr(server.subprocess, "Popen", FakePopen)
    return FakePopen.calls


def execute(params):
    run = server.Run(run_id="etp-bug1-test", params=params)
    run.dir.mkdir(parents=True)
    server.execute(run)
    [(cmd, kwargs)] = FakePopen.calls
    return run, cmd, kwargs


# --- runs_native ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("local_firefox", "native", "expected"),
    [
        (None, None, False),
        (None, True, False),
        ("/ff", None, True),
        ("/ff", True, True),
        ("/ff", False, False),
    ],
)
def test_runs_native(monkeypatch, local_firefox, native, expected):
    monkeypatch.setattr(server, "LOCAL_FIREFOX", local_firefox)
    assert server.runs_native({"native": native}) is expected


# --- execute -------------------------------------------------------------------


def test_execute_docker(popen):
    cache_lists(easylist=EASYLIST)
    params = {
        "bug_id": 1,
        "etp": "standard",
        "easylist": True,
        "easyprivacy": False,
        "private": True,
        "build": True,
    }
    run, cmd, kwargs = execute(params)

    assert cmd[:2] == ["docker", "compose"]
    assert "--build" in cmd
    assert cmd[-1] == server.SERVICE
    env_args = {cmd[i + 1] for i, arg in enumerate(cmd) if arg == "-e"}
    assert {
        "BUG_ID=1",
        "ETP=standard",
        "EASYLIST=true",
        "PRIVATE=true",
        "ETP_FILTER_LIST_BASE_URL=http://host.docker.internal:8123/api/filter-lists",
    } <= env_args
    assert not any(arg.startswith("EASYPRIVACY=") for arg in env_args)
    assert kwargs["cwd"] == server.REPO_ROOT
    assert run.status == server.RunStatus.OK


def test_execute_docker_without_build_or_lists(popen):
    _, cmd, _ = execute({"bug_id": 1, "etp": "strict", "build": False})
    assert "--build" not in cmd
    assert not any(arg.startswith("ETP_FILTER_LIST_BASE_URL=") for arg in cmd)


def test_execute_native(popen, monkeypatch):
    monkeypatch.setattr(server, "LOCAL_FIREFOX", "/ff/firefox")
    cache_lists(easylist=EASYLIST, easyprivacy=EASYPRIVACY)
    params = {
        "bug_id": 2,
        "etp": "off",
        "easylist": True,
        "easyprivacy": True,
        "private": False,
        "build": True,
    }
    _, cmd, kwargs = execute(params)

    assert cmd[:2] == ["uv", "run"]
    assert "--build" not in cmd
    assert "docker" not in cmd
    env = kwargs["env"]
    assert env["ETP"] == "off"
    assert env["EASYLIST"] == env["EASYPRIVACY"] == "true"
    assert "PRIVATE" not in env or env["PRIVATE"] != "true"
    assert env["LOCAL_FIREFOX"] == "/ff/firefox"
    assert env["ETP_FILTER_LIST_BASE_URL"] == "http://127.0.0.1:8123/api/filter-lists"
    assert kwargs["cwd"] == server.AGENT_DIR


def test_execute_fetches_missing_lists_once(popen, monkeypatch):
    cache_lists(easylist=EASYLIST)
    fetched = []

    def get(url, timeout):
        fetched.append(url)
        return FakeResponse(EASYPRIVACY)

    monkeypatch.setattr(server.requests, "get", get)
    execute({"bug_id": 1, "etp": "strict", "easylist": True, "easyprivacy": True})
    assert fetched == [server.FILTER_LIST_URLS["easyprivacy"]]
    assert server.filter_list_info("easyprivacy")["version"] == "202611170900"


@pytest.mark.parametrize(
    ("params", "expected"),
    [
        ({}, {}),
        (
            {"exceptions_baseline": True, "exceptions_convenience": True},
            {"EXCEPTIONS_BASELINE": "true", "EXCEPTIONS_CONVENIENCE": "true"},
        ),
        ({"exceptions_baseline": False}, {"EXCEPTIONS_BASELINE": "false"}),
        (
            {"exceptions_baseline": None, "exceptions_convenience": False},
            {"EXCEPTIONS_CONVENIENCE": "false"},
        ),
    ],
)
def test_execute_passes_exception_overrides(popen, monkeypatch, params, expected):
    monkeypatch.setattr(server, "LOCAL_FIREFOX", "/ff/firefox")
    for name in ("EXCEPTIONS_BASELINE", "EXCEPTIONS_CONVENIENCE"):
        monkeypatch.delenv(name, raising=False)
    _, _, kwargs = execute({"bug_id": 1, "etp": "strict"} | params)
    env = kwargs["env"]
    assert {
        name: env[name]
        for name in ("EXCEPTIONS_BASELINE", "EXCEPTIONS_CONVENIENCE")
        if name in env
    } == expected


def test_execute_passes_legacy_retest_mode(popen):
    _, cmd, _ = execute({"bug_id": 1, "etp": "strict", "mode": "retest"})
    env_args = {cmd[i + 1] for i, arg in enumerate(cmd) if arg == "-e"}
    assert "MODE=retest" in env_args
    assert not any(arg.startswith("EXCEPTIONS_") for arg in env_args)


def test_start_accepts_exception_overrides_and_legacy_retest(client):
    response = client.post(
        "/api/runs",
        json={"bug_id": 1, "etp": "strict", "exceptions_convenience": True},
    )
    assert response.status_code == 200
    params = response.json()["params"]
    assert params["exceptions_baseline"] is None
    assert params["exceptions_convenience"] is True

    response = client.post("/api/runs", json={"bug_id": 2, "mode": "retest"})
    assert response.status_code == 200
    assert response.json()["params"]["mode"] == "retest"

    response = client.post(
        "/api/runs", json={"bug_id": 3, "exceptions_baseline": "maybe"}
    )
    assert response.status_code == 422


# --- batches -------------------------------------------------------------------


def test_batch_expands_bugs_and_configs(client):
    configs = [
        {"etp": "strict"},
        {"etp": "off", "easylist": True, "private": True},
    ]
    response = client.post(
        "/api/runs/batch",
        json={"bug_ids": [10, 20], "configs": configs, "build": True},
    )
    assert response.status_code == 200
    params = [run["params"] for run in response.json()]
    assert [(p["bug_id"], p["etp"]) for p in params] == [
        (10, "strict"),
        (10, "off"),
        (20, "strict"),
        (20, "off"),
    ]
    assert [p["build"] for p in params] == [True, False, False, False]
    assert params[1]["easylist"] and params[1]["private"]
    assert not params[0]["easylist"] and not params[0]["private"]
    assert server.RUN_QUEUE.qsize() == 4


def test_batch_configs_carry_exception_overrides(client):
    configs = [
        {"etp": "strict"},
        {"etp": "strict", "exceptions_convenience": True},
        {"etp": "standard", "exceptions_baseline": False},
    ]
    response = client.post(
        "/api/runs/batch",
        json={"bug_ids": [10], "configs": configs, "mode": "retest"},
    )
    params = [run["params"] for run in response.json()]
    assert [
        (p["etp"], p["exceptions_baseline"], p["exceptions_convenience"])
        for p in params
    ] == [("strict", None, None), ("strict", None, True), ("standard", False, None)]
    # A legacy top-level mode still applies to every configuration.
    assert {p["mode"] for p in params} == {"retest"}


def test_batch_without_configs_uses_request_target(client):
    response = client.post(
        "/api/runs/batch", json={"bug_ids": [10], "etp": "standard", "private": True}
    )
    [run] = response.json()
    assert run["params"]["etp"] == "standard" and run["params"]["private"]


def test_batch_native_needs_local_firefox(client):
    response = client.post("/api/runs/batch", json={"bug_ids": [10], "native": True})
    assert response.status_code == 400
    assert "LOCAL_FIREFOX" in response.json()["detail"]
    assert server.RUN_QUEUE.qsize() == 0


# --- compare -------------------------------------------------------------------


def write_run(artifacts, run_id, params, result):
    path = artifacts / run_id
    path.mkdir()
    meta = {"run_id": run_id, "params": params, "status": "ok", "started": 1.0}
    (path / server.META_FILE).write_text(json.dumps(meta))
    summary = {"status": "ok", "findings": {"result": result}}
    (path / "summary.json").write_text(json.dumps(summary))
    return path


def test_compare(client, isolated):
    shots = write_run(
        isolated,
        "etp-bug5-20261117-100000",
        {"bug_id": 5, "etp": "off", "easylist": True},
        {
            "etp": "off",
            "filter_lists": ["easylist"],
            "filter_list_versions": {"easylist": "202611170830"},
            "private": False,
            "mode": "investigate",
            "exceptions_baseline": True,
            "exceptions_convenience": False,
            "broken_in_baseline": False,
            "broken_in_target": True,
            "screenshot_urls": {"target": "shots/target.png", "gone": "x.png"},
        },
    )
    (shots / "shots").mkdir()
    (shots / "shots" / "target.png").write_bytes(b"png")
    write_run(
        isolated,
        "etp-bug5-20261101-100000",
        {"bug_id": 5},
        {"broken_in_standard": False, "broken_in_strict": True},
    )
    write_run(isolated, "etp-bug6-20261117-100000", {"bug_id": 6}, {})

    response = client.get("/api/bugs/5/compare")
    assert response.status_code == 200
    rows = {row["run_id"]: row for row in response.json()}
    assert set(rows) == {"etp-bug5-20261117-100000", "etp-bug5-20261101-100000"}

    new = rows["etp-bug5-20261117-100000"]
    assert new["etp"] == "off"
    assert new["filter_lists"] == ["easylist"]
    assert new["filter_list_versions"] == {"easylist": "202611170830"}
    assert (new["broken_in_baseline"], new["broken_in_target"]) == (False, True)
    assert new["screenshots"] == {"target": "shots/target.png"}
    assert (new["exceptions_baseline"], new["exceptions_convenience"]) == (True, False)

    legacy = rows["etp-bug5-20261101-100000"]
    assert (legacy["broken_in_baseline"], legacy["broken_in_target"]) == (False, True)
    assert legacy["etp"] is None and legacy["has_result"]
    assert legacy["exceptions_baseline"] is None


# --- models --------------------------------------------------------------------


def test_models_fallback_when_sdk_fails(client, monkeypatch):
    def broken(**kwargs):
        raise RuntimeError("no network")

    monkeypatch.setattr(server.anthropic, "Anthropic", broken)
    body = client.get("/api/models").json()
    assert body["fallback"] is True
    assert [m["id"] for m in body["models"]] == [
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
        "claude-fable-5-2",
    ]
    assert all(m["display_name"] for m in body["models"])
    assert server.MODELS_CACHE is None


def test_models_listed_newest_first_and_cached(client, monkeypatch):
    from datetime import datetime
    from types import SimpleNamespace

    calls = []

    class FakeClient:
        def __init__(self, **kwargs):
            self.models = self

        def list(self):
            calls.append(1)
            return [
                SimpleNamespace(
                    id="old", display_name="Old", created_at=datetime(2025, 1, 1)
                ),
                SimpleNamespace(
                    id="new", display_name="New", created_at=datetime(2026, 11, 1)
                ),
            ]

    monkeypatch.setattr(server.anthropic, "Anthropic", FakeClient)
    for _ in range(2):
        body = client.get("/api/models").json()
        assert body == {
            "models": [
                {"id": "new", "display_name": "New"},
                {"id": "old", "display_name": "Old"},
            ],
            "fallback": False,
        }
    assert len(calls) == 1


# --- filter lists ----------------------------------------------------------------


def test_filter_lists_empty(client):
    lists = client.get("/api/filter-lists").json()
    assert [(item["name"], item["present"], item["version"]) for item in lists] == [
        ("easylist", False, None),
        ("easyprivacy", False, None),
    ]
    assert client.get("/api/filter-lists/easylist.txt").status_code == 404
    assert client.get("/api/filter-lists/other.txt").status_code == 404


def test_filter_lists_fetch_and_serve(client, monkeypatch):
    bodies = {
        server.FILTER_LIST_URLS["easylist"]: EASYLIST,
        server.FILTER_LIST_URLS["easyprivacy"]: EASYPRIVACY,
    }
    monkeypatch.setattr(
        server.requests, "get", lambda url, timeout: FakeResponse(bodies[url])
    )
    response = client.post("/api/filter-lists/fetch")
    assert response.status_code == 200
    lists = {item["name"]: item for item in response.json()}
    assert lists["easylist"]["version"] == "202611170830"
    assert lists["easyprivacy"]["version"] == "202611170900"
    assert lists["easylist"]["present"] and lists["easylist"]["modified"]
    assert client.get("/api/filter-lists").json() == response.json()

    served = client.get("/api/filter-lists/easylist.txt")
    assert served.status_code == 200
    assert served.headers["content-type"].startswith("text/plain")
    assert served.text == EASYLIST
    assert not list(server.FILTER_LISTS_DIR.glob(".*.tmp"))


def test_filter_lists_fetch_failure_keeps_cache(client, monkeypatch):
    cache_lists(easylist=EASYLIST)
    monkeypatch.setattr(
        server.requests, "get", lambda url, timeout: FakeResponse("<html>", 200)
    )
    response = client.post("/api/filter-lists/fetch")
    assert response.status_code == 502
    assert server.filter_list_info("easylist")["version"] == "202611170830"

    monkeypatch.setattr(
        server.requests, "get", lambda url, timeout: FakeResponse("", 503)
    )
    assert client.post("/api/filter-lists/fetch").status_code == 502
    assert (server.FILTER_LISTS_DIR / "easylist.txt").read_text() == EASYLIST
