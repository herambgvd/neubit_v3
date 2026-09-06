"""Ingest domain — external webhook ingestion → normalized NATS events.

A tenant configures **categories** (groupings that name a target subject/domain)
and **webhooks** (a public receiver URL, its auth, a JSON-schema gate, a JMESPath
transform). Inbound requests hit ``POST /ingest/hooks/{slug}``, are authenticated
by the webhook's own auth rather than a platform JWT, validated and transformed,
then published as a normalized ``ingest.event.received`` envelope.

The authed config API is gated by ``ingest.*`` permissions and tenant-scoped like
every other v3 service.
"""
