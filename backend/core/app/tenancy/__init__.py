"""Multi-tenancy: the Tenant model + super-admin dependency + startup seeding.

v1 uses tenant_id row-scoping against a single shared control DB — this is the
testable, pragmatic first cut. DB-per-tenant (a physical database per tenant, for
hard isolation) is the production hardening target; the code comments flag the
seams where that swap would land.
"""
