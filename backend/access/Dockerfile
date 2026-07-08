# Neubit v3 access-control (gates) service. Built with uv.
# NOTE: the build context is `backend/` (the parent dir) so the shared kernel
# `kernel/` is available to COPY alongside this service. See compose:
#   build: { context: ../backend, dockerfile: access/Dockerfile }
FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Shared kernel first (its own layer), then the service. Install both editable so
# the path dep resolves without a package index.
COPY kernel /opt/kernel
RUN uv pip install --system --no-cache -e /opt/kernel

COPY access/pyproject.toml ./
COPY access/app ./app
COPY access/migrations ./migrations
COPY access/alembic.ini ./
RUN uv pip install --system --no-cache -e "."

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
