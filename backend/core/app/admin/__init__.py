"""Super-admin API — cross-tenant control plane (create/list/update/delete tenants).

Mounted always-on under ``{api_prefix}/admin`` and gated end-to-end by
``require_superadmin``. Regular tenant users never reach it.
"""

from .router import router

__all__ = ["router"]
