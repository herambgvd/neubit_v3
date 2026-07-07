# device (Python)

Canonical device master registry (any device: camera/NVR/door/panel/sensor).

Control-plane service on the `edge` core. REST behind Traefik; cross-domain via NATS events.
Owns its tables in the per-tenant DB. See ../../docs/SERVICES.md.
