"""Device brands: the platform catalog of supported device brands / SDKs.

Read-mostly registry (prep for the devices phase). The super-admin curates the
catalog; other authenticated users read it when adding a device.
"""

from .models import DeviceBrand
from .router import router
from .service import DEFAULT_BRANDS, DeviceBrandService, seed_brands

__all__ = ["router", "DeviceBrand", "DeviceBrandService", "seed_brands", "DEFAULT_BRANDS"]
