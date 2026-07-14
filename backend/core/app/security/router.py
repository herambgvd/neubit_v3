"""Enterprise security API (P6-D).

Endpoints (all under the API prefix), grouped:
  * ``/security/policy``        — read/update the per-tenant 2FA-enforcement policy.
  * ``/security/directory``     — LDAP/AD config CRUD + a manual sync.
  * ``/security/sso``           — OIDC config CRUD.
  * ``/auth/sso/login|callback``— the OIDC authorization-code login flow (public).
  * ``/security/dual-auth``     — the four-eyes ledger (request / approve / deny / consume).
  * ``/security/audit/video``   — service-to-service ingest of video-op audit events.
  * ``/security/erasure``       — right-to-erasure request (scaffold + NATS fan-out).

Config surfaces are gated by ``security.manage``; approvals by ``dualauth.approve``;
audit ingest by ``audit.write`` (a satellite service's API key / JWT).
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.deps import get_current_user, require_permission
from ..auth.models import User
from ..auth.permissions import CorePerm
from ..core.audit import record as audit_record
from ..core.errors import NotFoundError, ValidationError
from ..core.pagination import Page, PageParams, page_params, paginate
from ..db.base import get_db
from ..tenancy.scope import scope_of
from .oidc_client import build_authorization_url, fetch_discovery, gen_state
from .schemas import (
    AuditIngestIn,
    DirectoryConfigIn,
    DirectoryConfigOut,
    DirectorySyncResult,
    DualAuthDecisionIn,
    DualAuthRequestIn,
    DualAuthRequestOut,
    ErasureRequestIn,
    ErasureRequestOut,
    SecurityPolicyIn,
    SecurityPolicyOut,
    SsoCallbackIn,
    SsoConfigIn,
    SsoConfigOut,
    SsoLoginStartOut,
)
from .service import SecurityService

router = APIRouter(prefix="/security", tags=["security"])

# In-process CSRF store for the OIDC ``state`` parameter. A short-lived opaque map
# state -> tenant_id. (v1: in-memory; a multi-replica deploy would move this to Redis.)
_SSO_STATE: dict[str, str | None] = {}


def _directory_out(row) -> DirectoryConfigOut:
    out = DirectoryConfigOut.model_validate(row)
    out.has_bind_password = bool(row.bind_password)
    return out


def _sso_out(row) -> SsoConfigOut:
    out = SsoConfigOut.model_validate(row)
    out.has_client_secret = bool(row.client_secret)
    return out


# === Security policy (2FA enforcement) ======================================
@router.get("/policy", response_model=SecurityPolicyOut)
async def get_policy(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.SECURITY_MANAGE)),
) -> SecurityPolicyOut:
    row = await SecurityService(db).get_policy(scope_of(actor))
    return SecurityPolicyOut.model_validate(row)


@router.put("/policy", response_model=SecurityPolicyOut)
async def update_policy(
    data: SecurityPolicyIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.SECURITY_MANAGE)),
) -> SecurityPolicyOut:
    row = await SecurityService(db).update_policy(scope_of(actor), data)
    await audit_record(
        db, actor=actor, action="security.policy.update", target_type="security_policy",
        target_id=str(row.id), meta={"require_2fa": row.require_2fa},
    )
    return SecurityPolicyOut.model_validate(row)


# === LDAP / AD directory ====================================================
@router.get("/directory", response_model=DirectoryConfigOut | None)
async def get_directory(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.SECURITY_MANAGE)),
):
    row = await SecurityService(db).get_directory(scope_of(actor))
    return _directory_out(row) if row else None


@router.put("/directory", response_model=DirectoryConfigOut)
async def upsert_directory(
    data: DirectoryConfigIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.SECURITY_MANAGE)),
) -> DirectoryConfigOut:
    row = await SecurityService(db).upsert_directory(scope_of(actor), data)
    await audit_record(
        db, actor=actor, action="security.directory.update", target_type="directory_config",
        target_id=str(row.id), meta={"server_uri": row.server_uri},
    )
    return _directory_out(row)


@router.delete("/directory", status_code=204)
async def delete_directory(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.SECURITY_MANAGE)),
) -> None:
    await SecurityService(db).delete_directory(scope_of(actor))
    await audit_record(db, actor=actor, action="security.directory.delete", target_type="directory_config")


@router.post("/directory/sync", response_model=DirectorySyncResult)
async def sync_directory(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.SECURITY_MANAGE)),
) -> DirectorySyncResult:
    """Sync users/groups from the configured directory into core roles.

    LIVE-VALIDATE: requires the ``ldap3`` extra + a reachable directory. Returns
    ``live=true`` when a real bind was used.
    """
    result = await SecurityService(db).sync_directory(scope_of(actor))
    await audit_record(
        db, actor=actor, action="security.directory.sync", target_type="directory_config",
        meta={"created": result.created, "updated": result.updated, "skipped": result.skipped},
    )
    return result


# === OIDC SSO config ========================================================
@router.get("/sso", response_model=SsoConfigOut | None)
async def get_sso(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.SECURITY_MANAGE)),
):
    row = await SecurityService(db).get_sso(scope_of(actor))
    return _sso_out(row) if row else None


@router.put("/sso", response_model=SsoConfigOut)
async def upsert_sso(
    data: SsoConfigIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.SECURITY_MANAGE)),
) -> SsoConfigOut:
    row = await SecurityService(db).upsert_sso(scope_of(actor), data)
    await audit_record(
        db, actor=actor, action="security.sso.update", target_type="sso_config",
        target_id=str(row.id), meta={"issuer": row.issuer},
    )
    return _sso_out(row)


@router.delete("/sso", status_code=204)
async def delete_sso(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.SECURITY_MANAGE)),
) -> None:
    await SecurityService(db).delete_sso(scope_of(actor))
    await audit_record(db, actor=actor, action="security.sso.delete", target_type="sso_config")


# === Dual authorization (four-eyes) =========================================
@router.post("/dual-auth", response_model=DualAuthRequestOut, status_code=201)
async def create_dual_auth(
    data: DualAuthRequestIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> DualAuthRequestOut:
    """Raise a four-eyes request for a sensitive action (export, delete, ...).

    Any authenticated user may REQUEST; a different privileged user must approve.
    """
    req = await SecurityService(db).create_dual_auth(actor, data)
    await audit_record(
        db, actor=actor, action="dualauth.request", target_type="dual_auth_request",
        target_id=str(req.id), meta={"action": req.action, "target_id": req.target_id},
    )
    return DualAuthRequestOut.model_validate(req)


@router.get("/dual-auth", response_model=Page[DualAuthRequestOut])
async def list_dual_auth(
    status: str | None = Query(default=None),
    params: PageParams = Depends(page_params),
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> Page[DualAuthRequestOut]:
    stmt = SecurityService(db).list_dual_auth_query(scope_of(actor), status)
    return await paginate(db, stmt, params, item_model=DualAuthRequestOut)


@router.get("/dual-auth/{req_id}", response_model=DualAuthRequestOut)
async def get_dual_auth(
    req_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> DualAuthRequestOut:
    req = await SecurityService(db).get_dual_auth(scope_of(actor), req_id)
    return DualAuthRequestOut.model_validate(req)


@router.post("/dual-auth/{req_id}/approve", response_model=DualAuthRequestOut)
async def approve_dual_auth(
    req_id: uuid.UUID,
    data: DualAuthDecisionIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.DUALAUTH_APPROVE)),
) -> DualAuthRequestOut:
    req = await SecurityService(db).decide_dual_auth(actor, scope_of(actor), req_id, True, data.note)
    await audit_record(
        db, actor=actor, action="dualauth.approve", target_type="dual_auth_request",
        target_id=str(req.id), meta={"action": req.action},
    )
    return DualAuthRequestOut.model_validate(req)


@router.post("/dual-auth/{req_id}/deny", response_model=DualAuthRequestOut)
async def deny_dual_auth(
    req_id: uuid.UUID,
    data: DualAuthDecisionIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.DUALAUTH_APPROVE)),
) -> DualAuthRequestOut:
    req = await SecurityService(db).decide_dual_auth(actor, scope_of(actor), req_id, False, data.note)
    await audit_record(
        db, actor=actor, action="dualauth.deny", target_type="dual_auth_request",
        target_id=str(req.id), meta={"action": req.action},
    )
    return DualAuthRequestOut.model_validate(req)


@router.post("/dual-auth/{req_id}/consume", response_model=DualAuthRequestOut)
async def consume_dual_auth(
    req_id: uuid.UUID,
    action: str = Query(...),
    target_id: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> DualAuthRequestOut:
    """Verify + burn an approval right before performing the action.

    A satellite service (vision) calls this with the core JWT it verified, passing
    the ``action``/``target_id`` it is about to perform. Returns the consumed row on
    success, or 4xx if not approved / mismatched / already used.
    """
    req = await SecurityService(db).check_and_consume(scope_of(actor), action, target_id, req_id)
    await audit_record(
        db, actor=actor, action="dualauth.consume", target_type="dual_auth_request",
        target_id=str(req.id), meta={"action": action, "target_id": target_id},
    )
    return DualAuthRequestOut.model_validate(req)


# === Video-ops audit ingest (DPDP/GDPR) =====================================
@router.post("/audit/video", status_code=201)
async def ingest_video_audit(
    data: AuditIngestIn,
    db: AsyncSession = Depends(get_db),
    caller: User = Depends(require_permission(CorePerm.AUDIT_WRITE)),
) -> dict:
    """Service-to-service ingest: vision reports a playback/export/delete for the trail.

    The satellite verified the acting user's JWT locally and passes their identity so
    the CORE hash-chain / audit trail is the single tamper-evident record of every
    sensitive video op (who / what / when / camera / range). Gated by ``audit.write``.
    """
    # Build a lightweight actor snapshot so the audit row carries the real user, not
    # the service account, while staying tenant-scoped to the caller's tenant.
    actor_snapshot = type(
        "ActorSnapshot", (), {
            "id": data.actor_id,
            "email": data.actor_email or getattr(caller, "email", None),
            "tenant_id": data.tenant_id or getattr(caller, "tenant_id", None),
        },
    )()
    entry = await audit_record(
        db,
        actor=actor_snapshot,
        action=data.action,
        target_type=data.target_type,
        target_id=data.target_id,
        meta={**(data.meta or {}), "source": "vision", "reported_by": getattr(caller, "email", None)},
    )
    return {"id": str(entry.id), "action": entry.action}


# === Right-to-erasure (DPDP/GDPR) ===========================================
@router.post("/erasure", response_model=ErasureRequestOut, status_code=202)
async def request_erasure(
    data: ErasureRequestIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.SECURITY_MANAGE)),
) -> ErasureRequestOut:
    """Request erasure of a subject's video artefacts (recordings/events).

    SCAFFOLD: core records the request in the audit trail and fans it out over NATS
    to the owning services (vision, workflow) on a ``tenant.<id>.erasure.request``
    subject. The PHYSICAL deletion is performed by the service that owns the data
    (vision recordings, workflow events) — documented as its own follow-up wiring.
    LIVE-VALIDATE: end-to-end erasure once the owning-service consumers are wired.
    """
    from ..core import events_nats

    req_id = uuid.uuid4()
    tenant_id = actor.tenant_id
    dispatched: list[str] = []
    payload = {
        "erasure_id": str(req_id),
        "subject_type": data.subject_type,
        "subject_id": data.subject_id,
        "scope": data.scope,
        "requested_by": str(actor.id),
    }
    if events_nats.is_connected() and tenant_id is not None:
        await events_nats.publish(str(tenant_id), "erasure", "request", payload)
        dispatched = ["vision", "workflow"]
    await audit_record(
        db, actor=actor, action="privacy.erasure.request", target_type=data.subject_type,
        target_id=data.subject_id, meta={"scope": data.scope, "reason": data.reason},
    )
    return ErasureRequestOut(
        id=req_id, subject_type=data.subject_type, subject_id=data.subject_id,
        status="dispatched" if dispatched else "recorded", dispatched_to=dispatched,
    )


# === OIDC SSO login flow (public) ===========================================
sso_router = APIRouter(prefix="/auth/sso", tags=["auth"])


@sso_router.get("/login", response_model=SsoLoginStartOut)
async def sso_login(
    request: Request,
    tenant_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> SsoLoginStartOut:
    """PUBLIC — begin an OIDC login: return the IdP authorization URL to redirect to.

    ``tenant_id`` selects which tenant's SSO config to use (NULL = platform SSO).
    """
    svc = SecurityService(db)
    cfg = await svc.get_sso_for_tenant(tenant_id)
    if cfg is None or not cfg.enabled:
        raise NotFoundError("no SSO configured for this tenant")
    from .oidc_client import HttpxAdapter

    discovery = await fetch_discovery(HttpxAdapter(), cfg.issuer)
    state = gen_state()
    _SSO_STATE[state] = str(tenant_id) if tenant_id else None
    url = build_authorization_url(discovery, cfg, state)
    return SsoLoginStartOut(authorization_url=url, state=state)


@sso_router.post("/callback")
async def sso_callback(
    data: SsoCallbackIn,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """PUBLIC — the IdP redirect target: exchange the code and issue core tokens.

    Verifies the ``state`` (CSRF), exchanges the ``code`` for the id_token, maps the
    claims to a core user (provisioning if allowed), and mints the core access +
    refresh tokens. LIVE-VALIDATE against a real IdP; CI mocks the token exchange.
    """
    from ..auth.service import AuthService

    stored_tenant = _SSO_STATE.pop(data.state, "__missing__")
    if stored_tenant == "__missing__":
        raise ValidationError("invalid or expired SSO state")
    tenant_id = uuid.UUID(stored_tenant) if stored_tenant else None
    svc = SecurityService(db)
    cfg = await svc.get_sso_for_tenant(tenant_id)
    if cfg is None or not cfg.enabled:
        raise NotFoundError("no SSO configured")
    user = await svc.sso_exchange(cfg, data.code)
    # Issue a real revocable session exactly like /auth/login/mfa does.
    access, refresh = await AuthService(db).issue_tokens(
        user, user_agent=request.headers.get("user-agent"),
        ip=request.client.host if request.client else None,
    )
    await audit_record(
        db, actor=user, action="auth.sso_login", target_type="user", target_id=str(user.id),
        meta={"issuer": cfg.issuer},
    )
    return {"access_token": access, "refresh_token": refresh, "token_type": "bearer"}


# Both routers are exported so app.py can mount them.
routers = [router, sso_router]
