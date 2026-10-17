"""Author/model review commands; application states belong to the applier."""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from ...database.models import CatalogingCandidate

REVIEW_STATUSES = frozenset({"pending", "edited", "approved", "rejected"})


def update_candidate_review(
    db: Session, candidate: CatalogingCandidate,
    payload: dict[str, Any] | None = None, status: str | None = None,
) -> None:
    if status is not None and status not in REVIEW_STATUSES:
        raise ValueError("候选审核状态只能是 pending、edited、approved 或 rejected")
    # The conditional update also serializes against an application transaction.
    changes: dict[str, Any] = {"updated_at": datetime.utcnow()}
    if payload is not None:
        changes["edited_payload"] = json.dumps(payload, ensure_ascii=False)
        changes["status"] = status or "edited"
    elif status is not None:
        changes["status"] = status
    count = db.query(CatalogingCandidate).filter(
        CatalogingCandidate.id == candidate.id,
        CatalogingCandidate.status.notin_(["applying", "applied"]),
    ).update(changes, synchronize_session="fetch")
    if count != 1:
        raise ValueError("候选项正在写入或已写入，不能修改")
