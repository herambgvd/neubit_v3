# core (Python)

platform core (edge) — identity/tenant/rbac/license/settings/messaging/reports/audit sites:sites/floors/zones/maps device:canonical device master registry workflow:SOP/automation engine + ingest webhooks vision:VMS control + third-party NVR estate gates:access control fire:fire panels octosense:IoT/sensors.

Control-plane service on the `edge` core. REST behind Traefik; cross-domain via NATS events.
Owns its tables in the per-tenant DB. See ../../docs/SERVICES.md.
