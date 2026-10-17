"""Mixed write batches are atomic denials, recoverable by the same model only."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database.models import (
    Base,
    CatalogingCandidate,
    CatalogingChapterRun,
    CatalogingJob,
    Chapter,
    ChapterSummary,
    OperationEvent,
    Project,
)
from app.services.cataloging import orchestrator
from app.services.workspace.assistant_native_turn import WorkspaceNativeTurn
from app.services.workspace.native_tool_batch import (
    NativeToolBatchCatalogingMixed,
    NativeToolBatchNotOpen,
    NativeToolBatchRecoverable,
    NativeToolBatchValidationError,
    validate_workspace_native_tool_batch,
)
from app.services.workspace.registry import registry
from tests.test_cataloging_plan import archive, plan_rows, submit  # noqa: F401

SAVE = "save_external_cataloging_candidates"
READ = "read_cataloging_archive"
MIXED = "cataloging_tool_must_be_only_call"


def native_call(name, args, call_id):
    return {"id": call_id, "type": "function", "function": {
        "name": name, "arguments": json.dumps(args, ensure_ascii=False),
    }}


def validate(calls):
    return validate_workspace_native_tool_batch(
        calls, allowed_tool_names={SAVE, READ}, resolve_tool=registry.get,
        require_initial_controller=False, authorize_before_semantics=True,
    )


@pytest.mark.parametrize("second", [READ, SAVE])
def test_valid_mixed_batch_preserves_native_ids_and_hard_boundary(second):
    calls = [native_call(SAVE, {}, "save"), native_call(second, {}, "second")]
    with pytest.raises(NativeToolBatchCatalogingMixed) as caught:
        validate(calls)
    error = caught.value
    assert error.calls == calls
    assert error.details["cataloging_tool"] == SAVE
    assert not isinstance(error, NativeToolBatchNotOpen)
    error.recovery_fits = True
    for name in (SAVE, second):
        assert error.model_error_result(name)["data"] == {
            "reason": MIXED, "tools": [SAVE, second], "available_tools": sorted([SAVE, READ]),
            "batch_call_count": 2, "executed": False, "retryable": True,
        }


@pytest.mark.parametrize("closed", [
    "unknown", "chapter_writer", "save_external_chapter_draft", "set_tool_categories",
])
def test_save_with_unopened_tool_uses_same_permission_error_as_mobile(closed):
    with pytest.raises(NativeToolBatchNotOpen) as caught:
        validate([native_call(SAVE, {}, "save"), native_call(closed, {}, "closed")])
    assert caught.value.reason == "native_tool_not_open"
    assert caught.value.model_error_result(SAVE)["data"]["executed"] is False


@pytest.mark.parametrize("invalid", ["missing_id", "duplicate_id", "bad_json", "array"])
def test_malformed_mixed_batch_never_enters_receipt_recovery(invalid):
    calls = [native_call(SAVE, {}, "save"), native_call(READ, {}, "read")]
    if invalid in {"missing_id", "duplicate_id"}:
        calls[1]["id"] = "" if invalid == "missing_id" else "save"
    else:
        calls[1]["function"]["arguments"] = "{bad" if invalid == "bad_json" else "[]"
    with pytest.raises(NativeToolBatchValidationError) as caught:
        validate(calls)
    assert not isinstance(caught.value, NativeToolBatchRecoverable)


def test_general_workspace_still_uses_its_protocol_error_boundary():
    calls = [native_call(SAVE, {}, "save"), native_call(READ, {}, "read")]
    capture = SimpleNamespace(calls={index: {
        "id": call["id"], **call["function"],
    } for index, call in enumerate(calls)})
    turn = SimpleNamespace(
        registry=registry, state=SimpleNamespace(category_selected=True),
        _protocol_error=Mock(return_value=RuntimeError("protocol boundary")),
    )
    with pytest.raises(RuntimeError, match="protocol boundary"):
        WorkspaceNativeTurn._validated_tool_calls(
            turn, capture, 1, [{"function": {"name": name}} for name in (SAVE, READ)],
        )
    assert turn._protocol_error.call_args.kwargs["reason"] == MIXED


@pytest.mark.parametrize("second", [READ, SAVE])
def test_three_mixed_batches_stop_without_writing_and_keep_existing_candidates(
    request, monkeypatch, second,
):
    catalog = request.getfixturevalue("archive")
    db, job, run = catalog
    submit(catalog, [plan_rows()[0]], finalize=False)
    saved_id = db.query(CatalogingCandidate).one().id
    calls = []

    async def model(**kwargs):
        calls.append(kwargs)
        for index, name in enumerate((SAVE, second)):
            yield {"type": "tool_call_delta", "index": index,
                   "id": f"mixed-{len(calls)}-{index}", "name": name,
                   "arguments_delta": json.dumps({"job_id": job.id, "chapter_id": "c",
                                                   "candidates": [], "finalize": True})}
        yield {"type": "done"}

    def no_handler(_name):
        pytest.fail("no member of a rejected batch may execute")

    monkeypatch.setattr(registry, "get_handler", no_handler)
    monkeypatch.setattr(orchestrator.LLMGateway, "stream_chat_completion_with_tools", model)

    async def run_agent():
        return [event async for event in orchestrator._extract_run(db, job, run)]

    asyncio.run(run_agent())
    assert len(calls) == 3
    assert run.status == "failed" and job.status == "paused_on_failure"
    assert "累计三次" in run.error
    assert db.query(CatalogingCandidate).one().id == saved_id
    assert db.query(ChapterSummary).count() == 0
    transcript = json.loads(run.raw_output)
    assistants = [entry for entry in transcript if entry["role"] == "assistant"]
    receipts = [entry for entry in transcript if entry["role"] == "tool"]
    assert len(assistants) == 3 and len(receipts) == 6
    assert [entry["tool_call_id"] for entry in receipts] == [
        f"mixed-{batch}-{slot}" for batch in range(1, 4) for slot in range(2)
    ]
    assert all(json.loads(entry["content"])["data"]["executed"] is False for entry in receipts)
    assert [json.loads(entry["content"])["data"]["retryable"] for entry in receipts] == [
        True, True, True, True, False, False,
    ]


@pytest.mark.parametrize("second", [
    READ, SAVE, "chapter_writer", "save_external_chapter_draft", "set_tool_categories",
])
def test_three_chapters_continue_after_second_chapter_mixed_batch(
    tmp_path, monkeypatch, second,
):
    from app.modules.operations.infrastructure import runtime
    from app.services.workspace.tools import external_cataloging

    engine = create_engine(f"sqlite:///{(tmp_path / 'three.db').as_posix()}")
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)
    monkeypatch.setattr(orchestrator, "SessionLocal", sessions)
    monkeypatch.setattr(runtime, "SessionLocal", sessions)
    chapter_file = tmp_path / "chapter.txt"
    chapter_file.write_text("三章隔离回归", encoding="utf-8")
    monkeypatch.setattr(external_cataloging, "ensure_chapter_mirror",
                        lambda *a, **kw: (tmp_path, chapter_file))
    original_handler = registry.get_handler

    def resolve_handler(name):
        if second != SAVE and name == second:
            pytest.fail("a member of the denied batch must not execute")
        return original_handler(name)

    monkeypatch.setattr(registry, "get_handler", resolve_handler)
    reason = MIXED if second in {READ, SAVE} else "native_tool_not_open"
    with sessions() as db:
        db.add(Project(id="p", title="三章隔离回归"))
        db.add_all([Chapter(id=f"c{i}", project_id="p", title=f"旧炉{i}",
                            content="少年走近旧炉。残影回答他的问题。", sort_order=i)
                    for i in range(1, 4)])
        db.commit()
        job = orchestrator.create_cataloging_job(db, "p", "auto", "test:model",
                                                ["c1", "c2", "c3"])
        job_id = job.id

    seen = {chapter: [] for chapter in ("c1", "c2", "c3")}

    async def model(**kwargs):
        chapter_id = json.loads(kwargs["messages"][1]["content"])["chapter_id"]
        step = len(seen[chapter_id])
        seen[chapter_id].append(json.loads(json.dumps(kwargs["messages"])))
        summary, outline = plan_rows()
        outline["title"] = "旧炉" + chapter_id[-1]
        summary_args = {"job_id": job_id, "chapter_id": chapter_id,
                        "candidates": [summary], "finalize": False}
        script = [
            [("get_next_external_cataloging_chapter", {"job_id": job_id})],
            [(SAVE, summary_args)],
            [("select_cataloging_candidate_types", {"types": ["outline_create_chapter"]})],
            [(SAVE, {"job_id": job_id, "chapter_id": chapter_id,
                     "candidates": [outline], "finalize": True})],
        ]
        if chapter_id == "c2":
            other_args = {"kind": "character"} if second == READ else summary_args
            script.insert(1, [(SAVE, summary_args), (second, other_args)])
            if step == 2:
                with sessions() as check:
                    assert check.query(CatalogingCandidate).filter_by(chapter_id="c2").count() == 0
                    assert check.query(CatalogingChapterRun).filter_by(chapter_id="c1").one().status == "completed"
                denied = kwargs["messages"][-2:]
                assert [entry["tool_call_id"] for entry in denied] == ["c2-1-0", "c2-1-1"]
                assert all(json.loads(entry["content"])["data"]["executed"] is False
                           for entry in denied)
                assert all(json.loads(entry["content"])["data"]["reason"] == reason
                           for entry in denied)
        for slot, (name, arguments) in enumerate(script[step]):
            yield {"type": "tool_call_delta", "index": slot,
                   "id": f"{chapter_id}-{step}-{slot}", "name": name,
                   "arguments_delta": json.dumps(arguments, ensure_ascii=False)}
        yield {"type": "done"}

    monkeypatch.setattr(orchestrator.LLMGateway, "stream_chat_completion_with_tools", model)

    async def run_job():
        return [event async for event in orchestrator.stream_cataloging_job("p", job_id)]

    events = asyncio.run(run_job())
    with sessions() as db:
        job = db.get(CatalogingJob, job_id)
        assert job.status == "completed", events
        runs = db.query(CatalogingChapterRun).order_by(CatalogingChapterRun.chapter_order).all()
        assert [run.status for run in runs] == ["completed"] * 3
        assert db.query(ChapterSummary).count() == 3
        assert db.query(CatalogingCandidate).filter_by(status="applied").count() == 6
        assert [len(seen[key]) for key in seen] == [4, 5, 4]
        assert "c2-1-0" in runs[1].raw_output and "c2-1-1" in runs[1].raw_output
        progress = db.query(OperationEvent).filter_by(run_id=job.operation_id).all()
        corrections = [event.payload_json for event in progress
                       if (event.payload_json or {}).get("type") == "cataloging_plan_correction"]
        assert len(corrections) == 1
        assert corrections[0]["reason"] == reason
        assert corrections[0]["chapter_run_id"] == runs[1].id
    engine.dispose()
