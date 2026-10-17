"""Native cataloging compacts receipts, never source text or durable candidates."""
import asyncio
import copy
import json
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database.models import Base, CatalogingCandidate, Chapter, Project
from app.services.cataloging import agent, request_context
from app.services.cataloging.orchestrator import create_cataloging_job
from app.services.conversation_context.budget import Utf8ByteTokenCounter
from app.services.conversation_context.contracts import CapacityAssurance, GenerationModelBinding
from app.services.conversation_context.errors import ConversationContextError


@pytest.fixture
def archive(tmp_path):
    engine = create_engine(f"sqlite:///{(tmp_path / 'context.db').as_posix()}")
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine)() as db:
        db.add(Project(id="p", title="建档上下文"))
        db.add(Chapter(id="c", project_id="p", title="完整章节", content="必须保留的章节原文。"))
        db.commit()
        job = create_cataloging_job(db, "p", "manual", "test:model", ["c"])
        job.status = "running"
        run = job.chapter_runs[0]
        run.status = "extracting"
        db.commit()
        yield db, job, run
    engine.dispose()


def binding(window=18000, output=1000):
    counter = Utf8ByteTokenCounter()
    return GenerationModelBinding(
        task_type="cataloging", provider="test", model_name="model", normalized_model="test:model",
        protocol="native", context_window_tokens=window, max_output_tokens=output,
        token_counter_id=counter.counter_id, capacity_assurance=CapacityAssurance.CONSERVATIVE,
        prompt_contract_hash="prompt", tool_schema_hash="tools", config_fingerprint="config",
    ), counter, 500


def transaction(call_id, name, arguments, result):
    return [{"role": "assistant", "tool_calls": [{"id": call_id, "type": "function", "function": {
        "name": name, "arguments": json.dumps(arguments, ensure_ascii=False),
    }}]}, {"role": "tool", "tool_call_id": call_id, "content": json.dumps(result, ensure_ascii=False)}]


def transcript():
    messages = [{"role": "system", "content": "固定建档契约"}, {"role": "user", "content": "当前章建档"}]
    messages += transaction("source", "get_next_external_cataloging_chapter", {"job_id": "job"}, {
        "status": "ok", "data": {"content": "完整章节的开头、中间和结尾。", "recovery_context": {"old": True}},
    })
    messages += transaction("archive", "read_cataloging_archive", {"kind": "character", "ids": ["hero"]}, {
        "status": "ok", "data": {"items": [{"id": "hero", "background": "完整人物档案，不得截断。"}]},
    })
    for index in range(24):
        messages += transaction(str(index), "save_external_cataloging_candidates", {"finalize": False}, {
            "status": "ok", "data": {"recovery_context": {"repeated": "已存资料" * 500}},
        })
    messages += transaction("repair", "save_external_cataloging_candidates", {"finalize": True}, {
        "status": "error", "data": {"candidate_errors": [{"message": "需要修正类型", "rejected_candidate": {"value": "待修正"}}]},
    })
    return messages


def test_checkpoint_keeps_full_source_plan_latest_feedback_and_audit(archive, monkeypatch):
    db, job, run = archive
    payload = {"id": "hero", "name": "主角", "background": "已保存人物经历" * 40}
    row = CatalogingCandidate(project_id="p", job_id=job.id, chapter_run_id=run.id,
                             chapter_id="c", item_type="character_update", target_id="hero",
                             status="pending", raw_payload=json.dumps(payload, ensure_ascii=False))
    db.add(row)
    db.commit()
    messages = transcript()
    original = copy.deepcopy(messages)
    monkeypatch.setattr(request_context, "resolve_generation_model_binding", lambda **_: binding())
    prepared = request_context.prepare_cataloging_request(
        db, job, run, messages, [], selected_type="character_update",
    )
    assert prepared.checkpointed and prepared.budget.fits_current
    assert messages == original, "The full audit transcript must never be replaced by its request projection"
    state = json.loads(prepared.messages[1]["content"])
    assert state["selected_type"] == "character_update"
    assert state["source_reads"][0]["result"]["data"]["content"] == "完整章节的开头、中间和结尾。"
    assert state["source_reads"][1]["result"]["data"]["items"][0]["background"] == "完整人物档案，不得截断。"
    assert state["resume"]["accepted_candidates"][0]["payload"] == payload
    assert prepared.messages[-2:] == messages[-2:]
    assert "需要修正类型" in prepared.messages[-1]["content"]
    assert "已存资料" not in prepared.messages[1]["content"]
    assert db.get(CatalogingCandidate, row.id).raw_payload == json.dumps(payload, ensure_ascii=False)


def test_latest_read_is_not_duplicated_or_orphaned(archive):
    db, job, run = archive
    messages = transcript()[:6]
    checkpoint = request_context.cataloging_checkpoint_messages(db, job, run, messages, selected_type=None)
    state = json.loads(checkpoint[1]["content"])
    assert len(state["source_reads"]) == 1
    assert checkpoint[-2:] == messages[-2:]
    assert checkpoint[-2]["tool_calls"][0]["id"] == checkpoint[-1]["tool_call_id"]


def test_same_read_arguments_keep_latest_exact_result(archive):
    db, job, run = archive
    messages = transcript()
    newer = {"status": "ok", "data": {"items": [{"id": "hero", "background": "最新完整人物档案"}]}}
    messages += transaction("reread", "read_cataloging_archive", {"ids": ["hero"], "kind": "character"}, newer)
    messages += transaction("select", "select_cataloging_candidate_types", {"types": ["chapter_link"]}, {"status": "ok"})
    checkpoint = request_context.cataloging_checkpoint_messages(db, job, run, messages, selected_type="chapter_link")
    reads = json.loads(checkpoint[1]["content"])["source_reads"]
    assert len(reads) == 2
    assert reads[1]["result"] == newer


def test_full_required_state_over_capacity_is_explicit_and_unchanged(archive, monkeypatch):
    db, job, run = archive
    messages = transcript()
    messages[3]["content"] = json.dumps({"status": "ok", "data": {"content": "原文章节" * 10000}})
    original = copy.deepcopy(messages)
    monkeypatch.setattr(request_context, "resolve_generation_model_binding", lambda **_: binding(5000))
    with pytest.raises(ConversationContextError, match="未截断资料") as error:
        request_context.prepare_cataloging_request(db, job, run, messages, [], selected_type=None)
    assert error.value.code.value == "conversation_required_state_over_capacity"
    assert messages == original


def test_current_schema_and_output_reserve_are_counted_each_step(archive, monkeypatch):
    db, job, run = archive
    seen = []
    def resolve(**kwargs):
        seen.append(kwargs["current_tools"])
        return binding(6000, 2000)
    monkeypatch.setattr(request_context, "resolve_generation_model_binding", resolve)
    messages = transcript()[:2]
    first = request_context.prepare_cataloging_request(db, job, run, messages, [], selected_type=None)
    assert first.budget.request_input_limit == 3500
    schemas = [{"type": "function", "function": {"name": "save", "description": "x" * 5000}}]
    with pytest.raises(ConversationContextError):
        request_context.prepare_cataloging_request(db, job, run, messages, schemas, selected_type=None)
    assert seen == [[], schemas]


def test_agent_uses_checkpoint_projection_but_persists_complete_transcript(archive, monkeypatch):
    db, job, run = archive
    messages = transcript()
    monkeypatch.setattr(agent, "_cataloging_messages", lambda *_: messages)
    monkeypatch.setattr(agent, "cataloging_agent_tool_schemas", lambda **_: [{
        "type": "function", "function": {"name": "save_external_cataloging_candidates", "parameters": {"type": "object"}},
    }])
    monkeypatch.setattr(request_context, "resolve_generation_model_binding", lambda **_: binding())
    requests = []
    async def collect(_gateway, **kwargs):
        requests.append(copy.deepcopy(kwargs))
        return {"tool_calls": [{"id": "finish", "type": "function", "function": {
            "name": "save_external_cataloging_candidates",
            "arguments": json.dumps({"job_id": job.id, "chapter_id": run.chapter_id, "candidates": [], "finalize": True}),
        }}]}
    async def execute(*_):
        return {"status": "ok", "data": {"candidate_set_complete": True}}
    monkeypatch.setattr(agent, "collect_tool_turn", collect)
    monkeypatch.setattr(agent, "_execute_cataloging_call", execute)
    async def consume():
        return [event async for event in agent.run_cataloging_agent(
            db, job, run, check_active=lambda *_: None, gateway=SimpleNamespace(),
        )]
    events = asyncio.run(consume())
    assert len(requests) == 1 and requests[0]["max_tokens"] == 1000
    assert json.loads(requests[0]["messages"][1]["content"])["schema"] == "cataloging_checkpoint.v1"
    assert events[0]["type"] == "cataloging_stage"
    persisted = json.loads(run.raw_output)
    assert persisted == messages[2:]
    assert len(persisted) > 50 and "已存资料" in json.dumps(persisted, ensure_ascii=False)


def test_complete_retained_plan_finalizes_after_checkpoint_without_regeneration(archive, monkeypatch):
    from app.database.models import CatalogingApplyLog
    from app.services.cataloging import orchestrator
    from tests.test_cataloging_plan import plan_rows, submit

    db, job, run = archive
    result = submit(archive, plan_rows(), finalize=False)
    assert result["data"]["missing_required_items"] == []
    retained_ids = {row.id for row in db.query(CatalogingCandidate).all()}
    messages = transcript()
    monkeypatch.setattr(agent, "_cataloging_messages", lambda *_: messages)
    monkeypatch.setattr(request_context, "resolve_generation_model_binding", lambda **_: binding(30000))
    requests = []

    async def model(**kwargs):
        requests.append(copy.deepcopy(kwargs))
        yield {"type": "tool_call_delta", "index": 0, "id": "finalize", "name": "save_external_cataloging_candidates",
               "arguments_delta": json.dumps({"job_id": job.id, "chapter_id": run.chapter_id,
                                               "candidates": [], "finalize": True})}
        yield {"type": "done"}

    monkeypatch.setattr(orchestrator.LLMGateway, "stream_chat_completion_with_tools", model)

    async def execute():
        return [event async for event in orchestrator._extract_run(db, job, run)]

    asyncio.run(execute())
    assert run.status == "awaiting_confirmation", run.error
    assert len(requests) == 1
    checkpoint = json.loads(requests[0]["messages"][1]["content"])
    assert checkpoint["resume"]["missing_required_items"] == []
    assert {row.id for row in db.query(CatalogingCandidate).all()} == retained_ids
    assert db.query(CatalogingApplyLog).count() == 0, "Manual mode still requires author confirmation"


def test_cold_local_runtime_is_loaded_before_binding_and_uses_actual_capacity(archive, monkeypatch):
    import app.services.local_runtime as local_runtime

    db, job, run = archive
    job.model = "local_llama_cpp:qwen3.8-27b-q3"
    monkeypatch.setattr(request_context.model_executor, "model_identity",
                        lambda *_: ("local_llama_cpp", "qwen3.8-27b-q3"))
    calls = []
    runtime = SimpleNamespace(api_key=None)

    def ensure(model, **kwargs):
        calls.append(("ensure", model, kwargs))
        runtime.api_key = "fixture-only"

    runtime.ensure_running = ensure
    runtime.status = lambda: {"running": bool(runtime.api_key), "model_key": "qwen3.8-27b-q3", "context_length": 32000}
    monkeypatch.setattr(local_runtime, "get_runtime_manager", lambda: runtime)

    def resolve(**kwargs):
        assert runtime.api_key, "The actual runtime must be ready before tokenizer binding"
        assert kwargs["extra_body"]["chat_template_kwargs"] == {"enable_thinking": False}
        calls.append(("bind",))
        return binding(64000, 16000)

    monkeypatch.setattr(request_context, "resolve_generation_model_binding", resolve)
    prepared = request_context.prepare_cataloging_request(
        db, job, run, transcript()[:2], [], selected_type=None,
    )
    assert calls == [("ensure", "qwen3.8-27b-q3", {
        "task_type": "cataloging", "project_id": None, "context_length": None, "adapter_ids": None,
    }), ("bind",)]
    assert prepared.budget.context_window_tokens == 32000
    assert prepared.budget.request_input_limit == 15500


def test_local_launch_failure_stops_before_budgeting_or_model_request(archive, monkeypatch):
    import app.services.local_runtime as local_runtime

    db, job, run = archive
    job.model = "local_llama_cpp:qwen3.8-27b-q3"
    monkeypatch.setattr(request_context.model_executor, "model_identity",
                        lambda *_: ("local_llama_cpp", "qwen3.8-27b-q3"))
    def fail(*_, **__):
        raise RuntimeError("测试模型加载失败")
    monkeypatch.setattr(local_runtime, "get_runtime_manager", lambda: SimpleNamespace(ensure_running=fail))
    monkeypatch.setattr(request_context, "resolve_generation_model_binding", lambda **_: pytest.fail("must not bind"))
    with pytest.raises(ConversationContextError, match="建档请求尚未发送") as error:
        request_context.prepare_cataloging_request(db, job, run, transcript(), [], selected_type=None)
    assert error.value.code.value == "conversation_capacity_unknown"
    assert error.value.details["reason"] == "cataloging_local_runtime_not_ready"


def test_shared_model_profile_preview_does_not_start_local_model(monkeypatch):
    import app.services.local_runtime as local_runtime
    from app.services.conversation_context.assembly import resolve_generation_model_binding

    manager = SimpleNamespace(
        ensure_running=lambda *_, **__: pytest.fail("A preview must not load the model"),
        request_token_counter=lambda *_, **__: None,
    )
    monkeypatch.setattr(local_runtime, "get_runtime_manager", lambda: manager)
    profile = SimpleNamespace(known=True, provider="local_llama_cpp", model_name="qwen3.8-27b-q3",
                              context_window_tokens=64000, max_output_tokens=16000, safety_margin_tokens=500)
    resolved, counter, _ = resolve_generation_model_binding(
        orchestrator=SimpleNamespace(resolve_model_profile=lambda *_: profile),
        model="local_llama_cpp:qwen3.8-27b-q3", task_type="cataloging", protocol="native",
        system_prompt="preview", current_tools=[],
    )
    assert resolved.context_window_tokens == 64000 and isinstance(counter, Utf8ByteTokenCounter)
