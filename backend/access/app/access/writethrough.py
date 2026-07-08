"""DDS write-through CRUD for mirrored entities — ported from neubit_v2 gates.

Every mutation (create / update / delete / assign / status) is pushed to the DDS
controller FIRST (via the brand connector's OData write methods); on success the
returned DTO is upserted into the local ``AccessMirror`` so reads stay consistent
(reads are still served from the mirror — v2 semantics). This is the faithful v3
port of:

  * ``neubit_v2/backend/gates/app/module/cardholder/routes.py`` (create/update/
    delete/suspend/reinstate + card assign/detach; ``_to_dds``/``_from_dds`` field
    maps kept VERBATIM).
  * ``neubit_v2/backend/gates/app/module/card/{routes,schemas}.py`` (card CRUD +
    status; the deterministic create→patch flow and camelCase fallbacks kept).

NOTE: access-groups + schedules are NOT write-through here. In v2 they are LOCAL,
instance-scoped repository catalogs (``module/access_groups``) — ported to
``catalog.py`` (``AccessGroupCatalog`` / ``ScheduleCatalog``). Only the cardholder↔
access-group ASSIGNMENT (mutating a cardholder's ``AccessGroupUIDs`` on the
controller) remains a write-through and stays in this file.

Tenant-scoping: the owning instance is fetched through ``assert_owned`` (an
instance in another tenant reads as 404), so every write-through op is confined to
the caller's tenant. Mirror rows are stamped with the instance's ``tenant_id``.

Graceful degradation: a DDS transport failure surfaces as ``DDSHTTPError`` which
the router translates to a CLEAN HTTP error (502/original status) — never a 500
crash-loop. The dev environment has no live controller, so writes return a clean
error there.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned

from ..connectors.dds import DDSHTTPError
from ..connectors.factory import get_connector
from .crypto import decrypt_secret
from .models import AccessMirror, Instance

log = logging.getLogger("access.writethrough")

# The mirror collections this service can write through. Each maps to a DDS
# entity set inside the connector (COLLECTION_ENTITY_SETS). access-groups +
# schedules are NOT here — they are LOCAL catalogs (see catalog.py).
WRITE_COLLECTIONS = ("cardholders", "cards")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ── DDS ↔ internal field maps (verbatim from v2) ────────────────────────────

# Cardholder status (v2 cardholder/routes._STATUS_TO_DDS / _DDS_TO_STATUS).
_CH_STATUS_TO_DDS: dict[str, str] = {
    "active": "Validated",
    "suspended": "Invalidated",
    "terminated": "Archived",
    "expired": "Invalidated",
}
_CH_DDS_TO_STATUS: dict[str, str] = {
    "Validated": "active",
    "Invalidated": "suspended",
    "Archived": "terminated",
}

# Card field maps (v2 card/schemas._SNAKE_TO_DDS / _DDS_TO_SNAKE / _CAMEL_TO_SNAKE).
_CARD_SNAKE_TO_DDS = {
    "card_code": "CardCode",
    "status": "Status",
    "card_type": "CardType",
    "cardholder_uid": "CardholderUID",
    "reader_function_uid": "ReaderFunctionUID",
    "technology_type": "TechnologyType",
    "description": "Description",
}
_CARD_DDS_TO_SNAKE = {v: k for k, v in _CARD_SNAKE_TO_DDS.items()}
_CARD_CAMEL_TO_SNAKE = {
    "cardCode": "card_code",
    "status": "status",
    "cardType": "card_type",
    "cardholderUID": "cardholder_uid",
    "readerFunctionUID": "reader_function_uid",
    "technologyType": "technology_type",
    "description": "description",
}
# Valid card statuses (v2 card/schemas.CardStatus).
CARD_STATUSES = ("Free", "Used", "Canceled", "Lost", "Stolen", "Archived")


def _cardholder_to_dds(payload: dict[str, Any]) -> dict[str, Any]:
    """snake_case request → DDS PascalCase DTO (v2 cardholder/routes._to_dds)."""
    out: dict[str, Any] = {}
    if "first_name" in payload or "last_name" in payload:
        fn = (payload.get("first_name") or "").strip()
        ln = (payload.get("last_name") or "").strip()
        if not ln and fn:
            ln, fn = fn, ""
        out["FirstName"] = fn
        out["LastName"] = ln
    elif "name" in payload and payload["name"]:
        parts = str(payload["name"]).strip().split(" ", 1)
        if len(parts) == 1:
            out["FirstName"] = ""
            out["LastName"] = parts[0]
        else:
            out["FirstName"] = parts[0]
            out["LastName"] = parts[1]

    if payload.get("employee_id") is not None:
        out["CardholderIdNumber"] = payload["employee_id"]
    if payload.get("email") is not None:
        out["Email"] = payload["email"]
    if payload.get("description") is not None:
        out["Description"] = payload["description"]
    if payload.get("pin_code") is not None:
        out["PinCode"] = payload["pin_code"]
    if payload.get("department_uid") is not None:
        out["DepartmentUID"] = payload["department_uid"]
    if payload.get("security_group_uid") is not None:
        out["SecurityGroupUID"] = payload["security_group_uid"]
    if payload.get("is_supervisor") is not None:
        out["IsSupervisor"] = payload["is_supervisor"]
    if payload.get("need_escort") is not None:
        out["NeedEscort"] = payload["need_escort"]

    if "access_groups" in payload and payload["access_groups"] is not None:
        groups = payload["access_groups"]
        out["AccessGroupUIDs"] = (
            ",".join(str(g) for g in groups) if isinstance(groups, list) else str(groups)
        )

    if "valid_from" in payload:
        vf = payload["valid_from"]
        if vf:
            out["IsFromDateActive"] = True
            out["FromDateValid"] = vf.isoformat() if isinstance(vf, datetime) else str(vf)
        else:
            out["IsFromDateActive"] = False
    if "valid_until" in payload:
        vu = payload["valid_until"]
        if vu:
            out["IsToDateActive"] = True
            out["ToDateValid"] = vu.isoformat() if isinstance(vu, datetime) else str(vu)
        else:
            out["IsToDateActive"] = False

    if "status" in payload and payload["status"] is not None:
        raw = payload["status"]
        status_str = raw.value if hasattr(raw, "value") else str(raw)
        out["Status"] = _CH_STATUS_TO_DDS.get(status_str, "Validated")
    return out


def _cardholder_from_dds(dto: dict[str, Any]) -> dict[str, Any]:
    """DDS mirror DTO → frontend shape (v2 cardholder/routes._from_dds)."""
    first = dto.get("FirstName") or dto.get("firstName") or ""
    last = dto.get("LastName") or dto.get("lastName") or ""
    name = f"{first} {last}".strip() or dto.get("Name") or dto.get("name") or "(unknown)"
    dds_status = dto.get("Status") or dto.get("status") or "Validated"
    internal_status = _CH_DDS_TO_STATUS.get(str(dds_status), "active")
    ag_raw = dto.get("AccessGroupUIDs") or dto.get("accessGroupUIDs") or ""
    access_groups = [g.strip() for g in ag_raw.split(",") if g.strip()] if ag_raw else []
    valid_from = dto.get("FromDateValid") if dto.get("IsFromDateActive") else None
    valid_until = dto.get("ToDateValid") if dto.get("IsToDateActive") else None
    return {
        "cardholder_id": dto.get("UID") or dto.get("uid") or "",
        "name": name,
        "first_name": first,
        "last_name": last,
        "employee_id": dto.get("CardholderIdNumber") or dto.get("cardholderIdNumber"),
        "email": dto.get("Email") or dto.get("email"),
        "cards": [],
        "access_groups": access_groups,
        "valid_from": valid_from,
        "valid_until": valid_until,
        "status": internal_status,
        "photo_url": dto.get("Photo") or dto.get("photo"),
        "department_uid": dto.get("DepartmentUID") or dto.get("departmentUID"),
        "security_group_uid": dto.get("SecurityGroupUID") or dto.get("securityGroupUID"),
        "is_supervisor": dto.get("IsSupervisor") or dto.get("isSupervisor") or False,
        "need_escort": dto.get("NeedEscort") or dto.get("needEscort") or False,
        "description": dto.get("Description") or dto.get("description"),
    }


def _card_to_dds(payload: dict[str, Any]) -> dict[str, Any]:
    return {_CARD_SNAKE_TO_DDS.get(k, k): v for k, v in payload.items() if v is not None}


def _card_from_dds(dto: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    uid = dto.get("UID") or dto.get("uid")
    if uid:
        out["dds_uid"] = uid
    for k, v in dto.items():
        if k.upper() == "UID":
            continue
        if k in _CARD_DDS_TO_SNAKE:
            out[_CARD_DDS_TO_SNAKE[k]] = v
        elif k in _CARD_CAMEL_TO_SNAKE:
            out[_CARD_CAMEL_TO_SNAKE[k]] = v
        else:
            out[k] = v
    return out


class DDSError(Exception):
    """Signals a DDS write failure to the router (carries the upstream status)."""

    def __init__(self, status_code: int, detail: Any) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(str(detail)[:200])


class WriteThroughService:
    """DDS write-through CRUD + assignment/status ops over mirrored entities."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # ── instance + connector ────────────────────────────────────────────
    async def _instance(self, instance_id: str) -> Instance:
        row = await self.db.get(Instance, instance_id)
        assert_owned(row, self.scope, message="Instance not found")
        return row

    def _connector(self, row: Instance):
        return get_connector(row, secret=decrypt_secret(row.secret_enc))

    # ── mirror helpers ──────────────────────────────────────────────────
    async def _upsert_mirror(
        self, inst: Instance, collection: str, dto: dict[str, Any]
    ) -> dict[str, Any]:
        """Upsert the verbatim DDS DTO into ``access_mirror`` (v2 upsert_mirror)."""
        remote_uid = dto.get("UID") or dto.get("uid")
        remote_uid = str(remote_uid) if remote_uid else None
        existing = None
        if remote_uid:
            existing = await self.db.scalar(
                select(AccessMirror).where(
                    AccessMirror.instance_id == inst.id,
                    AccessMirror.collection == collection,
                    AccessMirror.remote_uid == remote_uid,
                )
            )
        if existing is None:
            existing = AccessMirror(
                tenant_id=inst.tenant_id,
                instance_id=inst.id,
                collection=collection,
                remote_uid=remote_uid,
                dto=dto,
                last_synced_at=_utcnow(),
            )
            self.db.add(existing)
        else:
            existing.dto = dto
            existing.last_synced_at = _utcnow()
        await self.db.commit()
        return dto

    async def _delete_mirror(
        self, inst: Instance, collection: str, remote_uid: str
    ) -> None:
        await self.db.execute(
            sa_delete(AccessMirror).where(
                AccessMirror.instance_id == inst.id,
                AccessMirror.collection == collection,
                AccessMirror.remote_uid == remote_uid,
            )
        )
        await self.db.commit()

    async def _get_mirror(
        self, inst: Instance, collection: str, remote_uid: str
    ) -> dict[str, Any] | None:
        row = await self.db.scalar(
            select(AccessMirror).where(
                AccessMirror.instance_id == inst.id,
                AccessMirror.collection == collection,
                AccessMirror.remote_uid == remote_uid,
            )
        )
        return row.dto if row is not None else None

    # ── generic DDS write wrappers (translate DDSHTTPError → DDSError) ───
    async def _create(self, inst: Instance, collection: str, body: dict) -> dict:
        connector = self._connector(inst)
        try:
            return await connector.create_entity(collection, body)
        except DDSHTTPError as exc:
            raise DDSError(exc.status_code, exc.body_text) from None
        finally:
            await connector.aclose()

    async def _update(
        self, inst: Instance, collection: str, uid: str, body: dict
    ) -> dict:
        connector = self._connector(inst)
        try:
            return await connector.update_entity(collection, uid, body)
        except DDSHTTPError as exc:
            raise DDSError(exc.status_code, exc.body_text) from None
        finally:
            await connector.aclose()

    async def _delete(self, inst: Instance, collection: str, uid: str) -> None:
        connector = self._connector(inst)
        try:
            await connector.delete_entity(collection, uid)
        except DDSHTTPError as exc:
            raise DDSError(exc.status_code, exc.body_text) from None
        finally:
            await connector.aclose()

    async def _patch_set(
        self, inst: Instance, entity_set: str, uid: str, body: dict
    ) -> dict:
        connector = self._connector(inst)
        try:
            return await connector.patch_entity_set(entity_set, uid, body)
        except DDSHTTPError as exc:
            raise DDSError(exc.status_code, exc.body_text) from None
        finally:
            await connector.aclose()

    # ── CARDHOLDERS ─────────────────────────────────────────────────────
    async def create_cardholder(self, instance_id: str, payload: dict) -> dict:
        inst = await self._instance(instance_id)
        dds_body = _cardholder_to_dds(payload)
        # DDS create requires LastName (v2 guarantee).
        if not str(dds_body.get("LastName") or "").strip():
            dds_body["LastName"] = (
                str(payload.get("last_name") or "").strip()
                or str(payload.get("name") or "").strip()
                or str(payload.get("first_name") or "").strip()
                or "Unknown"
            )
        dds_body.setdefault("FirstName", str(payload.get("first_name") or "").strip())
        created = await self._create(inst, "cardholders", dds_body)
        await self._upsert_mirror(inst, "cardholders", created)
        return _cardholder_from_dds(created)

    async def update_cardholder(
        self, instance_id: str, cardholder_id: str, payload: dict
    ) -> dict:
        inst = await self._instance(instance_id)
        updated = await self._update(
            inst, "cardholders", cardholder_id, _cardholder_to_dds(payload)
        )
        await self._upsert_mirror(inst, "cardholders", updated)
        return _cardholder_from_dds(updated)

    async def delete_cardholder(self, instance_id: str, cardholder_id: str) -> None:
        inst = await self._instance(instance_id)
        await self._delete(inst, "cardholders", cardholder_id)
        await self._delete_mirror(inst, "cardholders", cardholder_id)

    async def set_cardholder_status(
        self, instance_id: str, cardholder_id: str, dds_status: str
    ) -> dict:
        """Suspend (Invalidated) / reinstate (Validated) — v2 suspend/reinstate."""
        inst = await self._instance(instance_id)
        updated = await self._update(
            inst, "cardholders", cardholder_id, {"Status": dds_status}
        )
        await self._upsert_mirror(inst, "cardholders", updated)
        return _cardholder_from_dds(updated)

    async def assign_card(
        self, instance_id: str, cardholder_id: str, card_id: str
    ) -> dict:
        """Assign a DDS card to this cardholder (v2 cardholder add_card)."""
        inst = await self._instance(instance_id)
        updated_card = await self._patch_set(
            inst, "API_Cards", card_id, {"CardholderUID": cardholder_id}
        )
        await self._upsert_mirror(inst, "cards", updated_card)
        doc = await self._get_mirror(inst, "cardholders", cardholder_id)
        return _cardholder_from_dds(doc or {})

    async def detach_card(
        self, instance_id: str, cardholder_id: str, card_id: str
    ) -> dict:
        """Detach a DDS card from this cardholder (v2 cardholder remove_card)."""
        inst = await self._instance(instance_id)
        updated_card = await self._patch_set(
            inst, "API_Cards", card_id, {"CardholderUID": None}
        )
        await self._upsert_mirror(inst, "cards", updated_card)
        doc = await self._get_mirror(inst, "cardholders", cardholder_id)
        return _cardholder_from_dds(doc or {})

    # ── CARDS ───────────────────────────────────────────────────────────
    async def create_card(self, instance_id: str, payload: dict) -> dict:
        """Deterministic create→patch flow (v2 card/routes.create_card).

        1) create with minimal CardCode + type + Free status,
        2) patch caller-specific fields (type/status/cardholder/etc.)."""
        inst = await self._instance(instance_id)
        create_min = {
            "CardCode": payload["card_code"],
            "CardType": payload.get("card_type") or "Magnetic",
            "Status": "Free",
        }
        followup_card_type = payload.get("card_type") or (
            "TypeA"
            if (payload.get("cardholder_uid") or payload.get("status") == "Used")
            else "Magnetic"
        )
        patch_followup: dict[str, Any] = {"CardType": followup_card_type}
        if payload.get("status") is not None:
            patch_followup["Status"] = payload["status"]
        if payload.get("cardholder_uid") is not None:
            patch_followup["CardholderUID"] = payload["cardholder_uid"]
        if payload.get("reader_function_uid") is not None:
            patch_followup["ReaderFunctionUID"] = payload["reader_function_uid"]
        if payload.get("technology_type") is not None:
            patch_followup["TechnologyType"] = payload["technology_type"]
        if payload.get("description") is not None:
            patch_followup["Description"] = payload["description"]

        created = await self._create(inst, "cards", create_min)
        created_uid = created.get("UID") or created.get("uid")
        if not created_uid:
            raise DDSError(502, {"code": "dds_card_create_missing_uid"})
        if patch_followup:
            created = await self._update(
                inst, "cards", str(created_uid), patch_followup
            )
        await self._upsert_mirror(inst, "cards", created)
        return _card_from_dds(created)

    async def update_card(self, instance_id: str, card_id: str, payload: dict) -> dict:
        inst = await self._instance(instance_id)
        updated = await self._update(inst, "cards", card_id, _card_to_dds(payload))
        await self._upsert_mirror(inst, "cards", updated)
        return _card_from_dds(updated)

    async def set_card_status(
        self, instance_id: str, card_id: str, status: str
    ) -> dict:
        """Set card status (free/used/canceled/lost/stolen) — v2 card update."""
        inst = await self._instance(instance_id)
        updated = await self._update(inst, "cards", card_id, {"Status": status})
        await self._upsert_mirror(inst, "cards", updated)
        return _card_from_dds(updated)

    async def delete_card(self, instance_id: str, card_id: str) -> None:
        inst = await self._instance(instance_id)
        # v2 blocks deletion of "Used" cards.
        doc = await self._get_mirror(inst, "cards", card_id)
        if doc and (doc.get("Status") == "Used" or doc.get("status") == "Used"):
            raise DDSError(409, {"code": "card_in_use", "message": "Cannot delete a card that is in use"})
        await self._delete(inst, "cards", card_id)
        await self._delete_mirror(inst, "cards", card_id)

    # ── CARDHOLDER ↔ ACCESS-GROUP ASSIGNMENT ────────────────────────────
    #
    # NOTE: access-groups + schedules themselves are LOCAL catalogs (see
    # ``catalog.py``) — NOT DDS write-through. Only the cardholder↔group
    # ASSIGNMENT below is a DDS write-through (it mutates the cardholder's
    # AccessGroupUIDs on the controller), so it stays here.

    async def assign_cardholder_to_group(
        self, instance_id: str, cardholder_id: str, group_id: str
    ) -> dict:
        """Add an access-group UID to a cardholder's AccessGroupUIDs (v2 assign)."""
        inst = await self._instance(instance_id)
        doc = await self._get_mirror(inst, "cardholders", cardholder_id) or {}
        ag_raw = doc.get("AccessGroupUIDs") or doc.get("accessGroupUIDs") or ""
        groups = [g.strip() for g in ag_raw.split(",") if g.strip()] if ag_raw else []
        if group_id not in groups:
            groups.append(group_id)
        updated = await self._update(
            inst, "cardholders", cardholder_id,
            {"AccessGroupUIDs": ",".join(groups)},
        )
        await self._upsert_mirror(inst, "cardholders", updated)
        return _cardholder_from_dds(updated)

    async def remove_cardholder_from_group(
        self, instance_id: str, cardholder_id: str, group_id: str
    ) -> dict:
        inst = await self._instance(instance_id)
        doc = await self._get_mirror(inst, "cardholders", cardholder_id) or {}
        ag_raw = doc.get("AccessGroupUIDs") or doc.get("accessGroupUIDs") or ""
        groups = [g.strip() for g in ag_raw.split(",") if g.strip()] if ag_raw else []
        groups = [g for g in groups if g != group_id]
        updated = await self._update(
            inst, "cardholders", cardholder_id,
            {"AccessGroupUIDs": ",".join(groups)},
        )
        await self._upsert_mirror(inst, "cardholders", updated)
        return _cardholder_from_dds(updated)
