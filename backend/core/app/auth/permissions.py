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
    # The WRITE key of the Building Intelligence API, and separate from bi.read
    # on purpose: reading the estate and making a statement ABOUT it are
    # different jobs. Two things use it and they are the same kind of decision —
    # RETIRING a point (what is part of the estate) and PLACING a device in a
    # site / floor / zone (where that part of it is). Neither ever touches a
    # measurement: both write a dimension row and nothing else.
    BI_MANAGE = "bi.manage"
    # DashForge embeds — the dashboards NeuBit SHOWS but does not build. DashForge
    # is the single dashboarding surface; this platform registers which of its
    # dashboards appear here and renders them.
    #
    # `dashboards.read` / `dashboards.manage` stood here until 2026-09-03, gating
    # NeuBit's own builder. Both went with it. A key kept in this catalog after
    # its enforcer is deleted is worse than no key: the role editor keeps offering
    # it, an admin grants it believing it restricts something, and it restricts
    # nothing. See the note in 0021_drop_dashboards_permissions for what happens
    # to a role that already held one.
    #
    # DASHFORGE_READ is load-bearing in a way `dashboards.read` never was.
    # DashForge's `/public/embed/:token` is UNAUTHENTICATED — the token IS the
    # credential — so the only check standing in front of that data is the one
    # NeuBit makes before minting a token
    # (`backend/core/app/dashforge/router.py`). A caller without this key never
    # gets a token and therefore never gets the data.
    # MANAGE decides which dashboards are registered here at all, which is why it
    # is separate: being allowed to LOOK at an embedded dashboard must not imply
    # being allowed to point the console at a different one.
    DASHFORGE_READ = "dashforge.read"
    DASHFORGE_MANAGE = "dashforge.manage"
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
    # --- Access control (doors, cardholders, credentials) ------------------
    # Enforced by the `access` service (`backend/access/app/access/router.py`) at
    # 12 route sites, and MISSING from this catalog until now — so no role could
    # grant them and only a wildcard Administrator could reach access control at
    # all. That is the same failure the Ingest note above records, and this is the
    # eleventh time it recurred; `tests/test_permission_catalog.py` now walks every
    # `require_permission` literal in the repo and fails on a key that is not here,
    # so it cannot recur a twelfth.
    ACCESS_READ = "access.read"
    ACCESS_MANAGE = "access.manage"
    # --- Workflow (SOPs, triggers, incidents, forms, notifications) --------
    # Enforced by the `workflow` service across 21 distinct keys. Same story.
    WORKFLOW_SOP_READ = "workflow.sop.read"
    WORKFLOW_SOP_CREATE = "workflow.sop.create"
    WORKFLOW_SOP_UPDATE = "workflow.sop.update"
    WORKFLOW_SOP_DELETE = "workflow.sop.delete"
    WORKFLOW_TRIGGER_READ = "workflow.trigger.read"
    WORKFLOW_TRIGGER_CREATE = "workflow.trigger.create"
    WORKFLOW_TRIGGER_UPDATE = "workflow.trigger.update"
    WORKFLOW_TRIGGER_DELETE = "workflow.trigger.delete"
    WORKFLOW_INSTANCE_READ = "workflow.instance.read"
    WORKFLOW_INSTANCE_CREATE = "workflow.instance.create"
    WORKFLOW_INSTANCE_UPDATE = "workflow.instance.update"
    WORKFLOW_FORM_READ = "workflow.form.read"
    WORKFLOW_FORM_CREATE = "workflow.form.create"
    WORKFLOW_FORM_UPDATE = "workflow.form.update"
    WORKFLOW_FORM_DELETE = "workflow.form.delete"
    WORKFLOW_NOTIFICATION_READ = "workflow.notification.read"
    WORKFLOW_NOTIFICATION_CREATE = "workflow.notification.create"
    WORKFLOW_NOTIFICATION_UPDATE = "workflow.notification.update"
    WORKFLOW_NOTIFICATION_DELETE = "workflow.notification.delete"
    WORKFLOW_THREAT_LEVEL_READ = "workflow.threat_level.read"
    WORKFLOW_THREAT_LEVEL_UPDATE = "workflow.threat_level.update"
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
        CorePerm.BI_MANAGE,
        "Manage the measurement estate (place and retire)",
        "Building Intelligence",
        "Place a device in a site, floor or zone so its readings can answer a "
        "floor-wise question, and retire a point that is no longer part of the "
        "estate. Both write a dimension row; neither deletes a reading. Placing "
        "also needs sites.read / floors.read to choose the place.",
    ),
    Permission(
        CorePerm.DASHFORGE_READ,
        "View DashForge dashboards",
        "Dashboards",
        "Open the DashForge dashboards registered on this platform. Holding this "
        "is what mints the short-lived embed token a viewer needs; without it no "
        "token is ever created, so the dashboard's data is unreachable.",
    ),
    Permission(
        CorePerm.DASHFORGE_MANAGE,
        "Register / remove DashForge dashboards",
        "Dashboards",
        "Choose which DashForge dashboards this platform shows, name them, and "
        "set the filter values locked into their embed tokens. Authoring the "
        "dashboards themselves happens in DashForge.",
    ),
    # --- Ingest ------------------------------------------------------------
    Permission(CorePerm.INGEST_READ, "View ingest categories / webhooks / events", "Ingest"),
    Permission(CorePerm.INGEST_MANAGE, "Create / edit ingest webhooks + rules", "Ingest"),
    # --- Enterprise security ----------------------------------------------
    Permission(CorePerm.SECURITY_MANAGE, "Manage 2FA policy / LDAP / SSO", "Security"),
    Permission(CorePerm.DUALAUTH_APPROVE, "Approve four-eyes requests", "Security"),
    # --- Access control ----------------------------------------------------
    Permission(
        CorePerm.ACCESS_READ,
        "View doors, cardholders and access events",
        "Access control",
        "Read the access-control estate served by the access service — the "
        "integration layer in front of DDS, IDCube, Spectra and the rest.",
    ),
    Permission(
        CorePerm.ACCESS_MANAGE,
        "Configure access control",
        "Access control",
        "Register controllers, map doors, and issue or revoke cardholder "
        "credentials. Separate from access.read because opening a door and "
        "deciding who may open it are different jobs.",
    ),
    # --- Workflow ----------------------------------------------------------
    Permission(CorePerm.WORKFLOW_SOP_READ, "View SOPs", "Workflow"),
    Permission(CorePerm.WORKFLOW_SOP_CREATE, "Create SOPs", "Workflow"),
    Permission(CorePerm.WORKFLOW_SOP_UPDATE, "Edit SOPs", "Workflow"),
    Permission(CorePerm.WORKFLOW_SOP_DELETE, "Delete SOPs", "Workflow"),
    Permission(CorePerm.WORKFLOW_TRIGGER_READ, "View triggers", "Workflow"),
    Permission(CorePerm.WORKFLOW_TRIGGER_CREATE, "Create triggers", "Workflow"),
    Permission(CorePerm.WORKFLOW_TRIGGER_UPDATE, "Edit triggers", "Workflow"),
    Permission(CorePerm.WORKFLOW_TRIGGER_DELETE, "Delete triggers", "Workflow"),
    Permission(CorePerm.WORKFLOW_INSTANCE_READ, "View incidents", "Workflow"),
    Permission(CorePerm.WORKFLOW_INSTANCE_CREATE, "Raise incidents", "Workflow"),
    Permission(
        CorePerm.WORKFLOW_INSTANCE_UPDATE,
        "Act on incidents",
        "Workflow",
        "Advance a running incident through its SOP: transition state, complete "
        "form steps, acknowledge and close.",
    ),
    Permission(CorePerm.WORKFLOW_FORM_READ, "View workflow forms", "Workflow"),
    Permission(CorePerm.WORKFLOW_FORM_CREATE, "Create workflow forms", "Workflow"),
    Permission(CorePerm.WORKFLOW_FORM_UPDATE, "Edit workflow forms", "Workflow"),
    Permission(CorePerm.WORKFLOW_FORM_DELETE, "Delete workflow forms", "Workflow"),
    Permission(CorePerm.WORKFLOW_NOTIFICATION_READ, "View notification config", "Workflow"),
    Permission(CorePerm.WORKFLOW_NOTIFICATION_CREATE, "Create notification config", "Workflow"),
    Permission(CorePerm.WORKFLOW_NOTIFICATION_UPDATE, "Edit notification config", "Workflow"),
    Permission(CorePerm.WORKFLOW_NOTIFICATION_DELETE, "Delete notification config", "Workflow"),
    Permission(CorePerm.WORKFLOW_THREAT_LEVEL_READ, "View site threat levels", "Workflow"),
    Permission(
        CorePerm.WORKFLOW_THREAT_LEVEL_UPDATE,
        "Change site threat level",
        "Workflow",
        "Raise or lower a site's threat posture. It changes which triggers fire, "
        "so it is a separate key from viewing it.",
    ),
    # --- Runtime permission registration -----------------------------------
    Permission(
        CorePerm.PERMISSION_REGISTER,
        "Register permission keys (service-to-service)",
        "System",
        "Lets a satellite service publish the permission keys it enforces into "
        "this catalog so a role can grant them.",
    ),
)
