"""Permission catalog — the atomic access rights the CODE enforces.

Design (industry-standard RBAC):
  * PERMISSIONS are a fixed catalog. Each is a key the code checks
    (``require_permission("user.manage")``). The system/feature-modules define
    them — a user can't invent one, because nothing would enforce it.
  * ROLES are user-defined (a name + a chosen subset of these permissions),
    stored in the DB and fully CRUD. See models.Role.
  * A user is assigned a role → their effective permissions = the role's set.

Feature modules add their own permissions at import time:

    from app.auth import PERMISSIONS, Permission
    PERMISSIONS.register(Permission("camera.create", "Add cameras", "Cameras"))

The ``*`` wildcard grants everything and is reserved for the built-in
Administrator role (not selectable when creating custom roles).
"""

from __future__ import annotations

import dataclasses

WILDCARD = "*"


@dataclasses.dataclass(frozen=True)
class Permission:
    key: str            # machine key the code checks, e.g. "user.manage"
    label: str          # human label for the role-editor UI
    group: str          # grouping bucket in the UI, e.g. "Users"
    description: str = ""


class PermissionRegistry:
    """Holds every permission the app knows about; the frontend reads it to
    render the role editor (grouped checkboxes)."""

    def __init__(self) -> None:
        self._perms: dict[str, Permission] = {}

    def register(self, *perms: Permission) -> "PermissionRegistry":
        for p in perms:
            self._perms[p.key] = p
        return self

    def all(self) -> list[Permission]:
        return list(self._perms.values())

    def keys(self) -> set[str]:
        return set(self._perms)

    def grouped(self) -> dict[str, list[dict]]:
        """{"Users": [{key,label,description}, ...], ...} for the role editor."""
        out: dict[str, list[dict]] = {}
        for p in self._perms.values():
            out.setdefault(p.group, []).append(
                {"key": p.key, "label": p.label, "description": p.description}
            )
        return out

    def unknown(self, perms) -> list[str]:
        """Return permission keys NOT in the catalog (wildcard excluded)."""
        known = self._perms.keys()
        return [p for p in perms if p != WILDCARD and p not in known]


# The single shared registry for the whole app.
PERMISSIONS = PermissionRegistry()


class CorePerm:
    """Permission keys the boilerplate itself enforces (referenced in routers)."""

    USER_READ = "user.read"
    USER_MANAGE = "user.manage"
    ROLE_READ = "role.read"
    ROLE_MANAGE = "role.manage"
    APIKEY_MANAGE = "apikey.manage"
    AUDIT_READ = "audit.read"
    BRANDING_MANAGE = "branding.manage"
    SETTINGS_MANAGE = "settings.manage"
    SYSTEM_READ = "system.read"
    REPORT_READ = "report.read"
    REPORT_EXPORT = "report.export"
    # --- Sites domain (site → floor → zone hierarchy) ----------------------
    SITES_READ = "sites.read"
    SITES_CREATE = "sites.create"
    SITES_UPDATE = "sites.update"
    SITES_DELETE = "sites.delete"
    FLOORS_READ = "floors.read"
    FLOORS_CREATE = "floors.create"
    FLOORS_UPDATE = "floors.update"
    FLOORS_DELETE = "floors.delete"
    ZONES_READ = "zones.read"
    ZONES_CREATE = "zones.create"
    ZONES_UPDATE = "zones.update"
    ZONES_DELETE = "zones.delete"
    # --- Device placement (devices plotted onto floor plans) ---------------
    DEVICES_READ = "devices.read"
    DEVICES_CREATE = "devices.create"
    DEVICES_UPDATE = "devices.update"
    DEVICES_DELETE = "devices.delete"
    # --- Tags domain (cross-cutting labels applied across modules) ---------
    TAGS_READ = "tags.read"
    TAGS_CREATE = "tags.create"
    TAGS_UPDATE = "tags.update"
    TAGS_DELETE = "tags.delete"
    # --- VMS domain (video: cameras/NVR/live/recording/playback) -----------
    # Owned by the `vms` (vision) service; registered here so roles can grant
    # them in the core role editor + they ride in the JWT permissions claim.
    VMS_CAMERA_READ = "vms.camera.read"
    VMS_CAMERA_MANAGE = "vms.camera.manage"
    VMS_NVR_MANAGE = "vms.nvr.manage"
    VMS_LIVE_VIEW = "vms.live.view"
    VMS_PLAYBACK_VIEW = "vms.playback.view"
    VMS_RECORDING_CONTROL = "vms.recording.control"
    VMS_EXPORT = "vms.export"
    VMS_PTZ_CONTROL = "vms.ptz.control"
    VMS_CONFIG_MANAGE = "vms.config.manage"


PERMISSIONS.register(
    Permission(CorePerm.USER_READ, "View users", "Users"),
    Permission(CorePerm.USER_MANAGE, "Create / edit users", "Users"),
    Permission(CorePerm.ROLE_READ, "View roles", "Roles"),
    Permission(CorePerm.ROLE_MANAGE, "Create / edit roles & permissions", "Roles"),
    Permission(CorePerm.APIKEY_MANAGE, "Manage API keys", "API keys"),
    Permission(CorePerm.AUDIT_READ, "View audit log", "Audit"),
    Permission(CorePerm.BRANDING_MANAGE, "Edit branding / white-label", "Branding"),
    Permission(CorePerm.SETTINGS_MANAGE, "Edit integration settings", "Settings"),
    Permission(CorePerm.SYSTEM_READ, "View system resources", "System"),
    Permission(CorePerm.REPORT_READ, "View reports", "Reports"),
    Permission(CorePerm.REPORT_EXPORT, "Export reports", "Reports"),
    # --- Sites domain ------------------------------------------------------
    Permission(CorePerm.SITES_READ, "View sites", "Sites"),
    Permission(CorePerm.SITES_CREATE, "Create sites", "Sites"),
    Permission(CorePerm.SITES_UPDATE, "Edit sites", "Sites"),
    Permission(CorePerm.SITES_DELETE, "Delete sites", "Sites"),
    Permission(CorePerm.FLOORS_READ, "View floors", "Sites"),
    Permission(CorePerm.FLOORS_CREATE, "Create floors", "Sites"),
    Permission(CorePerm.FLOORS_UPDATE, "Edit floors", "Sites"),
    Permission(CorePerm.FLOORS_DELETE, "Delete floors", "Sites"),
    Permission(CorePerm.ZONES_READ, "View zones", "Sites"),
    Permission(CorePerm.ZONES_CREATE, "Create zones", "Sites"),
    Permission(CorePerm.ZONES_UPDATE, "Edit zones", "Sites"),
    Permission(CorePerm.ZONES_DELETE, "Delete zones", "Sites"),
    # --- Device placement --------------------------------------------------
    Permission(CorePerm.DEVICES_READ, "View device placements", "Sites"),
    Permission(CorePerm.DEVICES_CREATE, "Place devices on floor plans", "Sites"),
    Permission(CorePerm.DEVICES_UPDATE, "Move / edit device placements", "Sites"),
    Permission(CorePerm.DEVICES_DELETE, "Remove device placements", "Sites"),
    # --- Tags domain -------------------------------------------------------
    Permission(CorePerm.TAGS_READ, "View tags", "Tags"),
    Permission(CorePerm.TAGS_CREATE, "Create tags", "Tags"),
    Permission(CorePerm.TAGS_UPDATE, "Edit / assign tags", "Tags"),
    Permission(CorePerm.TAGS_DELETE, "Delete tags", "Tags"),
    # --- VMS domain (video) ------------------------------------------------
    Permission(CorePerm.VMS_CAMERA_READ, "View cameras + live", "VMS"),
    Permission(CorePerm.VMS_CAMERA_MANAGE, "Add / edit / delete cameras", "VMS"),
    Permission(CorePerm.VMS_NVR_MANAGE, "Onboard / manage NVRs", "VMS"),
    Permission(CorePerm.VMS_LIVE_VIEW, "View live video", "VMS"),
    Permission(CorePerm.VMS_PLAYBACK_VIEW, "View recorded playback", "VMS"),
    Permission(CorePerm.VMS_RECORDING_CONTROL, "Start / stop / configure recording", "VMS"),
    Permission(CorePerm.VMS_EXPORT, "Export video / clips", "VMS"),
    Permission(CorePerm.VMS_PTZ_CONTROL, "Control PTZ", "VMS"),
    Permission(CorePerm.VMS_CONFIG_MANAGE, "Edit camera config", "VMS"),
)
