"""Context builders for per-chapter cataloging."""
from __future__ import annotations


from sqlalchemy.orm import Session

from ...database.models import Chapter


def ordered_chapters(db: Session, project_id: str, chapter_ids: list[str] | None = None) -> list[Chapter]:
    query = db.query(Chapter).filter(Chapter.project_id == project_id)
    chapters = query.order_by(
        Chapter.sort_order.asc(),
        Chapter.created_at.asc(),
        Chapter.id.asc(),
    ).all()
    by_id = {chapter.id: chapter for chapter in chapters}
    if chapter_ids:
        if any(item not in by_id for item in chapter_ids):
            raise ValueError("所选章节不存在或不属于当前作品")
        return [by_id[item] for item in dict.fromkeys(chapter_ids)]
    return chapters
