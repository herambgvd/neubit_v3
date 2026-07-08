"""Operator commands + hardware proxy against the controller.

v3 port of:
  * ``neubit_v2/backend/gates/app/module/commands/routes.py`` — thin POST surface
    mapping to DDS OData *action* endpoints (Outputs Activate/Deactivate/…,
    AlarmZones Arm/Disarm/ReturnToWeeklyProgram, Controllers InitializeController,
    Sites StartAllPolling/StopAllPolling). The action→(entity_set, action) map +
    request body shapes are kept verbatim (DDS uids/apiKeys/period/armType/…).
  * ``neubit_v2/backend/gates/app/module/hardware/routes.py`` — read-only OData
    passthrough for sites/controllers/readers/inputs/outputs/alarm_zones/areas,
    with the same camelCase→PascalCase field normalization for the frontend.

Everything runs through the brand connector (``invoke_action`` / ``list_hardware``),
so it stays brand-agnostic. Both degrade gracefully when the controller is
unreachable (dev has no live DDS): a ``CommandError`` carrying the upstream status
is raised and the router turns it into a CLEAN HTTP error — never a 500 crash.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned

from ..connectors.dds import DDSHTTPError
from ..connectors.factory import get_connector
from .crypto import decrypt_secret
from .models import Instance

# camelCase (Amadeus8) → PascalCase, verbatim from v2 hardware/routes.
_CAMEL_TO_PASCAL: dict[str, str] = {
    "uid": "UID",
    "name": "Name",
    "apiKey": "ApiKey",
    "description": "Description",
    "isPolling": "IsPolling",
    "isConnected": "IsConnected",
    "firmwareVersion": "FirmwareVersion",
    "purpose": "Purpose",
    "address": "Address",
    "port": "Port",
    "controllerUID": "ControllerUID",
    "ControllerUID": "ControllerUID",
    "readerUID": "ReaderUID",
    "ReaderUID": "ReaderUID",
    "isArm": "IsArm",
    "isBypassed": "IsBypassed",
    "alarmStatus": "AlarmStatus",
    "AlarmStatus": "AlarmStatus",
}

# Public hardware path segment → logical hardware set (connector maps to API_*).
HARDWARE_SETS = (
    "sites",
    "controllers",
    "readers",
    "inputs",
    "outputs",
    "alarm_zones",
    "areas",
)


def _normalize(item: dict) -> dict:
    if not isinstance(item, dict):
        return item
    return {_CAMEL_TO_PASCAL.get(k, k): v for k, v in item.items()}


class CommandError(Exception):
    """Signals a command/hardware failure to the router (carries a status)."""

    def __init__(self, status_code: int, detail: Any) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(str(detail)[:200])


class CommandService:
    """Tenant-scoped operator commands + hardware proxy through the connector."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _instance(self, instance_id: str) -> Instance:
        row = await self.db.get(Instance, instance_id)
        assert_owned(row, self.scope, message="Instance not found")
        return row

    # ── OData actions ───────────────────────────────────────────────────
    async def _invoke(self, instance_id: str, action_key: str, params: dict) -> Any:
        inst = await self._instance(instance_id)
        connector = get_connector(inst, secret=decrypt_secret(inst.secret_enc))
        try:
            result = await connector.invoke_action(action_key, params)
        except DDSHTTPError as exc:
            raise CommandError(exc.status_code, exc.body_text) from None
        except Exception as exc:  # noqa: BLE001 — never 500 on a dead controller
            raise CommandError(502, {"message": str(exc) or type(exc).__name__}) from None
        finally:
            await connector.aclose()
        return {"ok": True, "result": result}

    # Outputs (v2 commands/routes _output_body shapes).
    @staticmethod
    def _output_body(
        uids: list[str], api_keys: list[str], period: str | None, *, include_period: bool
    ) -> dict:
        out: dict[str, Any] = {}
        if uids:
            out["uids"] = uids
        if api_keys:
            out["apiKeys"] = api_keys
        if include_period and period is not None:
            out["period"] = period
        return out

    async def output_activate(self, instance_id: str, uids, api_keys, period) -> Any:
        return await self._invoke(
            instance_id, "output.activate",
            self._output_body(uids, api_keys, period, include_period=True),
        )

    async def output_activate_continuous(self, instance_id: str, uids, api_keys) -> Any:
        return await self._invoke(
            instance_id, "output.activate_continuous",
            self._output_body(uids, api_keys, None, include_period=False),
        )

    async def output_deactivate(self, instance_id: str, uids, api_keys) -> Any:
        return await self._invoke(
            instance_id, "output.deactivate",
            self._output_body(uids, api_keys, None, include_period=False),
        )

    async def output_return_to_normal(self, instance_id: str, uids, api_keys) -> Any:
        return await self._invoke(
            instance_id, "output.return_to_normal",
            self._output_body(uids, api_keys, None, include_period=False),
        )

    async def output_open_all_doors(self, instance_id: str) -> Any:
        return await self._invoke(instance_id, "output.open_all_doors", {})

    async def output_return_to_normal_all(self, instance_id: str) -> Any:
        return await self._invoke(instance_id, "output.return_to_normal_all", {})

    # Alarm zones (v2 arm/disarm/return-to-schedule shapes).
    async def alarm_zone_arm(
        self, instance_id: str, dds_uid: str, arm_type, period, is_minute
    ) -> Any:
        payload: dict[str, Any] = {"uid": dds_uid, "armType": arm_type or "ArmConstant"}
        if period is not None:
            payload["period"] = period
        if is_minute is not None:
            payload["isMinute"] = "true" if is_minute else "false"
        return await self._invoke(instance_id, "alarm_zone.arm", payload)

    async def alarm_zone_disarm(
        self, instance_id: str, dds_uid: str, disarm_type, period, is_minute
    ) -> Any:
        payload: dict[str, Any] = {
            "uid": dds_uid,
            "disarmType": disarm_type or "DisarmConstant",
        }
        if period is not None:
            payload["period"] = period
        if is_minute is not None:
            payload["isMinute"] = "true" if is_minute else "false"
        return await self._invoke(instance_id, "alarm_zone.disarm", payload)

    async def alarm_zone_return_to_schedule(self, instance_id: str, dds_uid: str) -> Any:
        return await self._invoke(
            instance_id, "alarm_zone.return_to_schedule", {"uid": dds_uid}
        )

    # Controllers + sites.
    async def controller_initialize(self, instance_id: str, dds_uid: str) -> Any:
        return await self._invoke(
            instance_id, "controller.initialize", {"uid": dds_uid}
        )

    async def site_start_polling(self, instance_id: str, dds_uid: str) -> Any:
        return await self._invoke(instance_id, "site.start_polling", {"uid": dds_uid})

    async def site_stop_polling(self, instance_id: str, dds_uid: str) -> Any:
        return await self._invoke(instance_id, "site.stop_polling", {"uid": dds_uid})

    # ── Hardware proxy (read-only OData passthrough) ────────────────────
    async def list_hardware(
        self, instance_id: str, hardware_set: str, *, skip: int, limit: int
    ) -> dict:
        inst = await self._instance(instance_id)
        connector = get_connector(inst, secret=decrypt_secret(inst.secret_enc))
        try:
            items = await connector.list_hardware(hardware_set)
        except DDSHTTPError as exc:
            raise CommandError(exc.status_code, exc.body_text) from None
        except ValueError as exc:
            raise CommandError(404, {"message": str(exc)}) from None
        except Exception as exc:  # noqa: BLE001 — never 500 on a dead controller
            raise CommandError(502, {"message": str(exc) or type(exc).__name__}) from None
        finally:
            await connector.aclose()
        window = items[skip : skip + limit]
        normalized = [_normalize(i) for i in window]
        return {"items": normalized, "count": len(normalized)}
