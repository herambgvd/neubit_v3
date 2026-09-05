"""Reading the acting user out of a kernel ``Principal``.

One function, and it is here rather than copied into each feature's service
because every ``create``/``update`` in this domain stamps ``created_by`` /
``updated_by`` the same way. It is deliberately best-effort: a system-initiated
write (the escalation sweep, the correlation engine) has no Principal, and
stamping NULL is the truthful answer — not a placeholder user id.
"""

from __future__ import annotations


def actor_id(actor) -> str | None:
    """Best-effort user_id from a kernel Principal (or None)."""
    uid = getattr(actor, "user_id", None)
    return str(uid) if uid else None
