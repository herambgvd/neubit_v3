"""The reading-writer's READ side — Building Intelligence's query API.

Contract §7 says the reading-writer owns the readings schema. A second service
reading `neubit_reporting` would be a cross-service read into someone else's
tables and a second place the schema can drift, so the read endpoints live HERE,
next to the only writer, and import the same `reporting.models`.

Everything in this package is SELECT-only. Nothing here writes.
"""

from .router import bi_router

__all__ = ["bi_router"]
