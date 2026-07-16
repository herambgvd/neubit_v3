# Neubit v3 — STANDALONE RECORDER APPLIANCE image (Go nvr).
#
# The single self-contained binary for the on-box recorder: it runs the NVR
# data-plane in autonomous-node mode (NVR_STORE=sqlite — embedded SQLite estate,
# bootstrap admin, NO Postgres/NATS/central required) AND serves the operator web
# UI, which is committed under nvr/webui/dist and baked into the binary via
# go:embed. One image, one process, no external database.
#
# The binary is PURE Go (modernc SQLite driver → CGO-free), so this image is
# cross-compilable and the runtime layer stays minimal — no ffmpeg here: ALL
# recording/transcode is done by the sidecar `mediamtx` container (the
# bluenviron/mediamtx:latest-ffmpeg image), never by this process.
#
# BUILD CONTEXT NOTE: the context is `backend/` (the repo's backend dir), NOT this
# folder — the shared Go kernel `gokernel/` must be COPYed alongside the service so
# the module's `replace github.com/neubit/gokernel => ../gokernel` resolves. The
# accompanying docker-compose.yml wires this:
#   build:
#     context: ../../backend
#     dockerfile: ../deploy/recorder-appliance/Dockerfile

# ── build stage ──────────────────────────────────────────────────────
# Go 1.25 — matches nvr/go.mod's `go 1.25.0` directive (a lower toolchain fails
# with GOTOOLCHAIN download errors in an offline-ish build).
FROM golang:1.25-alpine AS build
WORKDIR /src

# Shared kernel first (own layer) so the path replace resolves, then the service.
# gokernel sits at ../gokernel relative to the nvr service dir.
COPY gokernel ./gokernel
COPY nvr ./nvr

WORKDIR /src/nvr
RUN go mod download
# Static, CGO-free, stripped binary. The webui/dist SPA is embedded via go:embed,
# so the produced binary already contains the operator console — no web build step
# and no separate web asset to ship.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/nvr .

# ── runtime stage ────────────────────────────────────────────────────
# Slim alpine: ca-certificates for any outbound TLS (device HTTPS/ONVIF), curl for
# the container healthcheck. NO ffmpeg — the mediamtx sidecar owns media work.
FROM alpine:3.20
RUN apk add --no-cache ca-certificates curl tzdata \
 && adduser -D -u 10001 nvr
WORKDIR /app
COPY --from=build /out/nvr /app/nvr

# The node's own data lives on mounted volumes (docker-compose supplies named
# volumes): the embedded SQLite estate at /data and the recordings at /recordings.
RUN mkdir -p /data /recordings && chown -R nvr:nvr /data /recordings
VOLUME ["/data", "/recordings"]

USER nvr
EXPOSE 8000
# The node UI/API. Standalone mode is selected by NVR_STORE=sqlite in the compose
# environment; with it unset the binary would boot in central (Postgres) mode.
CMD ["/app/nvr"]
