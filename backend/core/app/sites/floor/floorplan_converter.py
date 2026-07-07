"""Floor-plan conversion — DXF/PDF/image uploads → web-renderable PNG/SVG.

Ported from neubit_v2. Supported inputs:
  - PDF   → first page rendered to PNG  (pdf2image / poppler-utils)
  - DXF   → SVG                          (ezdxf + matplotlib)
  - DWF   → not supported (export DXF/PDF instead)
  - PNG/JPG/SVG/WEBP/GIF → passed through unchanged

All heavy dependencies (pdf2image, ezdxf, matplotlib, PIL) are imported LAZILY
inside the convert functions so importing this module — and booting the core —
never requires them. If a needed dependency is absent at convert time, a
``ValueError`` is raised; the route turns that into a clear 422.

Storage path convention (tenant-namespaced): ``{tenant}/floors/{site_id}/{uuid}{ext}``
where ``{tenant}`` is the caller's tenant id (or ``platform`` for super-admin).

Optional deps (pyproject ``[sites]`` extra): pdf2image, ezdxf, matplotlib, Pillow.
System dep: poppler-utils (for pdf2image).
"""

from __future__ import annotations

import logging
import os
import uuid
from dataclasses import dataclass

logger = logging.getLogger(__name__)

CONVERTIBLE_TYPES: dict[str, str] = {
    "application/pdf": "pdf",
    "application/x-dxf": "dxf",
    "image/vnd.dxf": "dxf",
    "application/dwf": "dwf",
    "application/x-dwf": "dwf",
}

PASSTHROUGH_TYPES: set[str] = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/svg+xml",
    "image/webp",
    "image/gif",
}

ALL_ALLOWED_TYPES: set[str] = set(CONVERTIBLE_TYPES.keys()) | PASSTHROUGH_TYPES

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB


def is_supported_format(content_type: str | None) -> bool:
    return content_type in ALL_ALLOWED_TYPES


def _storage_path(namespace: str, site_id: str, ext: str) -> str:
    """Tenant-namespaced key: ``{namespace}/floors/{site_id}/{uuid}{ext}``."""
    return f"{namespace}/floors/{site_id}/{uuid.uuid4().hex}{ext}"


@dataclass
class ConvertedFloorplan:
    original_filename: str
    original_type: str
    storage_path: str
    converted_type: str
    converted_content: bytes
    pages: int


async def convert_floorplan(
    content: bytes,
    content_type: str,
    filename: str,
    *,
    namespace: str,
    site_id: str,
) -> ConvertedFloorplan:
    if content_type in PASSTHROUGH_TYPES:
        ext = _get_extension(filename, content_type)
        return ConvertedFloorplan(
            original_filename=filename,
            original_type=content_type,
            storage_path=_storage_path(namespace, site_id, ext),
            converted_type=content_type,
            converted_content=content,
            pages=1,
        )

    fmt = CONVERTIBLE_TYPES.get(content_type)
    if fmt == "pdf":
        return await _convert_pdf(content, filename, namespace, site_id)
    if fmt == "dxf":
        return await _convert_dxf(content, filename, namespace, site_id)
    if fmt == "dwf":
        raise ValueError(
            "DWF format has limited open-source support. "
            "Please export your floor plan as DXF or PDF for best results."
        )
    raise ValueError(f"Unsupported file type: {content_type}")


async def _convert_pdf(
    content: bytes, filename: str, namespace: str, site_id: str
) -> ConvertedFloorplan:
    try:
        import io

        from pdf2image import convert_from_bytes  # type: ignore  # lazy heavy dep

        images = convert_from_bytes(content, dpi=200, first_page=1, last_page=1)
        if not images:
            raise ValueError("PDF has no pages")

        buf = io.BytesIO()
        images[0].save(buf, format="PNG", optimize=True)
        png_bytes = buf.getvalue()

        return ConvertedFloorplan(
            original_filename=filename,
            original_type="application/pdf",
            storage_path=_storage_path(namespace, site_id, ".png"),
            converted_type="image/png",
            converted_content=png_bytes,
            pages=len(images),
        )
    except ImportError as exc:
        logger.error("pdf2image not installed: %s", exc)
        raise ValueError(
            "PDF conversion not available — pdf2image (and poppler-utils) required"
        ) from exc
    except ValueError:
        raise
    except Exception as exc:
        logger.error("PDF conversion failed: %s", exc)
        raise ValueError(f"PDF conversion failed: {exc}") from exc


async def _convert_dxf(
    content: bytes, filename: str, namespace: str, site_id: str
) -> ConvertedFloorplan:
    try:
        import io

        import ezdxf  # type: ignore  # lazy heavy dep
        from ezdxf.addons.drawing import matplotlib as ezdxf_matplotlib  # type: ignore

        doc = ezdxf.read(io.BytesIO(content))
        msp = doc.modelspace()

        fig = ezdxf_matplotlib.qfigure(msp)
        buf = io.BytesIO()
        fig.savefig(buf, format="svg", bbox_inches="tight", pad_inches=0.1)
        svg_bytes = buf.getvalue()

        import matplotlib.pyplot as plt  # type: ignore

        plt.close(fig)

        return ConvertedFloorplan(
            original_filename=filename,
            original_type="application/x-dxf",
            storage_path=_storage_path(namespace, site_id, ".svg"),
            converted_type="image/svg+xml",
            converted_content=svg_bytes,
            pages=1,
        )
    except ImportError as exc:
        logger.error("ezdxf not installed: %s", exc)
        raise ValueError(
            "DXF conversion not available — ezdxf + matplotlib required"
        ) from exc
    except Exception as exc:
        logger.error("DXF conversion failed: %s", exc)
        raise ValueError(f"DXF conversion failed: {exc}") from exc


def _get_extension(filename: str, content_type: str) -> str:
    if filename:
        _, ext = os.path.splitext(filename)
        if ext:
            return ext.lower()
    type_map = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/svg+xml": ".svg",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "application/pdf": ".pdf",
    }
    return type_map.get(content_type, ".bin")
