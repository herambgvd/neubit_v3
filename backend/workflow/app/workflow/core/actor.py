"""Reading the acting user out of a kernel ``Principal``.

Best-effort on purpose: a system-initiated write (escalation sweep, correlation
engine) has no Principal, and NULL is the truthful stamp there.
"""

from __future__ import annotations


def actor_id(actor) -> str | None:
    """Best-effort user_id from a kernel Principal (or None)."""
    uid = getattr(actor, "user_id", None)
    return str(uid) if uid else None


def actor_name(actor) -> str | None:
    """Best-effort display NAME from a kernel Principal (or None).

    The rows this service stamps are read by people: "set by Priya Nair" is an
    answer, "set by 3cd1c8ca-c927-41af-…" is a lookup nobody can do from the
    screen it appears on. Core puts the name in the access token, so this needs
    no call. None for a system write, a service principal, or a token minted
    before the claim existed — every consumer falls back to the id.
    """
    name = getattr(actor, "name", None)
    name = str(name).strip() if name else ""
    return name or None
