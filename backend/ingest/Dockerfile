# Neubit v3 ingest service. Built with uv.
# NOTE: the build context is `backend/` (the parent dir) so the shared kernel
# `kernel/` is available to COPY alongside this service. See compose:
#   build: { context: ../backend, dockerfile: ingest/Dockerfile }
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

COPY ingest/pyproject.toml ./
COPY ingest/app ./app
COPY ingest/migrations ./migrations
COPY ingest/alembic.ini ./
RUN uv pip install --system --no-cache -e "."

# RUN AS A NON-ROOT USER.
#
# Everything above this line needs root: apt, uv installing into the system
# interpreter, chmod on the entrypoint. Nothing below it does. Left as root, an RCE
# in the app — or a container escape — starts as uid 0, and on a bind mount that is
# uid 0 on the HOST.
#
# 10001 is fixed rather than left to useradd: one uid across the estate is easier
# to reason about than seven, and it is the uid the volumes are chowned to.
RUN groupadd --system --gid 10001 neubit \
 && useradd --system --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin neubit
USER neubit

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
