# Neubit v3 — POC deployment on a Windows Server (single machine, IP-accessed)

Runs the **full Neubit stack** (central + recorder + gateway) on one Windows Server,
reachable on the machine's **LAN IP**. Cameras record directly (Neubit = the NVR),
the tower opens the operator console in a browser over the network.

> Scope for the 10-day POC: **Live streaming + Recording + Playback.** Nothing else.

---

## 0. Prerequisites (on the Windows Server)

- **Docker Desktop** (or Docker CE) with the **WSL2 backend** enabled — the stack is
  Linux containers.
- **The RAID volume mounted** (your HPE logical drive, e.g. `E:`) with lots of free space.
- **Firewall:** allow inbound **TCP 80** (console/API), **UDP+TCP 8189** (WebRTC media),
  and **TCP 8554** if you'll pull RTSP externally.
- The server and all cameras + the viewing tower on the **same LAN / reachable subnet**.

### Point Docker's storage at the RAID (important — footage lives here)
Docker Desktop → **Settings → Resources → Advanced → Disk image location** → set to the
**RAID drive** (e.g. `E:\docker`). Apply & restart. Now every named volume (including
`recordings`) physically lands on the RAID — no bind-mount fiddling, best write speed.

---

## 1. Get the code + configure

```powershell
# from the repo's deploy\ folder
copy poc\.env.example .env

# set THIS machine's LAN IP everywhere (example 192.162.0.11):
(Get-Content .env) -replace '__SERVER_IP__','192.162.0.11' | Set-Content .env
```
Then open `.env` and change: `POSTGRES_PASSWORD`, `VE_JWT_SECRET`, `VE_SECRETS_KEY`,
`VE_BOOTSTRAP_ADMIN_PASSWORD`, `OPS_AGENT_TOKEN`.

---

## 2. Build + start (production mode — NOT the dev override)

Always pass `-f docker-compose.yml` **explicitly** so Docker does NOT auto-load the dev
`docker-compose.override.yml` (that one bind-mounts source + runs `--reload`, dev only):

```powershell
docker compose -f docker-compose.yml build
docker compose -f docker-compose.yml up -d
docker compose -f docker-compose.yml ps
```

---

## 3. Access

| What | URL | Notes |
|---|---|---|
| **Operator console** | `http://<SERVER_IP>/` | from the tower / any LAN machine |
| **Superadmin panel** | `http://admin.localhost/` | host-based route — see below |

`admin.localhost` resolves to `127.0.0.1`, so the **superadmin panel opens on the server
itself**. To reach it from another machine, add a hosts entry on that machine
(`C:\Windows\System32\drivers\etc\hosts`): `  <SERVER_IP>  admin.localhost`.
(Per your requirement: everything on the IP, superadmin stays on `admin.localhost`.)

First login: the `VE_BOOTSTRAP_ADMIN_*` creds → rotate immediately.

---

## 4. POC bring-up checklist

1. **Onboard cameras** (direct IP): Devices → Cameras → Add / ONVIF discover. Start with 5–10.
2. **Apply uniform encoder config**: main **H.265** 1080p/15fps/2 Mbps, sub **H.264**
   640×480/15fps/512 Kbps (set on the cameras; platform can push via ONVIF).
3. **Recording**: set the cameras to **continuous** → confirm footage under Playback after a
   few minutes.
4. **Live wall** (tower, 3 monitors): open `http://<SERVER_IP>/streaming`, drag cameras onto
   the wall. Watch for real-time playback.
5. **Playback**: open a recorded camera, seek on the calendar, export a clip.

---

## 5. Windows / Docker gotchas to expect

- **WebRTC live from another machine (the tower)** is the classic tuning point. The
  browser needs a reachable ICE candidate — `.env` advertises `MTX_WEBRTCADDITIONALHOSTS=
  <SERVER_IP>` and firewall must allow UDP/TCP **8189**. If live is black from the tower but
  fine on the server, this is the culprit (firewall / ICE host).
- **Recording throughput**: keep the Docker disk image on the RAID (step 0). NTFS bind-mounts
  through WSL2 are slower — avoid them for `/recordings`.
- **Camera reachability**: containers must reach the camera IPs. On a flat LAN this works out
  of the box; if cameras are on a separate VLAN, ensure routing.
- **Time zone / clock**: keep the server clock correct (IST) — segment timestamps + playback
  calendar depend on it.

---

## 6. Later: split the recording load onto the 2nd DL380

For 150 cameras you'll want ~75 per machine. The 2nd DL380 runs a **recorder-only** node
that points back at this server's Postgres/NATS by IP and registers itself as a media node.
That bundle is a follow-up once the single-server POC passes — ask and it'll be prepared
(`docker-compose.recorder.yml` parameterised by `CENTRAL_IP` + this recorder's own IP).
