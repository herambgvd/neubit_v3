#!/usr/bin/env bash
# A BACKUP THAT CAN ACTUALLY BRING THE APPLIANCE BACK.
#
# What existed before this script: `GET /admin/infra/db/export`, which dumps ONE
# database (neubit_control) and only after a superadmin has signed in. That is not
# a backup of this appliance, for two reasons.
#
#   1. It covers 12 MB of 240 MB. neubit_reporting (143 MB of readings),
#      neubit_vision, neubit_access, neubit_workflow, neubit_ingest, dashforge,
#      neubit_dashforge and neubit_dashboards are all outside it, as is
#      deploy/.env — which holds the ONLY copy of VE_SECRETS_KEY, the key every
#      stored credential in the platform is encrypted with. Lose that file and
#      the dumps decrypt to nothing.
#   2. Its restore path is circular. Importing needs a login, a login needs core,
#      core needs Postgres — so the one moment you need the restore is the one
#      moment you cannot reach it.
#
# So this runs on the HOST and talks to Docker directly. No login, no core, no
# API. If the database is empty and every service is crash-looping, this still
# works — that is the whole point.
#
# TIMESCALEDB. Every database here carries the timescaledb extension, and
# neubit_reporting has 3 hypertables, 4 continuous aggregates and 16 policy jobs.
# A hypertable is a parent table plus chunk tables plus catalog rows that tie
# them together, so "the tables restored" is not the same claim as "the database
# restored" — which is why restore.sh --verify counts those three things against
# the live database rather than trusting an exit code.
#
# Databases are dumped one at a time, in pg_dump's custom format, because that
# is the shape Timescale supports: pg_dumpall is documented as unsupported
# against it, and the custom format is what pg_restore's pre/post-restore
# sequence expects. Measured on this appliance, a custom-format dump restored
# into a freshly created database reproduces all three counts exactly, along
# with 424,352 readings.
#
# NOT IN HERE, deliberately:
#   * recordings / recordings2 / recordings_r1 — video, owned by the recorder,
#     hundreds of GB, and a different retention decision from this one.
#   * natsdata — a JetStream queue. Restoring a stale queue replays work the
#     platform already did. A fresh queue is the correct state after a restore.
#   * pgdata — the database's own files. The dumps above are the backup of that,
#     and a file-level copy of a running Postgres is not a backup at all.
#
# Usage:  ./backup.sh [output-directory]        (default: ./backups)
#
# RUNNING IT REGULARLY. A backup script nobody runs is not a backup, and this one
# has no scheduler of its own on purpose — the appliance's own cron or systemd
# owns that decision, not the repo. On a Linux appliance:
#
#   0 3 * * *  cd /opt/neubit_v3/deploy && ./backup.sh /var/backups/neubit \
#                >> /var/log/neubit-backup.log 2>&1
#
# and prune old archives there. Whatever the schedule, run
# `./restore.sh <archive> --verify` against a kept archive from time to time: it
# restores every database into throwaway copies and checks them against the
# counts recorded at dump time, without touching anything live.
set -euo pipefail

# The archive carries VE_SECRETS_KEY and every database password. Nothing this
# script creates is readable by anyone but its owner — set before the first write,
# not after, so there is no window where it is world-readable.
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-$HERE/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="neubit-backup-$STAMP"

: "${DB_SERVICE:=postgres}"
# Volumes worth restoring: small, and holding things a human put there. Sizes on
# the reference appliance: corefiles 448K, dashforge-uploads 40K, miniodata 120K.
VOLUMES=(corefiles dashforge-uploads miniodata)

cd "$HERE"

say() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf 'backup: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is not on PATH"
[ -f "$HERE/.env" ] || die "no .env beside this script — run it from deploy/"

# The postgres container, by compose service name. Everything below execs inside
# it, so no Postgres client is needed on the host.
PG="$(docker compose ps -q "$DB_SERVICE" || true)"
[ -n "$PG" ] || die "the '$DB_SERVICE' service is not running — start it, then back up"

PROJECT="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$PG")"
[ -n "$PROJECT" ] || die "could not read the compose project name off $DB_SERVICE"

PG_USER="$(grep -E '^POSTGRES_USER=' .env | head -1 | cut -d= -f2-)"
: "${PG_USER:=neubit}"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ROOT="$STAGE/$NAME"
mkdir -p "$ROOT/db" "$ROOT/env" "$ROOT/volumes"

# --- databases -------------------------------------------------------------
# Discovered, never listed. A database added next year is in the backup without
# anyone remembering to edit this file — the failure mode of a hardcoded list is
# a backup that silently stops being complete.
say "discovering databases"
# `mapfile` would be shorter and is bash 4; macOS ships bash 3.2, and a backup
# script that only runs on the appliance is a backup script nobody tests.
DBS=()
while IFS= read -r line; do
  [ -n "$line" ] && DBS+=("$line")
done < <(docker exec -i "$PG" \
  psql -U "$PG_USER" -d postgres -At \
  -c "select datname from pg_database where not datistemplate and datallowconn and datname <> 'postgres' order by datname")
[ "${#DBS[@]}" -gt 0 ] || die "found no databases to dump — refusing to write an empty backup"
say "found ${#DBS[@]}: ${DBS[*]}"

# Roles and their passwords live outside any single database, so they are dumped
# separately or a restored appliance has tables no role can own.
say "dumping globals (roles, grants)"
docker exec -i "$PG" pg_dumpall -U "$PG_USER" --globals-only > "$ROOT/globals.sql"

for db in "${DBS[@]}"; do
  say "dumping $db"
  # Dumped to a file INSIDE the container and copied out, rather than streamed
  # through `docker exec`'s stdout: the custom format is binary, and a stream
  # that gets any framing or newline translation applied produces an archive
  # pg_restore rejects — after the incident, not before.
  docker exec -i "$PG" sh -c \
    "pg_dump -U '$PG_USER' -d '$db' -Fc --no-owner --no-privileges -f /tmp/$db.dump"
  docker cp "$PG:/tmp/$db.dump" "$ROOT/db/$db.dump"
  docker exec -i "$PG" rm -f "/tmp/$db.dump"
  # WHAT THIS DATABASE LOOKED LIKE WHEN IT WAS DUMPED. Recorded now so that
  # restore.sh --verify has something to compare a restored copy against WITHOUT
  # a healthy live database to ask — which is the situation a restore happens
  # in. Counting against the live database instead would make verification pass
  # trivially on the one appliance that no longer has one.
  counts="$(docker exec -i "$PG" psql -U "$PG_USER" -d "$db" -At -c \
    "select (select count(*) from pg_stat_user_tables) || ' ' ||
            (select count(*) from timescaledb_information.hypertables) || ' ' ||
            (select count(*) from timescaledb_information.continuous_aggregates) || ' ' ||
            (select count(*) from timescaledb_information.jobs
               where application_name not ilike '%telemetry%')" 2>/dev/null | tail -1)"
  [ -n "$counts" ] || counts="0 0 0 0"
  echo "$db $counts" >> "$ROOT/db/counts.txt"
done

# --- secrets ---------------------------------------------------------------
# VE_SECRETS_KEY is here and nowhere else. Without it the dumps above restore a
# platform whose every stored credential is undecryptable ciphertext.
say "copying .env"
cp "$HERE/.env" "$ROOT/env/.env"

# --- volumes ---------------------------------------------------------------
for vol in "${VOLUMES[@]}"; do
  full="${PROJECT}_${vol}"
  if ! docker volume inspect "$full" >/dev/null 2>&1; then
    say "volume $full does not exist — skipping"
    continue
  fi
  say "archiving volume $full"
  # A throwaway container is the only way to read a named volume from the host
  # on every platform; on macOS the volume has no host path at all.
  docker run --rm -v "$full:/src:ro" -v "$ROOT/volumes:/out" alpine \
    tar czf "/out/$vol.tar.gz" -C /src . 
done

# --- manifest --------------------------------------------------------------
# Written last and checked first by restore.sh: a truncated archive is the
# backup failure people discover during the restore.
say "writing manifest"
{
  echo "neubit-backup 1"
  echo "created   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "project   $PROJECT"
  echo "pg_user   $PG_USER"
  echo "databases ${DBS[*]}"
  echo "volumes   ${VOLUMES[*]}"
  echo "counts    db/counts.txt: <database> <tables> <hypertables> <aggregates> <jobs>"
  echo "server    $(docker exec -i "$PG" psql -U "$PG_USER" -d postgres -At -c 'select version()' | head -1)"
  echo "---"
} > "$ROOT/manifest.txt"
( cd "$ROOT" && find . -type f ! -name manifest.txt -print0 | sort -z \
  | xargs -0 shasum -a 256 ) >> "$ROOT/manifest.txt"

mkdir -p "$OUT_DIR"
ARCHIVE="$OUT_DIR/$NAME.tar.gz"
tar czf "$ARCHIVE" -C "$STAGE" "$NAME"
chmod 600 "$ARCHIVE"

say "wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
say "restore with: ./restore.sh '$ARCHIVE'"
