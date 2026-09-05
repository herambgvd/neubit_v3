"""Ownership checks for a submitted field that NAMES ANOTHER ROW.

``assert_owned`` guards the row a request addresses by id. Nothing guarded the
rows a request POINTS AT. A trigger's ``sop_id`` arrives from the caller like any
other field, so a service that validates it in ``create`` and then runs
``setattr(row, k, v)`` over the update body has validated it on the one path that
is not the attack: PATCH is what a caller already holding a row of their own
reaches for.

The reference is therefore declared on the SERVICE CLASS instead of being checked
at a call site, and every write path runs the same declaration. Adding a column
that names another row is one line in ``REFERENCES``; forgetting to re-check it
on a new endpoint stops being possible without deleting that line.

Deliberately NOT a foreign key: these tables are cross-tenant by shape (a NULL
tenant_id row is platform-shared and legitimately referenced by everyone), so the
question is not "does the target exist" — which is all an FK answers — but "may
THIS caller see it", which only the scope knows.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from kernel.auth import assert_owned


class ChecksReferences:
    """Mixin for services whose rows carry ids of other tenant-owned rows.

    Hosts must hold ``self.db`` (AsyncSession) and ``self.scope`` (Scope).
    """

    #: field name → (ORM model, not-found message). The message is deliberately the
    #: one a genuinely absent id gets: a caller must not be able to tell "another
    #: tenant's SOP" from "no such SOP" — that is ``assert_owned``'s promise, and
    #: it is what stops an id being probed through a PATCH body.
    REFERENCES: dict[str, tuple[Any, str]] = {}

    async def _check_references(self, data: Mapping[str, Any]) -> None:
        """Raise NotFound if any declared reference in ``data`` is not the caller's.

        A field the body omits, or leaves None, is not a write and is not checked.
        """
        for field, (model, message) in self.REFERENCES.items():
            target_id = data.get(field)
            if target_id is None:
                continue
            assert_owned(await self.db.get(model, target_id), self.scope, message=message)
