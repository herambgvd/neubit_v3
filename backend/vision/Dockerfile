# Neubit v3 vision — VMS control-plane service (Python/FastAPI). Built with uv.
# NOTE: the build context is `backend/` (the parent dir) so the shared kernel
# `kernel/` is available to COPY alongside this service. See compose:
#   build: { context: ../backend, dockerfile: vision/Dockerfile }
FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

# curl for the healthcheck; ffmpeg for P4-B clip export (concat/remux recorded fmp4
# segments → mp4) + the ONVIF driver's RTSP-snapshot fallback; mdadm + util-linux
# (lsblk) for RAID monitoring — on a Linux recording node the RaidMonitor shells these
# to read array health (needs host /proc/mdstat + /dev visibility; harmless if absent).
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ffmpeg mdadm util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 neubit \
 && useradd --system --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin neubit \
 && mkdir -p /recordings && chown -R 10001:10001 /recordings

# Shared kernel first (its own layer), then the service. Install both editable so
# the path dep resolves without a package index.
COPY kernel /opt/kernel
RUN uv pip install --system --no-cache -e /opt/kernel

COPY vision/pyproject.toml ./
COPY vision/app ./app
COPY vision/migrations ./migrations
COPY vision/alembic.ini ./
RUN uv pip install --system --no-cache -e "."

# RUN AS A NON-ROOT USER from here on.
#
# Everything above needs root: apt, uv installing into the system interpreter,
# chmod on the entrypoint. Nothing below does. Left as root, an RCE in the app — or
# a container escape — starts as uid 0, and on a bind mount that is uid 0 on the
# HOST.
#
# The account is created in the OS-setup layer at the top rather than here, so this
# file has one RUN per concern instead of a second one that only adds a user. 10001
# is fixed rather than left to useradd: the named volume mounted here is chowned
# to that uid once, outside the image, and the two have to keep matching.
USER neubit

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
