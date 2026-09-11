# Neubit v3 platform core (Python / app). Built with uv — fast, reproducible.
FROM python:3.11-slim

# uv: fast Python package manager (replaces pip).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

# curl for healthchecks; poppler-utils for the sites floor-plan PDF→PNG conversion
# (pdf2image shells out to poppler).
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl poppler-utils \
 && rm -rf /var/lib/apt/lists/*

# Deps first (layer cache), then source. AI extras (runtime/gpu/openvino/vector) are dropped.
COPY pyproject.toml ./
COPY app ./app
COPY migrations ./migrations
COPY alembic.ini ./
COPY migrate.sh ./
RUN chmod +x /app/migrate.sh
RUN uv pip install --system --no-cache -e ".[messaging,tasks,reports,system,storage,sites]"

# RUN AS A NON-ROOT USER.
#
# Everything above this line needs root: apt, uv installing into the system
# interpreter, chmod on the entrypoint. Nothing below it does. Left as root, an RCE
# in the app — or a container escape — starts as uid 0, and on a bind mount that is
# uid 0 on the HOST.
#
# 10001 is fixed rather than left to useradd: the named volume mounted here is
# chowned to that uid once, outside the image, and the two have to keep matching.
RUN groupadd --system --gid 10001 neubit \
 && useradd --system --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin neubit
RUN mkdir -p /app/data && chown -R 10001:10001 /app/data
USER neubit

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
