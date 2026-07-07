"""Module catalog: the platform registry of toggleable features/modules.

The super-admin manages a global catalog of modules (vms, access, fire, …); the
keys become the keys of every tenant's ``features`` dict. Feature-gating a domain
route against a tenant's toggle lives in ``app.tenancy.features.require_feature``.
"""

from .models import Module
from .router import router
from .service import DEFAULT_MODULES, ModuleCatalogService, seed_modules

__all__ = ["router", "Module", "ModuleCatalogService", "seed_modules", "DEFAULT_MODULES"]
