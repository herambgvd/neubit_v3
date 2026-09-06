"""neubit core — the multi-tenant platform service.

Layout (what each package owns):
  core/           config, licensing, module registry, FastAPI factory, errors,
                  logging, pagination, ratelimit, metrics, storage, audit, realtime
  auth/           users, JWT, dynamic RBAC (roles + permissions), API keys
  tenancy/        the Tenant model, scoping, entitlements, erasure
  admin/          super-admin cross-tenant control plane
  platform_admin/ the platform-default settings/branding rows + cross-tenant audit
  billing/        subscription + invoice records
  licensing/      license status + runtime renewal
  settings/       admin-editable key/value config
  branding/       white-label logo + theme
  messaging/      email + FCM push + webhook + in-app + templates + dispatcher
  alerts/         super-admin alert inbox
  broadcasts/     platform-wide announcements
  sites/          physical hierarchy: site → floor → zone
  tags/           cross-cutting labels applied across modules
  device_brands/  catalog of supported device brands / SDKs
  module_catalog/ registry of toggleable features
  dashforge/      DashForge dashboard embeds
  search/         one ?q= endpoint across core entities
  reports/        CSV / XLSX / PDF export framework
  infra/          super-admin view/control of the compose stack
  security/       enterprise hardening
  system/         CPU/RAM/GPU/disk resources
  tasks/          Celery app + beat + retention cleanup
  db/             async SQLAlchemy base + TimescaleDB helpers
"""

__version__ = "0.1.0"
