# Neubit v3 — Mobile Client Contract (VMS P6-E)

This document is the integration contract for a native / mobile client (iOS,
Android, or a mobile web app) against the neubit_v3 command-center backend. The
backend is already REST + JWT + HLS/WebRTC, so a mobile app is **just another API
client** — P6-E adds the one piece a native app needs that a browser does not:
**mobile push** (FCM/APNs) for events and VMS popups, plus a place to register a
device's push token.

Everything below cites real endpoints that exist in the code today. All paths are
served through the gateway at `:80`; unless noted, they require a
`Authorization: Bearer <access_token>` header and run inside the caller's tenant
scope.

- Core (auth, realtime, media-verify): `backend/core`
- VMS (cameras, live, playback, events): `backend/vision` (service prefix `/api/v1`, VMS routers under `/vms`)
- Workflow (incidents, notifications, **push device tokens**): `backend/workflow` (`/api/v1/workflow`)

> Convention: the VMS service mounts under the gateway with the `/api/v1` prefix,
> so a VMS path shown as `/vms/cameras/{id}/live` is reached at
> `/api/v1/vms/cameras/{id}/live`. Workflow paths are `/api/v1/workflow/...`.

---

## 1. Authentication

Standard JWT: a short-lived **access token** (Bearer) + a **refresh token**. The
access token embeds `sub` (user_id), `tenant_id`, `is_superadmin`, and
`permissions[]`; every service verifies it with the shared kernel — the tenant
scope and permission checks are the same across core / vision / workflow.

| Action | Endpoint | Notes |
| --- | --- | --- |
| Login | `POST /api/v1/auth/login` | Body `{email, password}`. Returns `LoginResult` — either tokens, or an MFA challenge (`{mfa_token}`) when 2FA is enrolled/enforced. |
| Login (MFA step) | `POST /api/v1/auth/login/mfa` | Body `{mfa_token, code}` → tokens. |
| Refresh | `POST /api/v1/auth/refresh` | Body `{refresh_token}` → a new access token. Call this when a request returns 401. |
| Current user | `GET /api/v1/auth/me` | The signed-in user's profile. |
| Sessions | `GET /api/v1/auth/me/sessions` | Revocable sessions (a device can list/revoke). |
| Logout | `POST /api/v1/auth/logout` | Revokes the current session. |

**Tenant scoping is implicit** — it is carried in the token, not the URL. A user
belongs to one tenant (or is a platform super-admin); every list/read is already
filtered to that tenant server-side. The mobile client never sends a tenant id.

**2FA**: if login returns an enrollment/challenge response, drive it through
`/api/v1/auth/2fa/enroll/begin` → `/api/v1/auth/2fa/enroll/confirm` (enforced
enrollment) or `/api/v1/auth/login/mfa` (challenge). TOTP; the client shows the
`otpauth://` URI as a QR or lets the user paste the secret.

---

## 2. REST surfaces a mobile client consumes

### Cameras (VMS)
- `GET  /api/v1/vms/cameras` — list cameras (tenant-scoped; supports paging/filter).
- `GET  /api/v1/vms/cameras/{id}` — one camera's detail (status, capabilities).
- `GET  /api/v1/vms/cameras/{id}/snapshot` — a still image (where the driver supports it).

### Live video (session → media token → HLS/WebRTC)
Live is a **two-step**: issue a session (authorized, tenant-scoped), then play the
returned media URL (authorized by a short-lived media token, not the bearer).

- `POST   /api/v1/vms/cameras/{id}/live` — issue a `PlaybackSession`. Optional body `{profile: "sub"|"main"}` (default `sub`, the low-bitrate stream — prefer it on mobile/cellular). Response carries the play URL(s) + a `media_token` + expiry.
- `POST   /api/v1/vms/cameras/{id}/live/{session}/renew` — re-mint the media token before it expires (keep the stream alive).
- `DELETE /api/v1/vms/live/{session}` — release the session when the user leaves the view.

### Recorded video (playback)
- `POST /api/v1/vms/cameras/{id}/playback` — body `{from, to, profile?}` → a recorded `PlaybackSession` (same media-token model as live).
- Export (clip download) lives under `/api/v1/vms/...` (`export` router) for save-to-device.

### Events / incidents
- `GET /api/v1/vms/events` — VMS camera events (motion, analytics, etc.), tenant-scoped, filterable by camera/time.
- `GET /api/v1/workflow/instances` — incidents (the SOP state machine): list/filter by status/priority/site/assignee, `?q=` search.
- `GET /api/v1/workflow/instances/{id}` — one incident, including its timeline.
- `GET /api/v1/workflow/instances/{id}/available-transitions` — the actions the operator may take now.
- `PATCH /api/v1/workflow/instances/{id}/transition` — advance the incident (with optional note/form data). Also `/assign`, `/status`, `/escalate`.

---

## 3. Live + recorded video URLs (MediaMTX HLS/WebRTC + ForwardAuth)

Playback goes through **MediaMTX** fronted by Traefik. The URL returned by a
`live` / `playback` session is authorized by a **media token** (an HMAC token
baked with the camera + tenant at issue time), NOT by the JWT — so the video
player does not carry the bearer.

- The player appends the media token: `...<hls-or-webrtc-url>?token=<media_token>`.
- Traefik does a **ForwardAuth** to `GET /api/v1/vms/media/verify?token=<media_token>` (PUBLIC — no bearer). It returns `200` when valid, `401`/`403` otherwise; MediaMTX only serves the stream on a `200`.
- HLS is the portable default (works in `AVPlayer` / ExoPlayer / `hls.js`). WebRTC (WHEP) is available for low-latency where the client supports it.
- Renew the media token via the session `renew` endpoint before expiry; on a `401`/`403` from `media/verify`, re-issue or renew the session and rebuild the URL.

**Flow (live):**
1. `POST /api/v1/vms/cameras/{id}/live` (bearer) → `{session_id, media_token, hls_url, webrtc_url, expires_at}`.
2. Play `hls_url?token=<media_token>` (or the WebRTC URL) — Traefik verifies each media request via ForwardAuth.
3. `renew` before `expires_at`; `DELETE .../live/{session_id}` on exit.

---

## 4. Realtime (SSE bridges on core)

The core service bridges NATS domain events to the browser/mobile over
**Server-Sent Events** (`text/event-stream`). `EventSource` cannot set headers, so
these accept the token as a `?token=<jwt>` query param first, then fall back to a
Bearer header (a native client can use either).

- `GET /api/v1/realtime/incidents?token=<jwt>` — workflow incidents stream (`incident.created` / `transitioned` / `escalated` / …). Keeps an incident list live without polling.
- `GET /api/v1/realtime/vms-events?token=<jwt>&camera_id=<id>` — VMS camera events (and popups) stream; `camera_id` filter optional.

Use SSE for **in-app foreground** liveness (open list, live camera page). Use
**push** (section 5) for **background / closed-app** alerts. They complement each
other: the same underlying event may arrive via SSE (if the app is open) and via
push (if it is not).

---

## 5. Push (FCM / APNs)

P6-E adds a `push` notification channel and a device-token registry in the
**workflow** service. When an event/popup fires, the workflow connector framework
fans a push out to the target user's registered devices.

### 5.1 Register a device token

After the client obtains its provider token (FCM registration id on
Android/web-push, APNs device token on iOS), register it:

- `POST /api/v1/workflow/notifications/devices`
  ```json
  { "platform": "fcm", "token": "<provider-token>", "label": "Pixel 8" }
  ```
  `platform` is `fcm` (Android / web) or `apns` (iOS). The row is stamped with the
  caller's `user_id` + tenant automatically. Re-registering the same token is an
  **upsert** (updates the label, re-enables) — safe to call on every app start /
  token rotation. Response echoes the row with the token **masked**.

- `GET    /api/v1/workflow/notifications/devices` — the caller's registered devices.
- `DELETE /api/v1/workflow/notifications/devices` — body `{platform, token}` to unregister a specific token (call on logout).
- `DELETE /api/v1/workflow/notifications/devices/{device_token_id}` — unregister by id.

Gated by the `workflow.notification.read` permission (registration is self-service
for one's own devices). **Tenant isolation:** a push only ever reaches tokens of
the target tenant's users.

Tokens the provider reports invalid/unregistered are auto-pruned (disabled)
server-side, so the client does not need to clean up stale tokens — but it should
re-register on token rotation.

### 5.2 Push payload schema

A push carries a **notification** (title/body, shown by the OS) and a **data**
map the client uses to route. The `data` map (FCM `data` / APNs custom keys):

```json
{
  "tenant_id":   "<uuid>",
  "event_type":  "vms.motion | workflow.incident.created | ...",
  "camera_id":   "<camera id, when relevant>",
  "incident_id": "<workflow instance id, when relevant>",
  "event_id":    "<source event id, when present>",
  "deep_link":   "neubit://incidents/<id>  |  neubit://cameras/<id>/live  |  neubit://home"
}
```
Empty keys are omitted. FCM `data` values are always strings; APNs custom keys use
the same string map alongside `aps.alert`.

- **FCM** (Android/web): `notification.title/body` + `data`, `android.priority=high`.
- **APNs** (iOS): `aps.alert.{title,body}` + `sound` + the custom keys above.

### 5.3 Deep-link scheme

The `deep_link` tells the app which screen to open on tap:

| deep_link | Opens |
| --- | --- |
| `neubit://incidents/<instance_id>` | Incident detail (drives the SOP transitions from section 2). |
| `neubit://cameras/<camera_id>/live` | Live view for that camera (kick off the section-3 flow). |
| `neubit://home` | App home (no specific target). |

Incident wins over camera when both are present. The client registers the
`neubit://` scheme and maps host + path to its navigation.

### 5.4 Where pushes originate

Two event shapes on the NATS spine feed the push channel (consumed by the workflow
`NotifyConsumer` → notification outbox → push connector):

- `tenant.<id>.notify.request` `{channel, target?, subject?, body?, event_id, camera_id?, event_type?, incident_id?, severity?}` — a channel-agnostic request (vision linkage `notify` action, report scheduler). `channel=push` with a `target` user_id pushes to that user; with no `target` it fans out to every tenant user that has a registered device.
- `tenant.<id>.vms.popup` `{camera_id, reason, event_id, event_type?, severity?}` — a "look at this camera now" popup; routed to `push` and fanned out to the tenant's operators who have a registered device. The `deep_link` opens the camera live view.

---

## 6. Client lifecycle checklist

1. **Login** → store access + refresh tokens; on `401`, `POST /auth/refresh`.
2. **Register push token** (`POST /workflow/notifications/devices`) after login and on token rotation.
3. **Foreground**: open the SSE streams (`/realtime/incidents`, `/realtime/vms-events`) for live updates; open camera live via the session→media-token flow.
4. **Background**: rely on push; on tap, follow `deep_link`.
5. **Logout**: unregister the device token (`DELETE /workflow/notifications/devices`), revoke the session (`POST /auth/logout`).

---

## 7. Status / LIVE-VALIDATE

- Backend surfaces (auth, cameras, live/playback sessions, media-verify, SSE bridges, incidents, device-token registration, push connector + notify consumer) exist in code today.
- **Real push delivery** requires provider credentials + a real device token and is a `# LIVE-VALIDATE` step: a real FCM project (service-account JSON) and a real APNs auth key (`.p8` + key_id/team_id/topic). The push connector's FCM path and APNs request build are wired; APNs real HTTP/2 delivery needs `httpx[http2]` (the `push` extra) + a live cert. See `backend/workflow/app/workflow/connectors/push.py`.
- A **native app** (screens, players, notification handlers) is a separate deliverable; P6-E makes the backend mobile-ready and ships push.
