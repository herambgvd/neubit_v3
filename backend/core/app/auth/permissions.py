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
    AUDIT_WRITE = "audit.write"
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
    # Video Wall (VW-A) — shared control-room display wall. VIEW = read walls /
    # monitors / live state / presets / tours; CONTROL = drive the live shared state
    # (push a camera to a cell, clear, apply/save preset, start/stop tour); MANAGE =
    # wall / monitor / preset / tour CRUD (+ decoder registration in VW-B).
    VMS_WALL_VIEW = "vms.wall.view"
    VMS_WALL_CONTROL = "vms.wall.control"
    VMS_WALL_MANAGE = "vms.wall.manage"
    # --- Building Intelligence --------------------------------------------
    # The IoT reading store's READ side, enforced by the reading-writer
    # (`backend/reading-writer/app/api/router.py`) — the schema's owner serves
    # its own reads (contract §7). Registered HERE, like the VMS keys above, so
    # a tenant admin can grant it in the role editor and it rides in the JWT
    # permissions claim. A key that is not in this catalog can only ever be held
    # by a wildcard admin, which is not a usable permission model.
    BI_READ = "bi.read"
    # Dashboard builder — the no-code dashboards over the reading store. READ =
    # list and open a dashboard; MANAGE = create / edit / delete / arrange it.
    # Enforced by the `dashboards` service
    # (`backend/dashboards/app/dashboards/router.py`). A widget's DATA is still
    # gated by `bi.read` on the reading-writer, so a user who can open a
    # dashboard but cannot read the store sees the canvas and empty widgets
    # rather than numbers they are not entitled to.
    DASHBOARDS_READ = "dashboards.read"
    DASHBOARDS_MANAGE = "dashboards.manage"
    # --- Ingest (external webhooks / event ingestion) ----------------------
    # Enforced by the ingest service (`backend/ingest/app/ingest/router.py`) and,
    # until now, MISSING from this catalog — so no role could grant them and only
    # a wildcard admin could reach Ingest at all. Registering a key here is not
    # book-keeping: it is what makes the permission grantable.
    INGEST_READ = "ingest.read"
    INGEST_MANAGE = "ingest.manage"
    # --- Enterprise security (P6-D) ---------------------------------------
    # Manage the security surface: 2FA-enforcement policy, LDAP/AD directory,
    # OIDC SSO. Held by a tenant's security admin.
    SECURITY_MANAGE = "security.manage"
    # Approve/deny a four-eyes (dual-authorization) request raised by someone
    # else. Deliberately SEPARATE from security.manage so the approver is a
    # distinct privileged role, not just whoever configures security.
    DUALAUTH_APPROVE = "dualauth.approve"
    # --- Runtime permission registration (service-to-service) --------------
    # Lets a satellite publish the permission keys IT enforces into this catalog
    # so a role can grant them. Needed because the dashboard builder's datasets
    # are registered as DATA (an INSERT into the reporting store) and each names
    # the permission required to read it — a key core cannot know at build time.
    # Held by a service token, never by an operator role.
    PERMISSION_REGISTER = "permission.register"


PERMISSIONS.register(
    Permission(CorePerm.USER_READ, "View users", "Users"),
    Permission(CorePerm.USER_MANAGE, "Create / edit users", "Users"),
    Permission(CorePerm.ROLE_READ, "View roles", "Roles"),
    Permission(CorePerm.ROLE_MANAGE, "Create / edit roles & permissions", "Roles"),
    Permission(CorePerm.APIKEY_MANAGE, "Manage API keys", "API keys"),
    Permission(CorePerm.AUDIT_READ, "View audit log", "Audit"),
    Permission(CorePerm.AUDIT_WRITE, "Ingest audit events (service-to-service)", "Audit"),
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
    Permission(CorePerm.VMS_WALL_VIEW, "View video walls + live state", "VMS"),
    Permission(CorePerm.VMS_WALL_CONTROL, "Drive video-wall live state (push / presets / tours)", "VMS"),
    Permission(CorePerm.VMS_WALL_MANAGE, "Create / edit video walls, monitors, presets, tours", "VMS"),
    # --- Building Intelligence ---------------------------------------------
    Permission(
        CorePerm.BI_READ,
        "View building intelligence (energy / HVAC / water readings)",
        "Building Intelligence",
        "Read the IoT reading store: category summaries, devices, points and "
        "time series. Read-only — nothing in this API writes.",
    ),
    Permission(
        CorePerm.DASHBOARDS_READ,
        "View dashboards",
        "Dashboards",
        "Open the dashboards built over the reading store. The widgets' data is "
        "gated separately by 'View building intelligence' (bi.read).",
    ),
    Permission(
        CorePerm.DASHBOARDS_MANAGE,
        "Build / edit dashboards",
        "Dashboards",
        "Create, rename and delete dashboards, add widgets and arrange the canvas.",
    ),
    # --- Ingest ------------------------------------------------------------
    Permission(CorePerm.INGEST_READ, "View ingest categories / webhooks / events", "Ingest"),
    Permission(CorePerm.INGEST_MANAGE, "Create / edit ingest webhooks + rules", "Ingest"),
    # --- Enterprise security ----------------------------------------------
    Permission(CorePerm.SECURITY_MANAGE, "Manage 2FA policy / LDAP / SSO", "Security"),
    Permission(CorePerm.DUALAUTH_APPROVE, "Approve four-eyes requests", "Security"),
    # --- Runtime permission registration -----------------------------------
    Permission(
        CorePerm.PERMISSION_REGISTER,
        "Register permission keys (service-to-service)",
        "System",
        "Lets a satellite service publish the permission keys it enforces into "
        "this catalog so a role can grant them.",
    ),
)
