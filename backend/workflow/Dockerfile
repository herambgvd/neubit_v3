# Neubit v3 workflow service (API + Celery worker + beat share this image). Built with uv.
# NOTE: the build context is `backend/` (the parent dir) so the shared kernel
# `kernel/` is available to COPY alongside this service. See compose:
#   build: { context: ../backend, dockerfile: workflow/Dockerfile }
FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Shared kernel first (its own layer), then the service.
COPY kernel /opt/kernel
RUN uv pip install --system --no-cache -e /opt/kernel

COPY workflow/pyproject.toml ./
COPY workflow/app ./app
COPY workflow/migrations ./migrations
COPY workflow/alembic.ini ./
RUN uv pip install --system --no-cache -e "."

EXPOSE 8000
# Default = API. The worker/beat services override `command` in compose.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
