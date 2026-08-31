#!/bin/bash
# Create the per-service databases on the shared Postgres. IDEMPOTENT.
#
# THIS SCRIPT RUNS TWICE, ON PURPOSE
# ----------------------------------
#   1. As a Postgres initdb hook (/docker-entrypoint-initdb.d), on a FRESH volume.
#   2. As the `db-init` compose service, on EVERY `docker compose up`.
#
# (2) exists because (1) alone was the bug. Postgres runs initdb scripts only on
# first init, so every service added to this list AFTER a deployment's volume was
# created needed a manual `createdb` on that deployment — and the header of this
# very file used to say so, listing seven databases and telling the reader to
# create them by hand. Five services still had the problem. A deployment step
# that lives only in a comment is a deployment step that does not happen: the
# service starts, `alembic upgrade` fails to connect, and the container restarts
# in a loop that reads like a network fault.
#
# ADDING A SERVICE: add its database to DATABASES below and nothing else. Both
# entry points read the same list, so a fresh volume and a five-year-old one end
# up with the same set of databases.
#
# The control DB (POSTGRES_DB, e.g. neubit_control) is created by the base image.
# neubit_reporting is ALSO ensured by `reporting-migrate` (python -m
# reporting.ensure_db); the duplicate is harmless and keeps either path standalone.
set -euo pipefail

# Every database this platform's services own, one per line. `#` starts a comment.
DATABASES="
neubit_ingest        # external webhooks / event ingestion
neubit_workflow      # SOP / automation engine (+ its Celery worker and beat)
neubit_access        # access control: doors, credentials, events
neubit_vision        # VMS: cameras, recordings, exports
neubit_nvr           # the Go recorder's own store
neubit_reporting     # IoT reading store (TimescaleDB hypertables + rollups)
neubit_dashboards    # dashboard + widget definitions (no readings)
"

# psql connects over the local socket under the initdb hook (no PGHOST) and over
# TCP under the db-init service (PGHOST/PGPASSWORD supplied by compose). Same
# command either way.
created=()
existing=()
while read -r line; do
  db="${line%%#*}"
  db="${db// /}"
  [ -z "$db" ] && continue
  if psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
       -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1; then
    existing+=("$db")
  else
    # CREATE DATABASE cannot run inside a transaction block, so it is its own
    # statement rather than part of a heredoc. The existence check above makes
    # the whole thing idempotent; a concurrent create just loses the race and is
    # tolerated, because the database exists either way.
    psql -v ON_ERROR_STOP=0 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
      -c "CREATE DATABASE \"$db\"" >/dev/null 2>&1 || true
    created+=("$db")
  fi
done <<< "$DATABASES"

echo "init-service-dbs: created=[${created[*]-}] already-present=[${existing[*]-}]"

# Fail loudly if anything is still missing. A database that could not be created
# must not be discovered later as a service restart loop.
missing=()
while read -r line; do
  db="${line%%#*}"; db="${db// /}"
  [ -z "$db" ] && continue
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1 || missing+=("$db")
done <<< "$DATABASES"
if [ ${#missing[@]} -gt 0 ]; then
  echo "init-service-dbs: FAILED to create: ${missing[*]}" >&2
  exit 1
fi
