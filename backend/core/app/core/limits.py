"""License limit enforcement primitives — the checks every scenario reuses.

A verified :class:`~edge.core.license.License` carries caps like
``{"cameras": 30, "storage_gb": 500}``. "Count the rows, compare to the limit,
raise the right error" lives here once so every scenario fails the same way.

  * Count limits — an integer cap on a named resource. ``License.limit(name)``
    returns the cap, or ``None`` for unlimited. See :func:`check_limit` /
    :func:`remaining`.
  * Storage cap — a float in GB on ``License.storage_gb``, ``None`` for unlimited.
    See :func:`storage_within_cap` / :func:`require_storage_capacity`.

    async def create_camera(db, license, payload):
        check_limit(license, "cameras", await count_cameras(db))   # before insert
        db.add(Camera(**payload))
        await db.commit()

All failures raise :class:`~edge.core.errors.LicenseLimitError` (HTTP 409) with
structured ``details`` the frontend can act on.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .errors import LicenseLimitError

if TYPE_CHECKING:  # avoid a runtime import cycle; only needed for type hints.
    from .license import License


def check_limit(license: "License", resource: str, current_count: int) -> None:
    """Raise if creating one more ``resource`` would breach the license cap.

    Call before inserting the new row. ``current_count`` is how many already exist.
    A ``None`` limit is unlimited and never raises.

    Raises:
        LicenseLimitError: when the resource cap is set and already reached.
    """
    limit = license.limit(resource)
    # None == unlimited (dev license, or the claim is absent).
    if limit is None:
        return
    if current_count >= limit:
        raise LicenseLimitError(
            f"{resource} limit reached ({limit})",
            details={"limit": limit, "resource": resource},
        )


def remaining(license: "License", resource: str, current_count: int) -> int | None:
    """How many more of ``resource`` may be created, or ``None`` if unlimited.

    For dashboard badges ("4 cameras left"). Clamped at 0, never negative.
    """
    limit = license.limit(resource)
    if limit is None:
        return None
    # Clamp so an over-provisioned deployment reports 0, not a negative.
    return max(limit - current_count, 0)


def storage_within_cap(license: "License", used_gb: float) -> bool:
    """True if current storage usage is under the license's storage cap.

    ``None`` is unlimited. Otherwise within cap means strictly less than the cap,
    so there is room for at least a little more.
    """
    cap = license.storage_gb
    if cap is None:
        return True
    return used_gb < cap


def require_storage_capacity(license: "License", used_gb: float) -> None:
    """Raise unless there is storage headroom under the license cap.

    The imperative counterpart to :func:`storage_within_cap`. Call it right before
    persisting a new blob.

    Raises:
        LicenseLimitError: when ``storage_gb`` is set and usage has reached it.
    """
    if not storage_within_cap(license, used_gb):
        cap = license.storage_gb
        raise LicenseLimitError(
            f"storage limit reached ({cap} GB)",
            details={"limit": cap, "resource": "storage_gb", "used_gb": used_gb},
        )
