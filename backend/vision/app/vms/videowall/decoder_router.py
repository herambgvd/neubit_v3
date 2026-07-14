"""Video-decoder router — hardware decoder CRUD + test (VW-B).

Mounted under the ``/vms`` domain prefix so paths are ``/api/v1/vms/decoders/...``
(gateway-routed via the existing vision prefix — no routes.yml change). Every endpoint is
gated by ``vms.wall.manage`` (decoders are wall configuration) and runs inside the caller's
tenant scope. ``POST /decoders/{id}/test`` runs a live ``probe()`` of the appliance.

The wall service (``push_cell`` / ``clear_cell`` / ``apply_preset``) uses the decoder
catalog to push a camera's RTSP to a ``kind='decoder'`` monitor's channel over the brand
SDK — that hook lives in ``service.py``; this router is the config surface.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db

from .decoder_schemas import (
    DecoderCreate,
    DecoderListResponse,
    DecoderPublic,
    DecoderTestResult,
    DecoderUpdate,
)
from .decoder_service import VideoDecoderService

# Decoder CRUD is wall configuration → the manage tier.
PERM_MANAGE = "vms.wall.manage"

router = APIRouter(prefix="/vms", tags=["VMS Video Wall Decoders"])


async def get_decoder_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> VideoDecoderService:
    return VideoDecoderService(db, scope)


@router.get(
    "/decoders",
    response_model=DecoderListResponse,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def list_decoders(
    svc: Annotated[VideoDecoderService, Depends(get_decoder_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
) -> DecoderListResponse:
    return await svc.list(skip=skip, limit=limit)


@router.post("/decoders", response_model=DecoderPublic, status_code=status.HTTP_201_CREATED)
async def create_decoder(
    body: DecoderCreate,
    svc: Annotated[VideoDecoderService, Depends(get_decoder_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> DecoderPublic:
    return await svc.create(body, actor=actor)


@router.get(
    "/decoders/{decoder_id}",
    response_model=DecoderPublic,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def get_decoder(
    decoder_id: str,
    svc: Annotated[VideoDecoderService, Depends(get_decoder_service)],
) -> DecoderPublic:
    return await svc.get(decoder_id)


@router.patch("/decoders/{decoder_id}", response_model=DecoderPublic)
async def update_decoder(
    decoder_id: str,
    body: DecoderUpdate,
    svc: Annotated[VideoDecoderService, Depends(get_decoder_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> DecoderPublic:
    return await svc.update(decoder_id, body, actor=actor)


@router.delete("/decoders/{decoder_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_decoder(
    decoder_id: str,
    svc: Annotated[VideoDecoderService, Depends(get_decoder_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete(decoder_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/decoders/{decoder_id}/test",
    response_model=DecoderTestResult,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def test_decoder(
    decoder_id: str,
    svc: Annotated[VideoDecoderService, Depends(get_decoder_service)],
) -> DecoderTestResult:
    return await svc.test(decoder_id)
