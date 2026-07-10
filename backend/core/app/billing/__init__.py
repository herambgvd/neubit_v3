"""Billing — internal subscription & invoice records for the super-admin console.

Self-contained commercial layer (no external payment provider): a super-admin
defines Plans (tier catalog), assigns a Subscription to each tenant, and issues
Invoices tracked through their lifecycle (draft → issued → paid / overdue / void).

Plans can drive tenant entitlements: subscribing a tenant to a plan optionally
copies the plan's features/limits onto the tenant (so the license the operator
console enforces flows from the commercial plan).

Everything is gated by ``require_superadmin`` and audit-logged.
"""

from .router import router

__all__ = ["router"]
