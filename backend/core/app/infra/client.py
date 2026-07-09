"""Thin async httpx client to the ops-agent sidecar.

The ops-agent lives on the internal `neubit` network with no host port. Only
`core` can reach it. Every request carries the shared ``X-Ops-Token`` secret so
the agent can authenticate the caller (core, acting for a super-admin).

Config comes from the environment (NOT the VE_-prefixed Settings, to keep the
agent wiring self-contained and match the compose env names):
    OPS_AGENT_URL    base URL of the agent  (default http://ops-agent:9000)
    OPS_AGENT_TOKEN  shared secret sent as X-Ops-Token
"""

from __future__ import annotations

import os

import httpx
from fastapi import HTTPException


def _base_url() -> str:
    return os.getenv("OPS_AGENT_URL", "http://ops-agent:9000").rstrip("/")


def _token() -> str:
    return os.getenv("OPS_AGENT_TOKEN", "")


class OpsAgentClient:
    """Small wrapper mapping ops-agent HTTP calls to Python coroutines.

    Each method opens a short-lived AsyncClient (the agent is on the local docker
    network, so connection setup is cheap and this keeps lifecycle trivial). Agent
    errors are surfaced to the API caller with the agent's status code preserved
    where sensible; transport failures become 502/503.
    """

    def __init__(self, timeout: float = 30.0) -> None:
        self._timeout = timeout

    def _headers(self) -> dict[str, str]:
        return {"X-Ops-Token": _token()}

    async def _request(self, method: str, path: str, **kwargs):
        url = f"{_base_url()}{path}"
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.request(method, url, headers=self._headers(), **kwargs)
        except httpx.HTTPError as exc:
            # Agent unreachable / timed out — the infra control plane is down.
            raise HTTPException(
                status_code=503,
                detail=f"ops-agent unreachable: {exc}",
            ) from exc
        if resp.status_code >= 400:
            # Propagate the agent's error (401/404/502...) to the super-admin.
            try:
                detail = resp.json().get("detail", resp.text)
            except (ValueError, AttributeError):
                detail = resp.text
            raise HTTPException(status_code=resp.status_code, detail=detail)
        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()

    # --- Endpoint wrappers ---------------------------------------------------
    async def list_containers(self):
        return await self._request("GET", "/containers")

    async def logs(self, name: str, tail: int = 200):
        return await self._request("GET", f"/containers/{name}/logs", params={"tail": tail})

    async def restart(self, name: str):
        return await self._request("POST", f"/containers/{name}/restart")

    async def stop(self, name: str):
        return await self._request("POST", f"/containers/{name}/stop")

    async def start(self, name: str):
        return await self._request("POST", f"/containers/{name}/start")

    async def scale(self, name: str, replicas: int):
        return await self._request(
            "POST", f"/services/{name}/scale", json={"replicas": replicas}
        )

    async def host(self):
        return await self._request("GET", "/host")

    async def db_export(self) -> bytes:
        """Fetch a raw SQL dump of the control DB (bytes, not JSON)."""
        url = f"{_base_url()}/db/export"
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                resp = await client.get(url, headers=self._headers())
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=503, detail=f"ops-agent unreachable: {exc}") from exc
        if resp.status_code >= 400:
            try:
                detail = resp.json().get("detail", resp.text)
            except (ValueError, AttributeError):
                detail = resp.text
            raise HTTPException(status_code=resp.status_code, detail=detail)
        return resp.content

    async def db_import(self, sql: bytes) -> dict:
        """Restore the control DB from a raw SQL dump. Returns the psql outcome."""
        url = f"{_base_url()}/db/import"
        try:
            async with httpx.AsyncClient(timeout=200.0) as client:
                resp = await client.post(
                    url,
                    headers={**self._headers(), "Content-Type": "application/sql"},
                    content=sql,
                )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=503, detail=f"ops-agent unreachable: {exc}") from exc
        if resp.status_code >= 400:
            try:
                detail = resp.json().get("detail", resp.text)
            except (ValueError, AttributeError):
                detail = resp.text
            raise HTTPException(status_code=resp.status_code, detail=detail)
        return resp.json()
