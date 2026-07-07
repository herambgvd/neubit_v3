# octosense (Python)

IoT/sensors — telemetry, thresholds, alarms.

Control-plane service on the `edge` core. REST behind Traefik; cross-domain via NATS events.
Owns its tables in the per-tenant DB. See ../../docs/SERVICES.md.
