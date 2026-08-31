#!/usr/bin/env bash
#
# Core schema bring-up. Run this instead of a bare `alembic upgrade head`.
#
# WHY THIS EXISTS
# ---------------
# The 0001 baseline does not describe the schema as it stood in July 2026 — it
# calls `Base.metadata.create_all()`, so it always builds the CURRENT ORM schema,
# whatever that is today. Everything 0002..NNNN would add is therefore already
# there the moment 0001 finishes, and running them on a fresh database collides
# ("relation already exists", "column already exists").
#
# The old workaround was `alembic upgrade 0001 && alembic stamp head` for every
# start, on every database. That is correct for a FRESH database and catastrophic
# for an EXISTING one: `stamp` writes the head revision into alembic_version
# WITHOUT running anything, so every migration authored after the last deploy is
# recorded as applied and never executed. A new table or column silently does not
# exist, and nothing reports an error. (This actually happened: 0017 was stamped,
# `permission_registrations` was never created, and it had to be made by hand.)
#
# So the decision has to be made per database, not per deployment:
#
#   fresh DB (no alembic_version)  ->  upgrade 0001 (create_all = current schema)
#                                      then stamp head, because the deltas are
#                                      already baked into what create_all built.
#   existing DB (has a revision)   ->  upgrade head, the ordinary incremental
#                                      path. Migrations authored since the last
#                                      deploy actually RUN.
#
# The invariant that makes both branches land on the same schema: 0001 mirrors
# the live ORM metadata, and every later revision must keep the ORM models and
# the migration in step. A migration that only moves DATA (0007's tenant
# backfill, 0016's actor_name backfill) is skipped on the fresh branch, which is
# correct — there is no data to backfill in an empty database.
#
# If you add a revision that does something create_all CANNOT reproduce from the
# ORM metadata — a raw-SQL index, a trigger, a seed row the app does not also
# create at startup — it will be missing on fresh databases. Put it in the ORM
# metadata, or make the app create it at startup, or this script needs a third
# branch.
set -euo pipefail

# `alembic current` prints the stamped revision, or nothing at all when the
# alembic_version table is absent. It never creates the table, so this is a
# read-only probe.
current="$(alembic current 2>/dev/null | tr -d '[:space:]' || true)"

if [ -z "$current" ]; then
  echo "[migrate] no alembic_version — fresh database: baseline + stamp head"
  alembic upgrade 0001
  alembic stamp head
else
  echo "[migrate] existing database at '${current}' — incremental upgrade to head"
  alembic upgrade head
fi

alembic current
