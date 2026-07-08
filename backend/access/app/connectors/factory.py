"""Connector factory — pick a ControllerConnector by ``instance.brand``.

This is the seam that makes future controller brands pluggable. v2 hardcoded DDS
everywhere; here the service layer only ever calls ``get_connector(instance,
secret)`` and gets back something implementing ``ControllerConnector``. Adding a
brand (ESSL, …) = add a module + one line here, no service changes.

The caller decrypts the instance secret first (the factory/connector never touch
the DB or the encryption key). ``secret`` may be empty for an unconfigured
instance — the connector will simply fail ``test_connection`` gracefully.
"""

from __future__ import annotations

from typing import Any

from .base import ControllerConnector
from .dds import DDSConnector


def get_connector(instance: Any, *, secret: str = "") -> ControllerConnector:
    """Return the connector for ``instance.brand``.

    ``instance`` is an ``Instance`` ORM row (or anything exposing ``brand`` /
    ``base_url`` / ``auth_type`` / ``username``). Raises ``NotImplementedError``
    for a brand with no connector yet (clear, not a silent fallback).
    """
    brand = (getattr(instance, "brand", None) or "dds").lower()

    if brand == "dds":
        return DDSConnector(
            base_url=instance.base_url,
            auth_type=getattr(instance, "auth_type", "basic") or "basic",
            username=getattr(instance, "username", "") or "",
            secret=secret,
            verify_tls=bool(getattr(instance, "verify_tls", False)),
        )

    raise NotImplementedError(
        f"no connector implemented for controller brand '{brand}' "
        f"(only 'dds' is supported in this phase)"
    )
