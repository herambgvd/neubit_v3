# Neubit v3 platform core (Python / edge). Built with uv — fast, reproducible.
FROM python:3.11-slim

# uv: fast Python package manager (replaces pip).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Deps first (layer cache), then source. AI extras (runtime/gpu/openvino/vector) are dropped.
COPY pyproject.toml ./
COPY edge ./edge
COPY example ./example
COPY migrations ./migrations
COPY alembic.ini ./
RUN uv pip install --system --no-cache -e ".[messaging,tasks,reports,system,storage]"

EXPOSE 8000
CMD ["uvicorn", "example.main:app", "--host", "0.0.0.0", "--port", "8000"]
