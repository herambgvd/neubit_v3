# Neubit v3 vision — VMS control-plane service (Python/FastAPI). Built with uv.
# NOTE: the build context is `backend/` (the parent dir) so the shared kernel
# `kernel/` is available to COPY alongside this service. See compose:
#   build: { context: ../backend, dockerfile: vision/Dockerfile }
FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

# curl for the healthcheck; ffmpeg for P4-B clip export (concat/remux recorded fmp4
# segments → mp4) + the ONVIF driver's RTSP-snapshot fallback.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Shared kernel first (its own layer), then the service. Install both editable so
# the path dep resolves without a package index.
COPY kernel /opt/kernel
RUN uv pip install --system --no-cache -e /opt/kernel

COPY vision/pyproject.toml ./
COPY vision/app ./app
COPY vision/migrations ./migrations
COPY vision/alembic.ini ./
RUN uv pip install --system --no-cache -e "."

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
