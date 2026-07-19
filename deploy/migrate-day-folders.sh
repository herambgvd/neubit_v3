#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# One-time migration: flat recording segments  →  day-foldered layout.
#
# Old layout (flat):   <root>/cameras/<t>/<c>/<profile>/2026-07-18_23-59-49-777.mp4
# New layout (foldered): <root>/cameras/<t>/<c>/<profile>/2026-07-18/23-59-49-777.mp4
#
# WHY: MediaMTX's playback server opens every file in a camera's recordPath dir at
# once; a flat 24/7 dir grows to tens of thousands of files and crashes it. The new
# recordPath template (%path/%Y-%m-%d/%H-%M-%S-%f) keeps each dir to one day. NEW
# segments already land day-foldered after the nvr+mediamtx rebuild; this migrates
# the EXISTING flat footage so it stays playable + retrievable.
#
# The file move and the DB rewrite apply the SAME pure transform — insert a "/"
# splitting the date from the time in the last path component — so they stay
# consistent without threading a mapping. Idempotent: already-foldered files/rows
# don't match the flat pattern and are skipped.
#
# RUN ORDER (AFTER rebuilding nvr + mediamtx with the day-folder template):
#   1. Dry-run (counts flat files, moves nothing):
#        docker compose exec -T nvr sh /migrate-day-folders.sh           # (mount or copy this file in)
#      — or copy it in first:
#        docker compose cp migrate-day-folders.sh nvr:/tmp/mig.sh
#        docker compose exec -T nvr sh /tmp/mig.sh
#   2. Execute the file moves:
#        docker compose exec -T nvr sh /tmp/mig.sh --apply
#   3. Rewrite the DB paths (both DBs) — run in postgres:
#        docker compose exec -T postgres psql -U neubit -d neubit_nvr    -c "$(sh /tmp/mig.sh --sql)"
#        docker compose exec -T postgres psql -U neubit -d neubit_vision -c "$(sh /tmp/mig.sh --sql)"
#      (or paste the SQL printed by `--sql` directly).
#
# Safe to run while recording continues: new writes are already day-foldered and do
# not match the flat pattern, so only historical flat files are touched.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

ROOTS="/recordings /pools/1 /pools/2 /pools/3"

if [ "${1:-}" = "--sql" ]; then
  # Emit the idempotent path-rewrite (same transform as the file move). Works on
  # both recording_segments (neubit_nvr) and recordings (neubit_vision).
  cat <<'SQL'
UPDATE recording_segments
   SET path = regexp_replace(path, '/([0-9]{4}-[0-9]{2}-[0-9]{2})_([^/]+\.mp4)$', '/\1/\2')
 WHERE path ~ '/[0-9]{4}-[0-9]{2}-[0-9]{2}_[^/]+\.mp4$';
SQL
  # (For neubit_vision the table is `recordings`; the printed statement targets
  #  recording_segments — swap the table name when running against neubit_vision.)
  exit 0
fi

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

[ "$APPLY" = "1" ] && printf 'Moving flat segments into day-folders (progress every 500)...\n'
for root in $ROOTS; do
  [ -d "$root" ] || continue
  # Flat segment = last path component looks like YYYY-MM-DD_<time>.mp4. Uses pure
  # shell parameter expansion (no basename/dirname/cut subprocesses per file) so the
  # move is fast even across tens of thousands of files on a slow (drvfs) mount.
  find "$root" -type f -name '*.mp4' 2>/dev/null | (
    n=0
    while IFS= read -r f; do
      b=${f##*/}
      case "$b" in
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_*.mp4)
          d=${f%/*}; day=${b%%_*}; rest=${b#*_}   # dir / YYYY-MM-DD / <time>.mp4
          if [ "$APPLY" = "1" ]; then
            mkdir -p "$d/$day" && mv "$f" "$d/$day/$rest" || continue
            n=$((n + 1))
            [ $((n % 500)) -eq 0 ] && printf '  ...moved %s (in %s)\n' "$n" "$root"
          else
            printf 'FLAT %s  ->  %s/%s/%s\n' "$f" "$d" "$day" "$rest"
          fi
          ;;
      esac
    done
    [ "$APPLY" = "1" ] && [ "$n" -gt 0 ] && printf '  moved %s from %s\n' "$n" "$root"
  )
done

# Note: the per-file counters live in the subshell of the pipe; re-count for the summary.
total=0
for root in $ROOTS; do
  [ -d "$root" ] || continue
  n=$(find "$root" -type f -name '*.mp4' 2>/dev/null | grep -Ec '/[0-9]{4}-[0-9]{2}-[0-9]{2}_[^/]+\.mp4$' || true)
  total=$((total + n))
done
if [ "$APPLY" = "1" ]; then
  printf '\nDONE. Remaining flat files: %s (should be ~0; any left were written mid-run — re-run).\n' "$total"
  printf 'NEXT: rewrite DB paths (step 3 in the header).\n'
else
  printf '\nDRY-RUN. Flat files that WOULD move: %s\n' "$total"
  printf 'Re-run with --apply to move them.\n'
fi
