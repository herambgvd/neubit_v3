"""Platform alerts — a super-admin alert inbox derived from live platform state.

Alerts are COMPUTED on demand from existing data (expiring/expired licenses, user
quota breaches, overdue invoices, past-due subscriptions, suspended tenants) rather
than stored as events. Only the per-admin read/dismiss STATE is persisted (the
``alert_states`` table), so the inbox reflects current reality without a background
job to keep an events table in sync.

Everything is gated by ``require_superadmin``.
"""

from .router import router

__all__ = ["router"]
