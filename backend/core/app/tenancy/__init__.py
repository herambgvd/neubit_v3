"""Multi-tenancy: the Tenant model + super-admin dependency + startup seeding.

v1 uses tenant_id row-scoping against a single shared control DB — this is the
testable, pragmatic first cut. DB-per-tenant (a physical database per tenant, for
hard isolation) is the production hardening target; the code comments flag the
seams where that swap would land.

The row-scoping primitive lives in ``scope.py``: ``get_scope`` (a FastAPI
dependency), ``scope_of(user)`` (build one from a User a service already holds),
``scoped(stmt, model, scope)`` for list reads, and ``assert_owned(obj, scope)`` for
by-id ownership checks. Import them from ``app.tenancy.scope`` (kept out of this
package ``__init__`` to avoid import-order coupling with ``app.auth``).
"""
