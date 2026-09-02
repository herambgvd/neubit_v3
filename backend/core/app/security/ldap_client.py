"""LDAP / Active Directory client abstraction — pluggable + mockable.

The real bind talks to a directory server via ``ldap3`` (an OPTIONAL dependency,
imported lazily). To keep the sync/mapping logic verifiable WITHOUT a live server,
everything routes through an injectable :class:`LdapClient` protocol; tests swap in
:class:`FakeLdapClient` with in-memory fixture entries and exercise the exact same
bind → search → map path.

⚠️ LIVE-VALIDATE: the ``Ldap3Client`` path (real bind against ad.corp) is unrun in
CI — validate against a real LDAP/AD server at deployment.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class LdapEntry:
    """One directory entry, normalised to the attributes we consume."""

    dn: str
    email: str | None = None
    display_name: str | None = None
    groups: list[str] = field(default_factory=list)
    username: str | None = None


class LdapError(Exception):
    """Raised for bind/search failures (bad creds, server unreachable, no result)."""


class LdapClient(Protocol):
    """The surface the sync service depends on — real or fake."""

    def authenticate(self, username: str, password: str) -> LdapEntry:
        """Bind AS the user (login). Returns their entry or raises LdapError."""
        ...

    def search_users(self) -> list[LdapEntry]:
        """Bind with the service account and return all matching user entries."""
        ...


class FakeLdapClient:
    """In-memory directory for fixtures/tests. Deterministic, no network.

    ``entries`` maps username -> (password, LdapEntry). ``search_users`` returns
    every entry; ``authenticate`` checks the fixture password.
    """

    def __init__(self, entries: dict[str, tuple[str, LdapEntry]]):
        self._entries = entries

    def authenticate(self, username: str, password: str) -> LdapEntry:
        rec = self._entries.get(username)
        if rec is None or rec[0] != password:
            raise LdapError("invalid credentials")
        return rec[1]

    def search_users(self) -> list[LdapEntry]:
        return [e for (_pw, e) in self._entries.values()]


def build_client(config, bind_password: str | None) -> LdapClient:
    """Construct the real ``ldap3``-backed client from a DirectoryConfig row.

    Imported lazily so core boots without ``ldap3`` installed. Raises LdapError with
    a clear message if the dependency is missing.
    """
    try:
        from .ldap3_client import Ldap3Client  # noqa: PLC0415 — lazy optional dep
    except ImportError as exc:  # pragma: no cover - depends on optional install
        raise LdapError(
            "ldap3 is not installed — install the 'directory' extra to enable live LDAP"
        ) from exc
    return Ldap3Client(config, bind_password)  # pragma: no cover - live path
