# workflow (Python)

SOP/automation engine plus ingest (external webhooks / event ingestion).

Control-plane service on the `edge` core. REST behind Traefik; cross-domain via NATS events.
Owns its tables in the per-tenant DB. See ../../docs/SERVICES.md.
