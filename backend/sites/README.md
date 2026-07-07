# sites (Python)

Spatial/org hierarchy — sites, floors, zones, tags, maps.

Control-plane service on the `edge` core. REST behind Traefik; cross-domain via NATS events.
Owns its tables in the per-tenant DB. See ../../docs/SERVICES.md.
