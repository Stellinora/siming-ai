"""Local/owner recovery surface; paired clients use scoped authoring commands."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.architecture.uow import commit_session
from app.core.response import ApiResponse
from app.database.session import get_db
from app.services.recycle_bin import list_entries, purge_entry, restore_entry

router = APIRouter(prefix="/recycle-bin", tags=["recycle-bin"])
Database = Annotated[Session, Depends(get_db)]


@router.get("")
def list_recycle_bin(
    db: Database,
    project_id: str | None = None,
    entity_type: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    data = list_entries(
        db, project_id=project_id, entity_type=entity_type, limit=limit, offset=offset
    )
    commit_session(db)
    return ApiResponse.success(data=data)


@router.post("/{entry_id}/restore")
def restore_recycled_data(entry_id: str, db: Database):
    result = restore_entry(db, entry_id)
    commit_session(db)
    return ApiResponse.success(data=result, message="已恢复")


@router.delete("/{entry_id}")
def permanently_delete_recycled_data(entry_id: str, db: Database):
    purge_entry(db, entry_id)
    commit_session(db)
    return ApiResponse.success(message="已永久删除，无法恢复")
