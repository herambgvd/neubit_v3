"""Test setup for the ops-agent.

The agent's whole job is the docker socket, so the tests give it a fake docker
client instead of a real one. Nothing here can reach a daemon — run-tests.sh
mounts no socket and gives the container no network.
"""

from __future__ import annotations

import httpx
import pytest

import main

TOKEN = "test-ops-token"


class FakeContainer:
    def __init__(self, name, *, service=None, project="neubit-v3", status="running"):
        self.name = name
        self.short_id = name[:12]
        self.status = status
        self.labels = {}
        if project:
            self.labels["com.docker.compose.project"] = project
        if service:
            self.labels["com.docker.compose.service"] = service
        self.attrs = {"State": {"Status": status, "Health": {"Status": "healthy"}},
                      "Created": "2026-01-01T00:00:00Z"}
        self.image = type("Img", (), {"tags": ["img:latest"], "short_id": "abc"})()
        self.actions: list[str] = []
        self.execs: list[list[str]] = []
        self.archives: list[bytes] = []
        self.exec_result = (0, (b"done", b""))

    def stats(self, stream=False):
        return {}

    def logs(self, tail=200, timestamps=True):
        return b"line one\nline two\n"

    def restart(self):
        self.actions.append("restart")

    def stop(self):
        self.actions.append("stop")

    def start(self):
        self.actions.append("start")

    def put_archive(self, path, data):
        self.archives.append(data)
        return True

    def exec_run(self, cmd, environment=None, demux=False):
        self.execs.append(cmd)
        return self.exec_result


class FakeDocker:
    def __init__(self, containers):
        self._containers = containers
        self.pinged = False
        self.ping_fails = False
        self.containers = self  # the SDK exposes client.containers.list/get

    def ping(self):
        self.pinged = True
        if self.ping_fails:
            raise RuntimeError("daemon unreachable")
        return True

    def list(self, all=False, filters=None):
        if filters and "label" in filters:
            want = filters["label"].split("=", 1)[1]
            return [c for c in self._containers
                    if (c.labels or {}).get("com.docker.compose.project") == want]
        return list(self._containers)

    def get(self, name):
        from docker.errors import NotFound

        for c in self._containers:
            if c.name == name:
                return c
        raise NotFound(f"no such container {name}")


@pytest.fixture
def containers():
    return [
        FakeContainer("neubit-v3-core-1", service="core"),
        FakeContainer("neubit-v3-postgres-1", service="postgres"),
        # Outside the compose project: must be invisible AND untouchable.
        FakeContainer("someone-elses-db", project=None),
    ]


@pytest.fixture
def docker_client(containers, monkeypatch):
    fake = FakeDocker(containers)
    monkeypatch.setattr(main, "_client", fake)
    monkeypatch.setattr(main, "OPS_AGENT_TOKEN", TOKEN)
    return fake


@pytest.fixture
async def client(docker_client):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app), base_url="http://t"
    ) as c:
        yield c


def auth(token: str = TOKEN) -> dict:
    return {"X-Ops-Token": token}
