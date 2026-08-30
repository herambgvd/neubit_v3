"""Dashboard + widget persistence — the builder's store.

Deliberately narrow: it stores WHAT a widget is, never what it means. The spec a
widget carries is executed by the reading-writer, which owns the readings schema
(contract §7). See `models` for why that split is the design.
"""

from .router import router as dashboards_router

__all__ = ["dashboards_router"]
