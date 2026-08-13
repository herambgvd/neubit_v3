#!/bin/sh
# Serve the offline basemap, and build it first if it isn't there yet.
#
# The extract runs in the BACKGROUND: the full planet is 137 GB, so even a
# zoom-limited slice is a multi-GB download, and blocking nginx on it would hold
# the whole console's /tiles route down for the duration. Instead nginx comes up
# immediately and starts answering; until the archive lands, the Sites map shows
# its "basemap not installed" panel and everything else works as normal.
set -eu

ARCHIVE="${TILES_DIR}/planet.pmtiles"
PARTIAL="${ARCHIVE}.part"

log() { echo "[tiles] $*"; }

provision() {
  log "no basemap at ${ARCHIVE}"
  log "extracting z0-${TILES_MAXZOOM} of the planet from ${TILES_SOURCE}"
  log "sizes: z8=543MB  z10=3.7GB  z12=17GB  z15=137GB (set TILES_MAXZOOM to change)"

  # Download to .part and rename only on success: nginx is already serving this
  # directory, and a half-written archive would be served as a valid-looking file.
  rm -f "$PARTIAL"
  if pmtiles extract "$TILES_SOURCE" "$PARTIAL" --maxzoom="$TILES_MAXZOOM"; then
    mv "$PARTIAL" "$ARCHIVE"
    log "basemap ready — $(du -h "$ARCHIVE" | cut -f1)"
  else
    rm -f "$PARTIAL"
    log "extract FAILED. The console will show 'basemap not installed'; the rest of it is unaffected."
    log "air-gapped? build the archive on a networked machine and drop it at deploy/tiles/planet.pmtiles"
  fi
}

mkdir -p "$TILES_DIR"

if [ -f "$ARCHIVE" ]; then
  log "serving existing basemap — $(du -h "$ARCHIVE" | cut -f1)"
elif [ "${TILES_AUTO_PROVISION:-1}" = "0" ]; then
  log "no basemap and TILES_AUTO_PROVISION=0 — serving nothing until one is dropped in ${TILES_DIR}"
else
  provision &
fi

exec "$@"
