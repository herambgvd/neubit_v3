"""Ownership checks for a submitted field that names another row.

``assert_owned`` guards the row a request addresses by id; this guards the rows a
request points at. Declaring the reference on the service class rather than at a
call site means every write path (create and PATCH alike) checks it.

Not a foreign key on purpose: a NULL-tenant row is platform-shared and
legitimately referenced by everyone, so the question is "may this caller see it",
which only the scope knows — not "does it exist".
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from kernel.auth import assert_owned


class ChecksReferences:
    """Mixin for services whose rows carry ids of other tenant-owned rows.

    Hosts must hold ``self.db`` (AsyncSession) and ``self.scope`` (Scope).
    """

    #: field name → (ORM model, not-found message). The message must be the one a
    #: genuinely absent id gets, so a caller cannot tell "another tenant's row"
    #: from "no such row".
    REFERENCES: dict[str, tuple[Any, str]] = {}

    async def _check_references(self, data: Mapping[str, Any]) -> None:
        """Raise NotFound if any declared reference in ``data`` is not the caller's.

        A field the body omits, or leaves None, is not a write and is not checked.
        """
        for field, (model, message) in self.REFERENCES.items():
            target_id = data.get(field)
            if target_id is None:
                continue
            # Shared-readable on purpose: this only asks whether the target
            # EXISTS and may be referenced. Nothing is written through it, so a
            # platform row being visible here is the shared catalog working.
            assert_owned(await self.db.get(model, target_id), self.scope, message=message)
