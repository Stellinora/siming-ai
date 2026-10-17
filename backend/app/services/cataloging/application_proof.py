"""Verify application receipts before trusting an applied candidate."""
from sqlalchemy.orm import Session

from ...database.models import CatalogingApplyLog, CatalogingCandidate, ChapterSummary


def require_application_proof(db: Session, candidates: list[CatalogingCandidate]) -> None:
    for candidate in candidates:
        if candidate.status != "applied":
            continue
        receipt = db.query(CatalogingApplyLog).filter_by(
            candidate_id=candidate.id, chapter_run_id=candidate.chapter_run_id,
            job_id=candidate.job_id, target_id=candidate.target_id,
            target_type=candidate.target_type,
        ).first()
        if receipt is None:
            raise ValueError(f"候选 {candidate.id} 缺少正式写入记录，不能报告建档完成")
        if candidate.item_type == "chapter_summary":
            summary = db.query(ChapterSummary).filter_by(
                id=candidate.target_id, chapter_id=candidate.chapter_id,
            ).first()
            if summary is None:
                raise ValueError("正式章节摘要不存在，不能报告建档完成")
