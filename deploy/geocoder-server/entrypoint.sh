#!/bin/sh
# Bring up Photon, provisioning its index first if it isn't there.
#
# UNLIKE the tiles server, this one cannot serve while it downloads: Photon reads
# the whole index at startup, so there is nothing to answer with until the file
# has landed. So the container STAYS UP and retries rather than exiting — a
# crash-looping service is noise in `docker compose ps`, and the console degrades
# on its own while this is unavailable (the map picker falls back to its built-in
# city list and says so).
set -eu

DATA="${GEOCODER_DIR}"
INDEX="${DATA}/photon_data"
JAR="${DATA}/photon.jar"
JAR_URL="https://github.com/komoot/photon/releases/download/${GEOCODER_PHOTON_VERSION}/photon-${GEOCODER_PHOTON_VERSION}.jar"
INDEX_URL="https://download1.graphhopper.com/public/extracts/by-country-code/${GEOCODER_COUNTRY}/photon-db-${GEOCODER_COUNTRY}-latest.tar.bz2"

log() { echo "[geocoder] $*"; }

fetch_jar() {
  log "downloading Photon ${GEOCODER_PHOTON_VERSION} (~98 MB)"
  # .part then rename: a half-written jar looks like a valid file to the next start.
  curl -fsSL -o "${JAR}.part" "$JAR_URL" && mv "${JAR}.part" "$JAR"
}

fetch_index() {
  log "downloading the ${GEOCODER_COUNTRY} address index from ${INDEX_URL}"
  log "this is hundreds of MB and unpacks to several GB — it happens once"
  curl -fsSL "$INDEX_URL" | bzip2 -dc | tar -x -C "$DATA"
}

mkdir -p "$DATA"

while [ ! -f "$JAR" ] || [ ! -d "$INDEX" ]; do
  if [ "${GEOCODER_AUTO_PROVISION:-1}" = "0" ]; then
    log "not provisioned and GEOCODER_AUTO_PROVISION=0."
    log "air-gapped? put photon.jar and the unpacked photon_data/ into deploy/geocoder/"
    sleep 300
    continue
  fi
  if { [ -f "$JAR" ] || fetch_jar; } && { [ -d "$INDEX" ] || fetch_index; }; then
    log "provisioned"
  else
    log "provisioning FAILED — retrying in 5 minutes. The console is unaffected:"
    log "the site map picker falls back to its built-in city list."
    rm -f "${JAR}.part"
    sleep 300
  fi
done

log "serving ${GEOCODER_COUNTRY} on :${GEOCODER_PORT}"
# -listen-ip 0.0.0.0 so the gateway (a different container) can reach it at all.
exec java -jar "$JAR" -data-dir "$DATA" -listen-ip 0.0.0.0 -listen-port "$GEOCODER_PORT"
