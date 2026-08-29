#!/bin/bash
# Create the per-service databases on the shared Postgres.
#
# IMPORTANT: Postgres only runs /docker-entrypoint-initdb.d/* scripts on a FRESH
# data volume (first init). On an EXISTING volume this is a no-op — create the DBs
# manually instead (see deploy notes / the orchestrator runs them):
#
#   docker compose exec postgres createdb -U "$POSTGRES_USER" neubit_ingest
#   docker compose exec postgres createdb -U "$POSTGRES_USER" neubit_workflow
#   docker compose exec postgres createdb -U "$POSTGRES_USER" neubit_access
#   docker compose exec postgres createdb -U "$POSTGRES_USER" neubit_vision
#   docker compose exec postgres createdb -U "$POSTGRES_USER" neubit_nvr
#   docker compose exec postgres createdb -U "$POSTGRES_USER" neubit_reporting
#
# (neubit_reporting is also created automatically by the `reporting-migrate`
# service, which runs `python -m reporting.ensure_db` before its migrations — so
# on an existing volume that one needs no manual step.)
#
# The control DB (POSTGRES_DB, e.g. neubit_control) is created by the base image.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE DATABASE neubit_ingest'
      WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'neubit_ingest')\gexec
    SELECT 'CREATE DATABASE neubit_workflow'
      WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'neubit_workflow')\gexec
    SELECT 'CREATE DATABASE neubit_access'
      WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'neubit_access')\gexec
    SELECT 'CREATE DATABASE neubit_vision'
      WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'neubit_vision')\gexec
    SELECT 'CREATE DATABASE neubit_nvr'
      WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'neubit_nvr')\gexec
    -- Reporting store for the IoT readings pipeline (TimescaleDB hypertables).
    -- The timescaledb extension is preloaded into template1 by the image, so the
    -- new database inherits it; the migration also CREATE EXTENSION IF NOT EXISTS.
    SELECT 'CREATE DATABASE neubit_reporting'
      WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'neubit_reporting')\gexec
EOSQL

echo "init-service-dbs: ensured neubit_ingest + neubit_workflow + neubit_access + neubit_vision + neubit_nvr + neubit_reporting exist"
