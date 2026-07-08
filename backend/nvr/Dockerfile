# Neubit v3 nvr — VMS data-plane service (Go). Multi-stage: build → slim runtime.
#
# NOTE: the build context is `backend/` (the parent dir) so the shared Go kernel
# `gokernel/` is COPYed alongside this service — the module's `replace
# github.com/neubit/gokernel => ../gokernel` then resolves. See compose:
#   build: { context: ../backend, dockerfile: nvr/Dockerfile }

# ── build stage ──────────────────────────────────────────────────────
FROM golang:1.22-alpine AS build
WORKDIR /src

# Shared kernel first (its own layer) so the path replace resolves, then the
# service module. gokernel sits at ../gokernel relative to the service dir.
COPY gokernel ./gokernel
COPY nvr ./nvr

WORKDIR /src/nvr
RUN go mod download
# Static binary, no cgo, stripped — for a scratch/distroless-style runtime.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/nvr .

# ── runtime stage ────────────────────────────────────────────────────
FROM alpine:3.20
RUN apk add --no-cache ca-certificates curl \
 && adduser -D -u 10001 nvr
WORKDIR /app
COPY --from=build /out/nvr /app/nvr
USER nvr
EXPOSE 8000
CMD ["/app/nvr"]
