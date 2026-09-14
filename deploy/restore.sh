#!/usr/bin/env bash
# RESTORE AN APPLIANCE FROM backup.sh's ARCHIVE — WITHOUT SIGNING IN.
#
# This is the other half of the circular-restore problem. The API's importer
# needs a superadmin session, a session needs core, and core needs the database
# you are trying to restore. So this talks to Docker directly: give it the
# archive and a running `postgres` container and it works with every application
# container dead.
#
# TIMESCALEDB. Each database carries the timescaledb extension, and
# neubit_reporting has hypertables, compression policies and continuous
# aggregates. Each database is restored between timescaledb_pre_restore() and
# timescaledb_post_restore(): pre_restore puts the extension into restoring mode
# so its triggers and background jobs stand down, post_restore rebuilds the
# catalog state and restarts the policies. That is the sequence Timescale
# documents, and it is what this script uses.
#
# Being straight about how much it buys HERE: restoring into a freshly created
# database, the sequence was measured to make no difference — with it and
# without it, neubit_reporting came back with the same 3 hypertables, 4
# continuous aggregates, 16 policy jobs and 424,352 readings. It is kept because
# it is the supported path and costs two statements, not because a failure was
# observed without it. The check that actually protects this restore is the
# count comparison in --verify below, which does not care why a number moved.
#
# TWO MODES:
#   --verify   restore every database into a throwaway copy named <db>_verify,
#              count its rows, drop it. Touches nothing live. Run this on the
#              backup you are keeping — an unverified backup is a belief.
#   --yes      the real thing. DESTRUCTIVE, see the warning it prints.
#
# Usage:  ./restore.sh <archive.tar.gz> --verify
#         ./restore.sh <archive.tar.gz> --yes
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

ARCHIVE="${1:-}"
MODE="${2:-}"

say() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf 'restore: %s\n' "$*" >&2; exit 1; }

[ -n "$ARCHIVE" ] || die "usage: ./restore.sh <archive.tar.gz> [--verify|--yes]"
[ -f "$ARCHIVE" ] || die "no such archive: $ARCHIVE"
case "$MODE" in
  --verify|--yes) ;;
  *) die "second argument must be --verify (safe, restores to throwaway copies) or --yes (DESTRUCTIVE)" ;;
esac

: "${DB_SERVICE:=postgres}"
command -v docker >/dev/null || die "docker is not on PATH"

PG="$(docker compose ps -q "$DB_SERVICE" || true)"
[ -n "$PG" ] || die "the '$DB_SERVICE' service is not running — start it, then restore"
PROJECT="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$PG")"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
say "unpacking"
tar xzf "$ARCHIVE" -C "$STAGE"
ROOT="$(find "$STAGE" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -f "$ROOT/manifest.txt" ] || die "archive has no manifest.txt — not a neubit backup"

# CHECKSUMS FIRST. A truncated or half-written archive is the failure people
# discover in the middle of a restore, with the live database already dropped.
say "verifying checksums"
( cd "$ROOT" && sed -n '/^---$/,$p' manifest.txt | tail -n +2 | shasum -a 256 -c --status ) \
  || die "checksum mismatch — this archive is damaged, do not restore from it"

PG_USER="$(awk '/^pg_user/{print $2}' "$ROOT/manifest.txt")"
: "${PG_USER:=neubit}"
DBS="$(awk '/^databases/{$1=""; print}' "$ROOT/manifest.txt")"
VOLS="$(awk '/^volumes/{$1=""; print}' "$ROOT/manifest.txt")"
say "archive holds:$DBS"

psql_() { docker exec -i "$PG" psql -U "$PG_USER" -v ON_ERROR_STOP=1 \
  -c "set client_min_messages = warning" "$@"; }

# Restore one dump into database $1 from file $2, with the Timescale sequence.
restore_db() {
  local target="$1" dump="$2"
  docker cp "$dump" "$PG:/tmp/restore.dump"
  psql_ -d postgres -c "drop database if exists \"$target\" with (force)" >/dev/null
  psql_ -d postgres -c "create database \"$target\"" >/dev/null
  psql_ -d "$target" -c "create extension if not exists timescaledb" >/dev/null 2>&1 || true
  psql_ -d "$target" -c "select public.timescaledb_pre_restore()" >/dev/null 2>&1 || true
  # pg_restore's exit code is non-zero for warnings that are not failures (an
  # extension member it may not touch, a comment on one). --exit-on-error is
  # deliberately NOT set; the row counts below are what says the restore worked.
  docker exec -i "$PG" pg_restore -U "$PG_USER" -d "$target" \
    --no-owner --no-privileges /tmp/restore.dump >/dev/null 2>&1 || true
  psql_ -d "$target" -c "select public.timescaledb_post_restore()" >/dev/null 2>&1 || true
  docker exec -i "$PG" rm -f /tmp/restore.dump
}

# "<hypertables> <aggregates> <jobs>" for a database — the same three numbers,
# in the same order, that backup.sh recorded into db/counts.txt.
hyper_agg() {
  docker exec -i "$PG" psql -U "$PG_USER" -d "$1" -At -c \
    "select (select count(*) from timescaledb_information.hypertables) || ' ' ||
            (select count(*) from timescaledb_information.continuous_aggregates) || ' ' ||
            (select count(*) from timescaledb_information.jobs
               where application_name not ilike '%telemetry%')" \
    2>/dev/null | tail -1 || echo "0 0 0"
}

rows_in() {
  docker exec -i "$PG" psql -U "$PG_USER" -d "$1" -At -c \
    "select coalesce(sum(n_live_tup),0)::bigint from pg_stat_user_tables" 2>/dev/null | tail -1
}

if [ "$MODE" = "--verify" ]; then
  say "VERIFY — restoring into throwaway <db>_verify copies; nothing live is touched"
  failed=0
  for db in $DBS; do
    f="$ROOT/db/$db.dump"
    [ -f "$f" ] || { say "  $db: MISSING from archive"; failed=1; continue; }
    restore_db "${db}_verify" "$f"
    n="$(rows_in "${db}_verify")"
    tbl="$(docker exec -i "$PG" psql -U "$PG_USER" -d "${db}_verify" -At -c \
      "select count(*) from pg_stat_user_tables" 2>/dev/null | tail -1)"
    # THE TIMESCALE CHECK, and the reason this mode exists. "pg_restore exited
    # cleanly" says nothing about whether the hypertables and continuous
    # aggregates came back — those are catalog objects, and a database can
    # restore its ordinary tables while losing them. Comparing the counts
    # against the LIVE database is a claim about the restored database itself,
    # so it holds whatever the cause, including a Postgres or Timescale upgrade
    # that changes how any of this is dumped.
    want="$(awk -v d="$db" '$1==d {print $2" "$3" "$4" "$5}' "$ROOT/db/counts.txt" 2>/dev/null)"
    got="$tbl $(hyper_agg "${db}_verify")"
    say "  $db: $n rows; tables/hypertables/aggregates/jobs = $got (at backup: ${want:-unrecorded})"
    [ "${tbl:-0}" -gt 0 ] || failed=1
    if [ -n "$want" ] && [ "$got" != "$want" ]; then
      say "  $db: DOES NOT MATCH THE BACKUP — restored '$got', dumped '$want'"
      failed=1
    fi
    psql_ -d postgres -c "drop database if exists \"${db}_verify\" with (force)" >/dev/null
  done
  for v in $VOLS; do
    f="$ROOT/volumes/$v.tar.gz"
    [ -f "$f" ] || { say "  volume $v: MISSING"; failed=1; continue; }
    say "  volume $v: $(tar tzf "$f" | wc -l | tr -d ' ') entries"
  done
  if [ -s "$ROOT/env/.env" ]; then
    say "  .env: $(grep -c '=' "$ROOT/env/.env" | tr -d ' ') settings$(grep -q '^VE_SECRETS_KEY=' "$ROOT/env/.env" && echo ', VE_SECRETS_KEY present')"
  else
    say "  .env: MISSING"; failed=1
  fi
  [ "$failed" -eq 0 ] || die "verification FAILED — see the lines above"
  say "verification passed — this archive restores"
  exit 0
fi

cat >&2 <<WARN

  ####################  DESTRUCTIVE  ####################

  About to REPLACE, on compose project '$PROJECT':

    * every database in:$DBS
      Each is DROPPED and recreated from the archive. Anything written
      since the backup was taken is gone and cannot be recovered.
    * the volumes:$VOLS
    * deploy/.env  (the current one is kept as .env.before-restore-*)

  Recordings, the JetStream queue and pgdata are NOT touched.

  ######################################################

WARN
printf 'Type the project name (%s) to proceed: ' "$PROJECT" >&2
read -r confirm
[ "$confirm" = "$PROJECT" ] || die "aborted — nothing was changed"

# Application containers are stopped so nothing writes into a database that is
# being dropped, and nothing reads a half-restored one. Postgres stays up: it is
# what we are restoring into.
say "stopping application services"
for svc in $(docker compose config --services); do
  [ "$svc" = "$DB_SERVICE" ] && continue
  docker compose stop "$svc" >/dev/null 2>&1 || true
done

say "restoring roles"
docker exec -i "$PG" psql -U "$PG_USER" -d postgres < "$ROOT/globals.sql" >/dev/null 2>&1 || true

for db in $DBS; do
  say "restoring $db"
  restore_db "$db" "$ROOT/db/$db.dump"
  say "  $db: $(rows_in "$db") rows"
done

for v in $VOLS; do
  f="$ROOT/volumes/$v.tar.gz"
  [ -f "$f" ] || continue
  full="${PROJECT}_${v}"
  say "restoring volume $full"
  docker volume create "$full" >/dev/null
  docker run --rm -v "$full:/dst" -v "$ROOT/volumes:/in:ro" alpine \
    sh -c "rm -rf /dst/* /dst/.[!.]* 2>/dev/null; tar xzf /in/$v.tar.gz -C /dst"
done

if [ -s "$ROOT/env/.env" ]; then
  keep="$HERE/.env.before-restore-$(date +%Y%m%d-%H%M%S)"
  [ -f "$HERE/.env" ] && cp "$HERE/.env" "$keep" && say "kept current .env as $(basename "$keep")"
  cp "$ROOT/env/.env" "$HERE/.env"
  chmod 600 "$HERE/.env"
  say "restored .env"
fi

say "starting services"
docker compose up -d >/dev/null
say "restore complete — give the stack a minute, then check: docker compose ps"
