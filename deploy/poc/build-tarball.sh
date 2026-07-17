#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build ALL Neubit images for the DL380s (linux/amd64) and pack them + the 3rd-party
# images into ONE tarball you copy to the offline servers (no registry, no codebase).
#
# WHERE TO RUN: on an x64 machine WITH the source (a dev box / VM / WSL2-on-x64).
# The source stays ONLY on this builder — the production servers never get it.
# On Apple-Silicon it still works via QEMU emulation but is SLOW (30–60+ min).
#
#   ./build-tarball.sh
#
# OUTPUT: deploy/poc/neubit-images-amd64.tar  (~4.5 GB) → copy to each server → `docker load`
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."            # → deploy/
OUT="poc/neubit-images-amd64.tar"
export DOCKER_DEFAULT_PLATFORM="linux/amd64"

# Neubit images the POC (live + record + playback) needs. gateway = traefik (3rd-party).
BUILT_SERVICES=(core vision nvr frontend admin-frontend ops-agent)
BUILT_IMAGES=(
  neubit-v3-core:latest neubit-v3-vision:latest neubit-v3-nvr:latest
  neubit-v3-frontend:latest neubit-v3-admin-frontend:latest neubit-v3-ops-agent:latest
)
# EXACT 3rd-party tags this stack runs (verified from the running containers).
THIRD_PARTY=(
  bluenviron/mediamtx:latest-ffmpeg
  timescale/timescaledb:2.17.2-pg16      # the DB image (TimescaleDB on pg16, NOT plain postgres)
  traefik:v3.1                           # the gateway
  nats:2.10-alpine
  redis:7-alpine
  minio/minio:latest                     # only if using S3 storage; harmless to include
)

echo "==> Building Neubit images for linux/amd64 (services: ${BUILT_SERVICES[*]}) ..."
docker compose -f docker-compose.yml build "${BUILT_SERVICES[@]}"

echo "==> Pulling 3rd-party images for linux/amd64 ..."
for img in "${THIRD_PARTY[@]}"; do docker pull "$img"; done

echo "==> Saving everything into $OUT ..."
docker save -o "$OUT" "${BUILT_IMAGES[@]}" "${THIRD_PARTY[@]}"
ls -lh "$OUT"

cat <<'EOF'

✅ Bundle ready: deploy/poc/neubit-images-amd64.tar

ON EACH SERVER (offline, Docker only — NO codebase):
  docker load -i neubit-images-amd64.tar
Then copy just the config (compose files + .env + mediamtx.yml + gateway/) and:
  Machine 1:  docker compose -f docker-compose.yml -f docker-compose.recorder1.yml up -d
  Machine 2:  docker compose --env-file recorder.env -f docker-compose.recorder2.yml up -d
(see poc/README.md + poc/RUNBOOK-2machine.md)
EOF
