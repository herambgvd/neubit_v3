#!/bin/bash
# Create the per-service databases on the shared Postgres.
#
# IMPORTANT: Postgres only runs /docker-entrypoint-initdb.d/* scripts on a FRESH
# data volume (first init). On an EXISTING volume this is a no-op — create the DBs
# manually instead (see deploy notes / the orchestrator runs them):
#
#   docker compose exec postgres createdb -U "$POSTGRES_USER" neubit_ingest
#   docker compose exec postgres createdb -U "$POSTGRES_USER" neubit_workflow
#
# The control DB (POSTGRES_DB, e.g. neubit_control) is created by the base image.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE DATABASE neubit_ingest'
      WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'neubit_ingest')\gexec
    SELECT 'CREATE DATABASE neubit_workflow'
      WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'neubit_workflow')\gexec
EOSQL

echo "init-service-dbs: ensured neubit_ingest + neubit_workflow exist"
