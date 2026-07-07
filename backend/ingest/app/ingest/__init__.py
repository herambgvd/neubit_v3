"""Ingest domain — external webhook ingestion → normalized NATS events.

A tenant configures **categories** (logical groupings that name a target
subject/domain) and **webhooks** (a public receiver URL, its per-webhook auth,
a JSON-schema gate, and a JMESPath transform). Inbound requests hit the PUBLIC
receiver ``POST /ingest/hooks/{token}``, are authenticated by the webhook's own
auth (no platform JWT), validated + transformed, then published to the NATS
event spine as a normalized ``ingest.event.received`` envelope for the tenant.

The authed config API (category + webhook CRUD) is gated by ``ingest.*``
permissions and tenant-scoped like every other v3 service.
"""
