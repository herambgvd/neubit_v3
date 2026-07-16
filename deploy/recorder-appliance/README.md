# Neubit Recorder Appliance

A fully **standalone NVR** you run on one box. Everything — the recording engine,
the operator web UI, camera management, live view and playback — is in **two Docker
containers**. No central server, no Postgres, no cloud. Because it is Docker, the
install is **identical on Windows and Linux**.

- `nvr` — the recorder core (Go). Embedded SQLite database, bootstrap admin login,
  and the operator web UI baked right into the binary.
- `mediamtx` — the media node that pulls RTSP from your cameras, records fmp4
  segments, and serves live (HLS/WebRTC) + recorded playback to the browser. It is
  gated by the `nvr` itself, so no gateway is needed.

---

## 1. Prerequisites

| OS | Install |
|----|---------|
| **Windows** | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (includes Docker Compose). Start it once so the whale icon is running. |
| **Linux**   | [Docker Engine](https://docs.docker.com/engine/install/) + the Compose plugin (`docker compose version` should work). |

From here on the commands are **the same on both**.

---

## 2. Configure

From this folder (`deploy/recorder-appliance`):

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

- `VE_NODE_ADMIN_PASSWORD` — your first-login admin password. (Leave blank to have
  one generated for you — see step 4.)
- `VE_JWT_SECRET` — a long random string. Generate one with
  `openssl rand -hex 32` (on Windows, use Git Bash or WSL, or paste any long random
  string). Keep it stable.
- `VE_MEDIA_ADVERTISE_HOST` — the recorder's LAN IP or hostname (e.g.
  `192.168.1.50`) so **other machines** on the network can see live/playback video.
  Leave `localhost` if you will only watch from the recorder itself.

Ports (UI `8080`, RTSP `8554`, HLS `8888`, WHEP `8889`, playback `9996`) have sane
defaults; change them in `.env` only if something else on the box uses them.

---

## 3. Start

```bash
docker compose up -d
```

This builds the `nvr` image (first run only, a few minutes) and starts both
containers. Check they are healthy:

```bash
docker compose ps
```

---

## 4. First-login password

- If you set `VE_NODE_ADMIN_PASSWORD` in `.env`, use **that** with user `admin`
  (or whatever `VE_NODE_ADMIN_USER` you chose).
- If you left it **blank**, the node generated one on first boot and printed it
  once to the logs:

  ```bash
  docker compose logs nvr | grep -i "bootstrap admin password"
  ```

  Copy that password. (It is shown only on the first boot; store it somewhere safe.)

---

## 5. Open the console

In a browser go to:

```
http://<recorder-host>:8080
```

(`http://localhost:8080` from the recorder itself, or `http://<LAN-IP>:8080` from
another machine.) Log in with the admin user + password from step 4.

---

## 6. First steps

1. **Add cameras** — in the console, add each camera by its RTSP URL (or use ONVIF
   discovery). Give it a name and, if you like, a group/site.
2. **Set recording** — choose the recording mode per camera (e.g. continuous or
   schedule) and start recording. Segments are written under the `recordings`
   volume and indexed automatically.
3. **Live & playback** — open **Live** to watch cameras in real time, and
   **Playback** to scrub recorded footage on the calendar/timeline, mark in/out
   points, and export clips.

That's it — the recorder runs entirely on this box.

---

## Operating notes

- **Fully standalone.** No central controller, database, or internet connection is
  required. Live and recorded video are token-gated by the box itself.
- **Your data lives in two Docker volumes:** `nodedata` (the SQLite database —
  users, cameras, config) and `recordings` (the video). Back these up to preserve
  the appliance. For large deployments, point `recordings` at a dedicated disk by
  replacing the named volume with a bind mount in `docker-compose.yml`
  (e.g. `- /mnt/recordings:/recordings`).
- **Update:** `docker compose pull && docker compose up -d --build`.
- **Stop:** `docker compose down` (add `-v` to also delete the data + recordings —
  irreversible).
- **Logs:** `docker compose logs -f nvr` or `... mediamtx`.
- **HEVC cameras** play in the browser via an on-demand H.265→H.264 transcode
  handled inside the `mediamtx` container — nothing to configure.
