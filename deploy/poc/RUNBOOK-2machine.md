# Neubit v3 POC — 2-machine setup WITHOUT the codebase on the servers

**Goal:** Machine 1 = full Neubit (central) + recorder-1 (75 cams). Machine 2 = recorder-2
(75 cams). Neither server holds source code — they run **pre-built images**.

```
                 ┌───────────────────────────────┐        ┌──────────────────────┐
   75 cameras ──►│ Machine 1 (DL380 #1)          │        │ Machine 2 (DL380 #2) │◄── 75 cameras
                 │  Central: gateway/core/vision │        │  recorder-2:         │
                 │  postgres · NATS · redis · UI │◄──────►│   mediamtx + nvr     │
                 │  + recorder-1 (mediamtx+nvr)  │  IP     │  (pulls images,      │
                 │  → RAID                       │         │   DB/NATS on M1 IP)  │
                 └───────────────┬───────────────┘         └──────────────────────┘
                                 │ http://<M1_IP>/
                            Tower (3 monitors, browser wall)
```

---

## The "no codebase" idea (do this ONCE)

The servers only need **Docker + a few config files + the images**. Images are built
**one time** on a builder, then both servers just *pull* them.

Two ways to move the images — pick one:

### Option A — private registry (cleanest, updatable)
On a builder (an x64 Linux box, or `docker buildx --platform linux/amd64`):
```bash
export REGISTRY=registry.example.com/neubit   # your registry (or M1_IP:5000 local registry)
export IMAGE_TAG=poc
docker compose -f deploy/docker-compose.yml build
# tag + push each image (core, vision, frontend, admin-frontend, nvr, gateway, ops-agent)
docker compose -f deploy/docker-compose.yml push        # if image: names include $REGISTRY
```
Both servers then `docker compose pull`.

> A local registry on Machine 1 is one command: `docker run -d -p 5000:5000 --name registry registry:2`
> — then `REGISTRY=<M1_IP>:5000`.

### Option B — image tarballs (offline, no registry)
```bash
docker save neubit-v3-core neubit-v3-vision neubit-v3-frontend neubit-v3-admin-frontend \
            neubit-v3-nvr neubit-v3-gateway neubit-v3-ops-agent \
            bluenviron/mediamtx:latest-ffmpeg postgres:16 nats:2 redis:7 \
  -o neubit-images.tar
# copy neubit-images.tar to each server, then:
docker load -i neubit-images.tar
```

> ⚠️ **Build for the servers' CPU:** the DL380s are **x64 (amd64)**. Build on an x64 machine,
> or use `docker buildx build --platform linux/amd64`. Images built on Apple-Silicon (arm64)
> will NOT run on the servers.

The servers get: this `deploy/poc/` folder + `mediamtx.yml` + `gateway/` config — **that's it,
no source tree.**

---

## Machine 1 — central + recorder-1

1. Install Docker (WSL2 backend). Point Docker's disk image at the **RAID** (see `README.md`).
2. Copy `deploy/` config (compose files + `.env` + `mediamtx.yml` + `gateway/`).
3. `.env` from `poc/.env.example`, set `__SERVER_IP__` = **M1_IP**, secrets, password.
4. Bring up central + recorder-1:
   ```powershell
   docker compose -f docker-compose.yml -f docker-compose.recorder1.yml pull
   docker compose -f docker-compose.yml -f docker-compose.recorder1.yml up -d
   ```
5. Open `http://<M1_IP>/` → log in. Recorder-1 auto-registers as a media node.

## Machine 2 — recorder-2 only

1. Install Docker (WSL2), Docker disk image → **RAID**. Firewall: open **8189/udp+tcp, 8889,
   9997, 8000**.
2. Copy just: `deploy/poc/docker-compose.recorder2.yml`, `deploy/mediamtx.yml`, and a
   `recorder.env` with: `REGISTRY, IMAGE_TAG, CENTRAL_IP=<M1_IP>, RECORDER_IP=<M2_IP>,
   POSTGRES_PASSWORD, VE_JWT_SECRET` (JWT secret same as central).
3. On Machine 1, create recorder-2's database once:
   `docker exec neubit-v3-postgres-1 psql -U neubit -c "CREATE DATABASE neubit_nvr_2;"`
4. Start recorder-2:
   ```powershell
   docker compose --env-file recorder.env -f docker-compose.recorder2.yml pull
   docker compose --env-file recorder.env -f docker-compose.recorder2.yml up -d
   ```

## Central gateway → point /media2 at Machine 2

On Machine 1, in `gateway/dynamic/routes.yml`, the `media2-*` services must target
**Machine 2's IP** instead of the docker DNS name:
`http://mediamtx-2:8889` → `http://<M2_IP>:8889` (whep), `:8888` (hls), `:9996` (playback).
Then `docker restart neubit-v3-gateway-1`. (This is the one cross-machine wiring step.)

## Register recorder-2 + map 75/75

- In the UI: **Devices → Recorders** → confirm recorder-2 shows **online** (heartbeat).
  If not auto-registered, add a media node with `api_url = http://<M2_IP>:8000`.
- Onboard 150 cameras (ONVIF discover / bulk IP). Select 75 → assign **recorder-1**,
  75 → assign **recorder-2** (bulk assign). Apply the encoder policy (main H.265 / sub H.264).
- Set continuous recording → verify footage on both under Playback.

---

## Honest status
- **Recorder function** (record + live + playback per node) is **proven** — recorder-1 and
  recorder-2 both pulled/served streams in testing.
- **Cross-machine wiring** (recorder-2 on a *separate* box: DB/NATS by IP + gateway /media2 →
  M2_IP + firewall/ICE) is **config, not a code gap**, but has **not been live-tested against a
  real 2nd machine yet** — so treat Machine-2 bring-up as an explicit POC validation step
  (expect one tuning pass on WebRTC ICE + the gateway media2 target).
