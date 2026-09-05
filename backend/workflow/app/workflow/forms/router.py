"""Dynamic-form REST API."""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db
from . import schemas as S
from .service import FormService


async def _form_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return FormService(db, scope)


# ── Form router ────────────────────────────────────────────────────────

form_router = APIRouter(prefix="/workflow/forms", tags=["Workflow · Forms"])


@form_router.get("", response_model=list[S.FormPublic],
                 dependencies=[Depends(require_permission("workflow.form.read"))])
async def list_forms(svc: Annotated[FormService, Depends(_form_svc)],
                     skip: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200),
                     is_active: Optional[bool] = Query(None)):
    items, _ = await svc.list_(skip=skip, limit=limit, is_active=is_active)
    return [S.FormPublic.from_row(r) for r in items]


@form_router.post("", response_model=S.FormPublic, status_code=status.HTTP_201_CREATED)
async def create_form(body: S.CreateFormRequest, svc: Annotated[FormService, Depends(_form_svc)],
                      actor: Principal = Depends(require_permission("workflow.form.create"))):
    return S.FormPublic.from_row(await svc.create(body, actor=actor))


@form_router.get("/{form_id}", response_model=S.FormPublic,
                 dependencies=[Depends(require_permission("workflow.form.read"))])
async def get_form(form_id: str, svc: Annotated[FormService, Depends(_form_svc)]):
    return S.FormPublic.from_row(await svc.get(form_id))


@form_router.patch("/{form_id}", response_model=S.FormPublic)
async def update_form(form_id: str, body: S.UpdateFormRequest, svc: Annotated[FormService, Depends(_form_svc)],
                      actor: Principal = Depends(require_permission("workflow.form.update"))):
    return S.FormPublic.from_row(await svc.update(form_id, body, actor=actor))


@form_router.delete("/{form_id}", status_code=status.HTTP_204_NO_CONTENT,
                    dependencies=[Depends(require_permission("workflow.form.delete"))])
async def delete_form(form_id: str, svc: Annotated[FormService, Depends(_form_svc)]):
    await svc.delete(form_id)


