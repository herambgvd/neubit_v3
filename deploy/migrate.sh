#!/usr/bin/env bash
# Run a service's Alembic migrations correctly on BOTH a fresh and an existing DB.
#
# Why this is not just `alembic upgrade head`:
#
# ingest, access and vision all use the "v3 baseline" pattern — their 0001 revision
# builds the schema from the LIVE ORM metadata with `Table.create(checkfirst=True)`,
# so on a fresh database the baseline alone produces the CURRENT schema. Every later
# revision is then a no-op that does not merely waste time, it FAILS:
#
#   * an ADD COLUMN hits a column the baseline just created
#       vision 0025 → DuplicateColumnError: column "credential" of relation
#       "media_nodes" already exists
#   * a DROP COLUMN hits one the current models no longer define
#       vision 0026 → column "dewarp_pos" does not exist
#
# 14 of vision's 28 revisions carry such an operation. Patching them one by one
# treats the symptom; the baseline's own contract is the cause, and the fix is to
# stop replaying history that a metadata build has already folded in.
#
# This failure is invisible on any database that already exists — which is every
# developer's — and fires on every first install. It was found by the appliance P0
# spike: on a fresh volume, vision exited 1 and the VMS service never came up.
#
# On an existing database nothing is stamped that has not actually run, so an
# upgrade in the field behaves exactly as before.
set -euo pipefail

BASELINE="${1:?usage: migrate.sh <baseline-revision-id>}"

current="$(alembic current 2>/dev/null | tr -d '[:space:]' || true)"

if [ -z "$current" ]; then
  echo "migrate: fresh database — building schema from $BASELINE, then stamping head"
  alembic upgrade "$BASELINE"
  alembic stamp head
else
  echo "migrate: existing database at '$current' — replaying to head"
  alembic upgrade head
fi
