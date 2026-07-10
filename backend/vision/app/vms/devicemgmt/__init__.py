"""Device / fleet-management domain (G7).

Fleet ops on onboarded cameras via the multi-brand driver seam: reboot, device-info /
firmware read, config backup/restore, NTP set, and a bulk fan-out for password / NTP /
reboot across many cameras. No new tables — this is a thin service over
``app.vms.drivers`` (the ops live on ``CameraDriver``) + the tenant-scoped Camera rows.

Every op degrades gracefully per brand (``FleetOpResult`` carries ok/supported/detail);
the real on-device effect is ``# LIVE-VALIDATE`` (no live devices in dev).
"""
