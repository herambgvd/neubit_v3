"""Mobile-push connector — FCM (Android/web) + APNs (iOS) delivery.

A push notification for a notify request / VMS popup goes to every enabled device
token a user has registered (``device_tokens`` table). The connector:

  1. resolves the target user_id (the notification's ``recipient``),
  2. looks up that user's enabled tokens for the target tenant (tenant-isolated),
  3. builds a provider request per token — FCM HTTP v1 or APNs token-based HTTP/2 —
     carrying the title/body + a ``data`` payload (tenant_id, event type, camera_id,
     incident_id, deep-link) so the mobile client can open the right screen, and
  4. prunes (disables) any token the provider reports invalid/unregistered.

Provider config is resolved the same way the other connectors resolve it:
  * per-tenant ``NotificationChannel.config`` (channel_type ``push``), and/or
  * service-level env vars (``VE_FCM_*`` / ``VE_APNS_*``) as a fallback.

Credentials (FCM service-account JSON, APNs ``.p8`` signing key) are read from the
channel config or env. Following the webhook connector's convention, secrets live
in the channel ``config`` blob (there is no kernel Fernet helper available to this
service; core owns secrets-at-rest). Everything provider-specific (``httpx``,
``google-auth``, ``PyJWT``, ``cryptography``) is LAZY-imported inside ``send`` so
the worker boots and degrades gracefully when a credential/SDK is absent — a
missing credential logs + no-ops (raises a clear ``RuntimeError`` the dispatch
task records) rather than crashing.

Design mirrors ``email.py`` / ``webhook.py``: one stateless connector instance
serves every tenant; all state comes in via the resolved ``DeliveryContext``.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

from .base import Connector, DeliveryContext

log = logging.getLogger("workflow.connectors.push")

# FCM HTTP v1 send endpoint (per-project). ``{project_id}`` is filled from creds.
_FCM_ENDPOINT = "https://fcm.googleapis.com/v1/projects/{project_id}/messages:send"
_FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"

# APNs HTTP/2 endpoints (token-based auth). Sandbox for dev builds.
_APNS_PROD = "https://api.push.apple.com"
_APNS_DEV = "https://api.sandbox.push.apple.com"

# APNs auth token (JWT) is reusable for up to ~1h; refresh at 50 min.
_APNS_TOKEN_TTL = 50 * 60


@dataclass
class PushToken:
    """One registered device token the connector should deliver to."""

    device_token_id: str
    platform: str  # "fcm" | "apns"
    token: str


# A token resolver: given (tenant_id, user_id) → the user's enabled PushTokens.
# Injected so the connector stays transport-only + unit-testable without a DB.
TokenResolver = Callable[[Optional[str], str], Awaitable[list[PushToken]]]
# A pruner: called with device_token_ids the provider rejected → disable them.
TokenPruner = Callable[[list[str]], Awaitable[None]]


class PushConnector(Connector):
    """FCM + APNs push connector.

    ``recipient`` on the notification is the target **user_id**; the connector fans
    the push out to that user's registered device tokens (scoped to the
    notification's tenant). ``token_resolver`` / ``token_pruner`` default to the DB
    helpers in ``app.workflow.push_tokens`` but can be injected for tests.
    """

    channel_type = "push"

    def __init__(
        self,
        token_resolver: TokenResolver | None = None,
        token_pruner: TokenPruner | None = None,
    ) -> None:
        self._resolver = token_resolver
        self._pruner = token_pruner

    # -- resolver / pruner (lazy default to DB helpers) --------------------

    async def _resolve_tokens(self, tenant_id: str | None, user_id: str) -> list[PushToken]:
        if self._resolver is not None:
            return await self._resolver(tenant_id, user_id)
        from ..push_tokens import resolve_tokens  # lazy — avoids DB import at module load

        return await resolve_tokens(tenant_id, user_id)

    async def _prune_tokens(self, device_token_ids: list[str]) -> None:
        if not device_token_ids:
            return
        if self._pruner is not None:
            await self._pruner(device_token_ids)
            return
        from ..push_tokens import prune_tokens  # lazy

        await prune_tokens(device_token_ids)

    # -- send -------------------------------------------------------------

    async def send(self, ctx: DeliveryContext) -> None:
        cfg = ctx.channel_config or {}
        user_id = (ctx.recipient or "").strip()
        if not user_id:
            raise RuntimeError("push connector: no recipient user_id on notification")

        tokens = await self._resolve_tokens(ctx.tenant_id, user_id)
        if not tokens:
            # No registered devices is not an error the dispatcher should retry on;
            # log and treat as delivered (nothing to send).
            log.info("push: no registered device tokens for user=%s (tenant=%s)", user_id, ctx.tenant_id)
            return

        data = _build_data_payload(ctx)
        title = ctx.subject or "Neubit"
        body = ctx.body or ""

        fcm = [t for t in tokens if t.platform == "fcm"]
        apns = [t for t in tokens if t.platform == "apns"]

        delivered = 0
        invalid: list[str] = []
        errors: list[str] = []

        if fcm:
            d, bad, errs = await _send_fcm(cfg, fcm, title, body, data)
            delivered += d
            invalid += bad
            errors += errs
        if apns:
            d, bad, errs = await _send_apns(cfg, apns, title, body, data)
            delivered += d
            invalid += bad
            errors += errs

        # Prune tokens the provider rejected as invalid/unregistered.
        await self._prune_tokens(invalid)

        if delivered == 0 and errors:
            # Nothing got through and at least one hard error — surface it so the
            # dispatch task records + retries (bounded by attempts).
            raise RuntimeError("push connector: all deliveries failed: " + "; ".join(errors[:3]))

        log.info(
            "push delivered to %d/%d device(s) for user=%s (tenant=%s, pruned=%d)",
            delivered, len(tokens), user_id, ctx.tenant_id, len(invalid),
        )


# ── data payload ────────────────────────────────────────────────────────


def _build_data_payload(ctx: DeliveryContext) -> dict[str, str]:
    """The ``data`` map the mobile client uses to open the right screen.

    FCM ``data`` values MUST be strings; APNs custom keys are looser but we keep the
    same string map for consistency. A ``deep_link`` (``neubit://…``) is derived
    from the metadata so a tap opens the incident / live camera directly.
    """
    md = ctx.metadata or {}
    event_type = str(md.get("event_type") or md.get("type") or "")
    camera_id = str(md.get("camera_id") or "")
    incident_id = str(md.get("incident_id") or md.get("instance_id") or "")
    event_id = str(md.get("event_id") or "")
    tenant_id = str(ctx.tenant_id or "")

    data = {
        "tenant_id": tenant_id,
        "event_type": event_type,
        "camera_id": camera_id,
        "incident_id": incident_id,
        "event_id": event_id,
        "deep_link": md.get("deep_link") or _deep_link(incident_id, camera_id),
    }
    # Drop empties so the payload stays lean.
    return {k: v for k, v in data.items() if v}


def _deep_link(incident_id: str, camera_id: str) -> str:
    """Derive a ``neubit://`` deep link from the event identifiers.

    Priority: an incident opens the incident detail; else a camera opens live view;
    else the app home. The mobile client maps this scheme to a screen/route.
    """
    if incident_id:
        return f"neubit://incidents/{incident_id}"
    if camera_id:
        return f"neubit://cameras/{camera_id}/live"
    return "neubit://home"


# ── FCM (HTTP v1) ─────────────────────────────────────────────────────────


def _fcm_service_account(cfg: dict[str, Any]) -> dict[str, Any] | None:
    """Resolve the FCM service-account dict from channel config or env.

    Accepts, in order: ``cfg['service_account']`` (a dict), ``cfg['service_account_json']``
    (a JSON string), env ``VE_FCM_SERVICE_ACCOUNT_JSON`` (JSON string), or env
    ``VE_FCM_SERVICE_ACCOUNT_FILE`` (a path). Returns None when nothing is configured.
    """
    sa = cfg.get("service_account")
    if isinstance(sa, dict):
        return sa
    raw = cfg.get("service_account_json") or os.getenv("VE_FCM_SERVICE_ACCOUNT_JSON")
    if raw:
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            log.warning("push/fcm: service_account_json is not valid JSON")
            return None
    path = cfg.get("service_account_file") or os.getenv("VE_FCM_SERVICE_ACCOUNT_FILE")
    if path and os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            log.warning("push/fcm: could not read service_account_file=%s", path)
    return None


async def _fcm_access_token(service_account: dict[str, Any]) -> str:
    """Mint a short-lived OAuth2 bearer for FCM from the service account.

    ``google.oauth2.service_account`` is lazy-imported (heavy, optional dep). Token
    minting is a blocking call, so it runs in a thread.
    """
    import asyncio

    from google.oauth2 import service_account as _sa  # lazy
    from google.auth.transport.requests import Request  # lazy

    def _mint() -> str:
        creds = _sa.Credentials.from_service_account_info(
            service_account, scopes=[_FCM_SCOPE]
        )
        creds.refresh(Request())
        return creds.token

    return await asyncio.to_thread(_mint)


def _fcm_message(token: str, title: str, body: str, data: dict[str, str]) -> dict[str, Any]:
    """Build one FCM HTTP v1 message envelope for a single device token."""
    return {
        "message": {
            "token": token,
            "notification": {"title": title, "body": body},
            "data": data,
            "android": {"priority": "high"},
        }
    }


async def _send_fcm(
    cfg: dict[str, Any], tokens: list[PushToken], title: str, body: str, data: dict[str, str]
) -> tuple[int, list[str], list[str]]:
    """Deliver to FCM tokens. Returns (delivered, invalid_device_token_ids, errors)."""
    service_account = _fcm_service_account(cfg)
    if not service_account:
        # Graceful degrade: no credential → no-op with a clear signal.
        log.warning("push/fcm: no service account configured; skipping %d token(s)", len(tokens))
        return 0, [], ["fcm: no service account configured"]

    project_id = service_account.get("project_id") or cfg.get("project_id")
    if not project_id:
        return 0, [], ["fcm: service account missing project_id"]

    try:
        bearer = await _fcm_access_token(service_account)
    except Exception as exc:  # google-auth missing OR mint failed
        log.warning("push/fcm: could not obtain access token: %s", exc)
        return 0, [], [f"fcm: token mint failed: {exc}"]

    import httpx  # lazy

    endpoint = _FCM_ENDPOINT.format(project_id=project_id)
    headers = {"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"}
    delivered = 0
    invalid: list[str] = []
    errors: list[str] = []
    timeout = float(cfg.get("timeout", 10))

    async with httpx.AsyncClient(timeout=timeout) as client:
        for t in tokens:
            try:
                resp = await client.post(
                    endpoint, headers=headers, json=_fcm_message(t.token, title, body, data)
                )
            except Exception as exc:  # network — retryable, don't prune
                errors.append(f"fcm {t.device_token_id}: {exc}")
                continue
            if resp.status_code == 200:
                delivered += 1
            elif resp.status_code in (400, 404):
                # UNREGISTERED / invalid token → prune.
                if _fcm_is_unregistered(resp):
                    invalid.append(t.device_token_id)
                else:
                    errors.append(f"fcm {t.device_token_id}: {resp.status_code} {resp.text[:200]}")
            else:
                errors.append(f"fcm {t.device_token_id}: {resp.status_code} {resp.text[:200]}")
    return delivered, invalid, errors


def _fcm_is_unregistered(resp) -> bool:
    """True when an FCM error response marks the token permanently invalid."""
    try:
        err = resp.json().get("error", {})
    except Exception:  # noqa: BLE001
        return resp.status_code == 404
    status = err.get("status", "")
    if status in ("NOT_FOUND", "UNREGISTERED", "INVALID_ARGUMENT"):
        return True
    for detail in err.get("details", []) or []:
        if detail.get("errorCode") in ("UNREGISTERED", "INVALID_ARGUMENT"):
            return True
    return False


# ── APNs (token-based, HTTP/2) ────────────────────────────────────────────

# Module-level cache of the current APNs JWT: (token, minted_at). One key id/team
# per process is the common case; keyed by (key_id, team_id) to be safe.
_apns_jwt_cache: dict[tuple[str, str], tuple[str, float]] = {}


def _apns_config(cfg: dict[str, Any]) -> dict[str, Any] | None:
    """Resolve APNs token-auth config from channel config or env.

    Needs: ``key_id``, ``team_id``, ``topic`` (the app bundle id), the ``.p8``
    signing key (``auth_key`` PEM string, ``auth_key_file`` path, or env), and an
    optional ``use_sandbox`` flag. Returns None when incomplete.
    """
    key_id = cfg.get("key_id") or os.getenv("VE_APNS_KEY_ID")
    team_id = cfg.get("team_id") or os.getenv("VE_APNS_TEAM_ID")
    topic = cfg.get("topic") or cfg.get("bundle_id") or os.getenv("VE_APNS_TOPIC")

    auth_key = cfg.get("auth_key") or os.getenv("VE_APNS_AUTH_KEY")
    if not auth_key:
        path = cfg.get("auth_key_file") or os.getenv("VE_APNS_AUTH_KEY_FILE")
        if path and os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as fh:
                    auth_key = fh.read()
            except OSError:
                auth_key = None

    if not (key_id and team_id and topic and auth_key):
        return None

    use_sandbox = bool(cfg.get("use_sandbox", str(os.getenv("VE_APNS_USE_SANDBOX", "")).lower() in ("1", "true", "yes")))
    return {
        "key_id": key_id, "team_id": team_id, "topic": topic,
        "auth_key": auth_key, "use_sandbox": use_sandbox,
    }


def _apns_jwt(conf: dict[str, Any]) -> str:
    """Mint (or reuse a cached) APNs auth JWT signed with the ES256 ``.p8`` key.

    ``PyJWT`` (+ ``cryptography`` for ES256) is lazy-imported. The token is cached
    for ~50 min per (key_id, team_id).
    """
    key_id, team_id = conf["key_id"], conf["team_id"]
    cache_key = (key_id, team_id)
    cached = _apns_jwt_cache.get(cache_key)
    now = time.time()
    if cached and (now - cached[1]) < _APNS_TOKEN_TTL:
        return cached[0]

    import jwt  # lazy — PyJWT

    token = jwt.encode(
        {"iss": team_id, "iat": int(now)},
        conf["auth_key"],
        algorithm="ES256",
        headers={"kid": key_id, "alg": "ES256"},
    )
    _apns_jwt_cache[cache_key] = (token, now)
    return token


def _apns_payload(title: str, body: str, data: dict[str, str]) -> dict[str, Any]:
    """Build the APNs JSON payload (aps alert + custom data keys)."""
    payload: dict[str, Any] = {
        "aps": {"alert": {"title": title, "body": body}, "sound": "default"},
    }
    # Custom keys ride alongside ``aps`` — the client reads them like FCM ``data``.
    payload.update(data)
    return payload


async def _send_apns(
    cfg: dict[str, Any], tokens: list[PushToken], title: str, body: str, data: dict[str, str]
) -> tuple[int, list[str], list[str]]:
    """Deliver to APNs tokens (token-based HTTP/2).

    Returns (delivered, invalid_device_token_ids, errors). Real HTTP/2 delivery
    needs a live APNs cert + device token; the request build is fully wired here.
    """
    conf = _apns_config(cfg)
    if not conf:
        log.warning("push/apns: incomplete token-auth config; skipping %d token(s)", len(tokens))
        return 0, [], ["apns: no token-auth config (key_id/team_id/topic/auth_key)"]

    try:
        bearer = _apns_jwt(conf)
    except Exception as exc:  # PyJWT/cryptography missing OR sign failed
        log.warning("push/apns: could not mint auth JWT: %s", exc)
        return 0, [], [f"apns: jwt mint failed: {exc}"]

    import httpx  # lazy — HTTP/2 requires httpx[http2] (h2 installed)

    base = _APNS_DEV if conf["use_sandbox"] else _APNS_PROD
    headers = {
        "authorization": f"bearer {bearer}",
        "apns-topic": conf["topic"],
        "apns-push-type": "alert",
        "apns-priority": "10",
    }
    payload = _apns_payload(title, body, data)
    timeout = float(cfg.get("timeout", 10))
    delivered = 0
    invalid: list[str] = []
    errors: list[str] = []

    try:
        client = httpx.AsyncClient(http2=True, timeout=timeout)
    except Exception as exc:  # h2 not installed
        log.warning("push/apns: HTTP/2 client unavailable (%s); LIVE-VALIDATE needs httpx[http2]", exc)
        return 0, [], [f"apns: http2 unavailable: {exc}"]

    async with client:
        for t in tokens:
            url = f"{base}/3/device/{t.token}"
            try:
                resp = await client.post(url, headers=headers, json=payload)
            except Exception as exc:  # network — retryable, don't prune
                errors.append(f"apns {t.device_token_id}: {exc}")
                continue
            if resp.status_code == 200:
                delivered += 1
            elif resp.status_code in (400, 410) and _apns_is_unregistered(resp):
                # 410 Gone / 400 BadDeviceToken → prune.
                invalid.append(t.device_token_id)
            else:
                errors.append(f"apns {t.device_token_id}: {resp.status_code} {resp.text[:200]}")
    return delivered, invalid, errors


def _apns_is_unregistered(resp) -> bool:
    """True when APNs marks the device token permanently invalid."""
    if resp.status_code == 410:
        return True  # Unregistered
    try:
        reason = resp.json().get("reason", "")
    except Exception:  # noqa: BLE001
        return False
    return reason in ("BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic")
