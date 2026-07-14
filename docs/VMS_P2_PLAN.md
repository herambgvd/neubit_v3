# VMS — Phase 2 implementation plan (live streaming)

Live video to the browser. This is where the **Go `nvr` data-plane** does real work + **MediaMTX** comes in. Recording/playback = P3/P4. Scale-first: cameras shard across MediaMTX nodes; browser plays DIRECT from MediaMTX (never proxied through the API), auth via a short-lived token at Traefik ForwardAuth.

## Port sources (reference heavily — v2 already does live over MediaMTX)
- **neubit_v2 (architecture + code):** `backend/vision/app/mediamtx/client.py` (MediaMTXClient: `upsert_path`, `public_hls_url`, `public_webrtc_url`), `backend/vision/app/module/playback/{models,service,routes}.py` (PlaybackSessionDocument, `create_live`/`create_recorded` → hls/webrtc/rtsp URLs), `deploy/local/mediamtx.yml` + the `mediamtx` compose service. **Frontend:** `frontend/src/lib/videoWall.js` (layout math: tourPages/gridStyle for 1/4/6/8/9/16), the live-cameras hook + the HLS/WebRTC `<video>` player + playback-session consumption.
- **gvd_nvr (UI + player):** `frontend/src/pages/LiveStream.js` (multi-cam wall), `pages/PlaybackConsole.js`, the WebRTC→MSE player, `src/lib/videoWall.js`, `api/cameras.js` `getStreamUrls`. (gvd_nvr uses go2rtc — take the UX/player, swap the URLs to MediaMTX.)

## Live-stream flow (D8 plane split)
```
browser ──POST /api/v1/vms/cameras/{id}/live──▶ vision (Python, control)
   │                                              │ loads camera (decrypts RTSP+creds)
   │                                              │ POST /streams/ensure {camera_id,rtsp,profile} ▶ nvr (Go, data)
   │                                              │                                                   │ stream-supervisor picks a MediaMTX node
   │                                              │                                                   │ MediaMTX upsert_path cameras/<tenant>/<cam>/<profile> (src=rtsp)
   │                                              │ ◀── {hls_url, webrtc_url, node} ──────────────────┘
   │ ◀── PlaybackSession {hls_url,webrtc_url,token,expires_at} ──┘ (vision mints short-lived media token)
   ▼ plays DIRECT from MediaMTX node (WebRTC/WHEP low-latency, HLS fallback)
     via Traefik ── ForwardAuth validates the token ──▶ MediaMTX
```

## Modules (plan-per-module → build → verify → commit)

### P2-A — MediaMTX node + Go `nvr` orchestration + stream-supervisor (backend, Go)
- Add a **`mediamtx` service** to `deploy/docker-compose.yml` (RTSP 8554 / HLS 8888 / WebRTC 8889 / API 9997) + `deploy/mediamtx.yml` (API enabled, paths on-demand, auth hook → nvr or Traefik). Port v2's `mediamtx.yml`.
- **Go `nvr` MediaMTX client** (`backend/nvr/internal/mediamtx/`): `EnsurePath(node, name, source)` (PATCH/POST `/v3/config/paths/add|patch`), `DeletePath`, URL builders (HLS `/<name>/index.m3u8`, WHEP `/<name>/whep`). Port v2 `mediamtx/client.py` semantics to Go.
- **Stream-supervisor** (`backend/nvr/internal/supervisor/`): `MediaNode` + `StreamShard` registry (reuse the vision tables via NATS/read-model OR nvr's own DB); assign camera→node (NVR-affinity + least-loaded); on node loss reassign. P2 can start with a single node + the assignment table (real multi-node rebalance hardened in P6), but build the seam.
- **Internal endpoints** (JWT/service-auth, not public): `POST /streams/ensure {camera_id, rtsp_url, profile}` → assigns node + upserts MediaMTX path → returns `{name, node, hls_url, webrtc_url}`; `DELETE /streams/{camera_id}/{profile}`; `GET /streams` (active). Idle-path reaper (stop paths with no viewers after N min).
- Verify: MediaMTX boots; nvr registers a path for a **synthetic test RTSP** (ffmpeg test-pattern published to MediaMTX, or MediaMTX's own test source) → the HLS `.m3u8` + WHEP endpoints respond 200; delete path works; graceful when a camera RTSP is unreachable.

### P2-B — PlaybackSession issuer + media token (backend, Python vision)
- `PlaybackSession` model (id, tenant_id, camera_id, kind=LIVE, mediamtx_name, hls_url, webrtc_url, token, expires_at) — the `stream_shards`/`media_nodes` tables already exist; add `playback_sessions`.
- `POST /api/v1/vms/cameras/{id}/live` → load camera + decrypt RTSP/creds → call nvr `/streams/ensure` → mint a **short-lived signed media token** (HS256, claims: tenant, camera, exp) → return PlaybackSession URLs+token. `DELETE /live/{session}` (release).
- **Media-auth endpoint** `GET /api/v1/vms/media/verify` (or in core) for **Traefik ForwardAuth** — validates the media token (+ per-camera ACL) before Traefik proxies to MediaMTX. Port v2's token-in-query pattern.
- Reference v2 `module/playback/service.create_live`. Verify: session issue returns URLs+token; verify endpoint 200 for a valid token / 401 for invalid/expired; tenant + ACL enforced.

### P2-C — Gateway wiring (Traefik)
- Route the MediaMTX HLS/WebRTC public paths through Traefik with the **ForwardAuth** middleware → `media/verify`. Keep the internal MediaMTX API (9997) private (nvr-only). Verify: a valid-token HLS request proxies to MediaMTX; no/invalid token → 401.

### P2-D — Frontend: live player + video wall + Streaming section (proper UI)
- **LivePlayer** component (`features/vms/components/`): WebRTC/WHEP (low-latency) with **HLS fallback** (`hls.js` or native), consumes a PlaybackSession (`POST .../live`), handles reconnect/loading/error, snapshot button. Port gvd_nvr's player UX + v2's HLS/WebRTC approach.
- **Video wall** (`features/vms/` — new **Streaming** page): multi-cam grid with layouts (1/4/9/16/25), saved layouts per user, camera tours/carousel (v2 `videoWall.js` math), per-tile controls (fullscreen/snapshot/record-later). Enable the **Streaming** top-nav (currently "Soon").
- **Wire live into existing screens**: Cameras page tile "Live — P2" placeholder → real LivePlayer preview; Events alarm cards → camera live/thumbnail; camera detail → live tab.
- Verify: routes 200, compile clean, player mounts + requests a session (against a test stream if available); state that live render needs the owner's real cameras + a hard-refresh.

## Honest verifiability (no live cameras in dev)
Full pipeline is buildable + testable with a **synthetic RTSP test source** (ffmpeg test-pattern → MediaMTX): MediaMTX serve → session issue → token auth → HLS/WHEP endpoints respond → player mounts. **Real-camera live** (actual RTSP from the owner's Hik/CP-Plus/Lumina/ONVIF cams + latency/quality) validates on their hardware. Flag clearly.

## Definition of done (P2)
A camera's live stream plays in the browser (WebRTC/HLS) via MediaMTX behind token-auth; a multi-cam video wall works with layouts; Streaming nav live; cameras shard across (≥1) MediaMTX node via the supervisor; Go `nvr` owns the media orchestration, Python `vision` issues sessions — verified with a synthetic stream, live-validated on owner hardware. Then P3 (recording).
