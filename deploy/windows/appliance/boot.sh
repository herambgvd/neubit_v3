#!/usr/bin/env bash
# The appliance's init, run by WSL as root from /etc/wsl.conf `[boot] command=`.
#
# THE ONLY PLACE dockerd IS STARTED, and that is the point rather than tidiness.
# The P0 spike lost every image to a second launcher: a bare `dockerd` and
# systemd's `docker.service` bring up different containerd instances, which means
# different image stores, which means an engine reporting `images=0` with 8 GB on
# disk and nothing anywhere saying why. build-appliance.ps1 bakes the images by
# calling THIS script, so the store the release pipeline writes to is by
# construction the store the appliance reads from.
#
# Also runs on every `wsl -d neubit-vms` from Windows, and on the boot task's
# poke, so it must be idempotent and quick when there is nothing to do.
set -uo pipefail

NEUBIT_DIR=/opt/neubit
LOG=/var/log/neubit-boot.log
COMPOSE_FILES=(-f "$NEUBIT_DIR/docker-compose.yml" -f "$NEUBIT_DIR/docker-compose.appliance.yml")

# The log is for the UNATTENDED paths, which have no console to write to. It is
# NOT for `status`: that is what an operator runs when the console is not
# answering, and the README tells them to. Redirecting its output into a file
# they then have to know about turns the diagnostic into a second problem —
# observed on the first customer install, where `boot.sh status` printed a blank
# line and the answer was sitting in the log behind it.
case "${1:-boot}" in
  status|stop) ;;
  *)
    exec >>"$LOG" 2>&1
    echo "=== boot.sh $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="
    ;;
esac

start_engine() {
  if docker info >/dev/null 2>&1; then
    echo "engine already up"
    return 0
  fi

  echo "starting dockerd"
  mkdir -p /var/log /var/run
  # Explicit flags, pinned here rather than inherited from a unit file that is
  # installed but never runs. Anything that changes how the engine is launched
  # changes which images it can see (see the header), so it changes HERE and the
  # release pipeline picks it up automatically.
  nohup dockerd \
    --host=unix:///var/run/docker.sock \
    --log-level=warn \
    >/var/log/dockerd.log 2>&1 &

  for _ in $(seq 1 120); do
    if docker info >/dev/null 2>&1; then
      echo "dockerd ready"
      return 0
    fi
    sleep 1
  done

  echo "!! dockerd did not come up in 120s; last lines of its log:"
  tail -40 /var/log/dockerd.log
  return 1
}

start_stack() {
  if [ ! -f "$NEUBIT_DIR/docker-compose.yml" ]; then
    echo "!! $NEUBIT_DIR/docker-compose.yml is missing — payload not staged"
    return 1
  fi

  # --no-build, always. The appliance has no source and no build context; if an
  # image is missing that is a broken payload, and compose must say so rather
  # than trying to build and failing three minutes later with a confusing error.
  echo "bringing the stack up"
  docker compose "${COMPOSE_FILES[@]}" --project-directory "$NEUBIT_DIR" up -d --no-build
}

case "${1:-boot}" in
  engine)
    # Used by build-appliance.ps1 while baking images, so the bake and the
    # runtime share one launcher. Does NOT start the stack.
    start_engine
    ;;
  boot|"")
    start_engine || exit 1
    start_stack || exit 1
    echo "boot complete"
    ;;
  stop)
    docker compose "${COMPOSE_FILES[@]}" --project-directory "$NEUBIT_DIR" down
    ;;
  status)
    docker compose "${COMPOSE_FILES[@]}" --project-directory "$NEUBIT_DIR" ps
    ;;
  *)
    echo "usage: boot.sh {boot|engine|stop|status}"
    exit 2
    ;;
esac
