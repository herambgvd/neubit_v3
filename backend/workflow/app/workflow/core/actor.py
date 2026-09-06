"""Reading the acting user out of a kernel ``Principal``.

Best-effort on purpose: a system-initiated write (escalation sweep, correlation
engine) has no Principal, and NULL is the truthful stamp there.
"""

from __future__ import annotations


def actor_id(actor) -> str | None:
    """Best-effort user_id from a kernel Principal (or None)."""
    uid = getattr(actor, "user_id", None)
    return str(uid) if uid else None
