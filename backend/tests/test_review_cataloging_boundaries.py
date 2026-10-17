"""Regression tests for review permissions, target scope and terminal state."""
import asyncio

import pytest
from pydantic import ValidationError

from app.database.models import CatalogingCandidate, ChapterSummary, Character, OutlineNode
from app.schemas.cataloging import CatalogingCandidateBulkUpdate, CatalogingCandidateUpdate
from app.services.cataloging.candidate_review import update_candidate_review
from app.services.cataloging.candidate_store import create_candidate_from_raw
from app.services.cataloging.context import ordered_chapters
from app.services.cataloging.job_control import cancel_job, mark_run_skipped
from app.services.cataloging.manual_ops import (
    apply_pending_cataloging_run,
    recover_failed_run_for_review,
)
from app.services.workspace.tools.cataloging import update_cataloging_candidate
from app.services.workspace.tools.outline import update_outline_node
from tests.test_cataloging_plan import plan_rows

pytest_plugins = ["tests.test_cataloging_plan"]


def stage(db, job, run):
    job.status = "waiting_confirmation"
    run.status = "awaiting_confirmation"
    for i, raw in enumerate(plan_rows()):
        result = create_candidate_from_raw(db, job, run, raw, i, source_task="regression")
        assert not result.get("error"), result
    db.commit()
    return db.query(CatalogingCandidate).filter_by(item_type="chapter_summary").one()


def test_review_cannot_claim_application_and_real_application_writes_summary(archive):
    db, job, run = archive
    candidate = stage(db, job, run)
    for status in ("applying", "applied", "apply_failed"):
        with pytest.raises(ValidationError):
            CatalogingCandidateUpdate(status=status)
        with pytest.raises(ValidationError):
            CatalogingCandidateBulkUpdate(candidate_ids=[candidate.id], status=status)
        result = asyncio.run(update_cataloging_candidate(db, "p", {"candidate_id": candidate.id, "status": status}))
        assert result["status"] != "ok"
        assert candidate.status == "pending"
    apply_pending_cataloging_run(db, job)
    assert job.status == "completed"
    assert db.query(ChapterSummary).count() == 1
    with pytest.raises(ValueError, match="不能修改"):
        update_candidate_review(db, candidate, {"summary_text": "rewritten"}, "pending")


def test_forged_applied_candidate_does_not_complete(archive):
    db, job, run = archive
    candidate = stage(db, job, run)
    candidate.status = "applied"
    db.commit()
    with pytest.raises(ValueError, match="缺少正式写入记录"):
        apply_pending_cataloging_run(db, job)
    assert job.status != "completed"
    assert db.query(ChapterSummary).count() == 0


@pytest.mark.parametrize("command", [mark_run_skipped, recover_failed_run_for_review])
def test_cancelled_job_rejects_late_review_controls(archive, command):
    db, job, run = archive
    run.status = "failed"
    job.status = "paused_on_failure"
    cancel_job(job)
    db.commit()
    with pytest.raises(ValueError, match="任务已结束"):
        command(db, job, run)
    assert job.status == "cancelled"
    assert run.status == "failed"


def test_invalid_selection_cannot_expand_to_all_chapters(archive):
    db, _, _ = archive
    for ids in (["missing"], ["c", "foreign-chapter"]):
        with pytest.raises(ValueError, match="不属于当前作品"):
            ordered_chapters(db, "p", ids)
    assert [c.id for c in ordered_chapters(db, "p", ["c", "c"])] == ["c"]


def test_outline_tool_saves_real_character_ids_and_rejects_foreign_ids(archive):
    db, _, _ = archive
    db.add(Character(id="person", project_id="p", name="甲"))
    db.add(OutlineNode(id="outline", project_id="p", title="章", node_type="chapter"))
    db.commit()
    result = asyncio.run(update_outline_node(db, "p", {"id": "outline", "character_ids": ["person"]}))
    assert result["status"] == "ok"
    node = db.get(OutlineNode, "outline")
    assert [link.character_id for link in node.linked_characters] == ["person"]
    from app.core.exceptions import ValidationError as BusinessValidationError
    with pytest.raises(BusinessValidationError):
        asyncio.run(update_outline_node(db, "p", {"id": "outline", "character_ids": ["foreign"]}))
