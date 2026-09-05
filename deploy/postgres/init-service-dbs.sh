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
  # neubit_nvr was ensured here until 2026-09-01. REMOVED: the locked
  # single-ownership architecture gives the NVR its OWN postgres (the
  # standalone appliance stack), and the live DSN audit showed no container on
  # this server has ever pointed at it — an empty database re-created on every
  # compose up was a placeholder for a deployment shape that no longer exists.
  # If a platform-hosted recorder ever returns, add its database back here
  # deliberately.
neubit_reporting     # IoT reading store (TimescaleDB hypertables + rollups)
  # neubit_dashboards held NeuBit's own dashboard builder and was ensured
  # here until 2026-09-03. REMOVED with the builder: DashForge is the
  # dashboarding surface now and nothing reads this database. The existing
  # one on a live server is deliberately NOT dropped -- see
  # docs/dashboard-builder-final-export-2026-09-03.json -- but a fresh
  # install has no reason to create it.
  # neubit_dashforge held the embed registry -- which DashForge dashboards
  # this platform shows -- and was ensured here from 2026-09-03 until
  # 2026-09-05. REMOVED: the dashforge satellite was folded into core
  # (backend/core/app/dashforge) and its one table now lives in the control
  # database, created by core migration 0022_dashforge_embeds. The live
  # database is deliberately NOT dropped -- it held 0 rows at the fold-in and
  # is left inert, because a code change is one revert and a dropped database
  # is not -- but a fresh install has no reason to create it.
  #
  # (This comment carried a backtick-quoted name when it was first written and
  # exited db-init 127 on the very next up, exactly as the NOTE at the bottom
  # of this string says it would. The note is not decorative.)
  #
  # The dashforge entry BELOW is a different database and stays: it is
  # DashForge's own, not this platform's, and it is the healthcheck's
  # completion marker.
dashforge            # DASHFORGE'S OWN database. Not a neubit_* name because it is
                     # not this platform's schema: DashForge owns it, migrates it
                     # and is the only thing that reads it. It lives on this
                     # Postgres for the same reason every entry above does -- one
                     # server to back up, tune and watch -- and NOT because the two
                     # products share anything. Composing DashForge in is done from
                     # NEUBIT deploy/ (docker-compose.dashforge.yml); a compose up
                     # in its own repo still brings up its own Postgres and must
                     # keep working untouched.
                     #
                     # NOTE FOR THE NEXT EDITOR: this list is a double-quoted bash
                     # string, so a backtick in a comment here is COMMAND
                     # SUBSTITUTION, not punctuation. One in this very block ran
                     # as a command and exited db-init 127, which surfaces as
                     # every service behind it refusing to start.
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
