"""Multi-tenancy: the Tenant model + super-admin dependency + startup seeding.

Row-scoping by tenant_id against a single shared control DB. DB-per-tenant is the
hardening target; the comments in ``models.py`` mark where that swap would land.

The row-scoping primitive lives in ``scope.py``: ``get_scope`` (a FastAPI
dependency), ``scope_of(user)`` (build one from a User a service already holds),
``scoped(stmt, model, scope)`` for list reads, and ``assert_owned(obj, scope)`` for
by-id ownership checks. Import them from ``app.tenancy.scope`` (kept out of this
package ``__init__`` to avoid import-order coupling with ``app.auth``).
"""
