"""Platform-admin API — super-admin management of the platform-default rows
(settings + branding the tenant fallback layer uses) plus a cross-tenant audit view.

All endpoints are gated by ``require_superadmin`` and mounted always-on under the
app's api_prefix (``{api_prefix}/admin/platform/...`` and ``{api_prefix}/admin/audit``).
"""

from .router import router

__all__ = ["router"]
