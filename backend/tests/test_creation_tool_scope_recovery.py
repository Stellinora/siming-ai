"""A valid-but-unavailable batch is denied atomically and corrected by the model."""
import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest

from app.services.conversation_context import ConversationContextError, ConversationContextErrorCode
from app.services.creation_agent_errors import safe_creation_agent_error
from app.services.novel_creation_agent import run_creation_agent
from tests.test_novel_creation_agent import _stream_completion, _test_context_preparer
from tests.test_novel_creation_workspace_v2 import _db, _ready_session
from tests.tool_budget_helpers import request_budget


def _call(call_id, name, **arguments):
    return {"id": call_id, "type": "function", "function": {
        "name": name, "arguments": json.dumps(arguments),
    }}


def test_creation_model_corrects_unopened_batch_without_executing_valid_write_prefix():
    db = _db()
    session = _ready_session(db)
    captures = []
    snapshots = []
    responses = [
        {"tool_calls": [_call("select-1", "set_tool_categories",
                              enabled_categories=["creation_artifacts", "creation_generation"])]},
        {"tool_calls": [_call("read-1", "get_creation_artifact", artifact="characters")]},
        {"reasoning_content": "Need an entity before writing.", "tool_calls": [
            _call("write-denied", "generate_creation_artifact", artifact="characters"),
            _call("read-denied", "list_creation_entities", artifact="world_style"),
        ]},
        {"tool_calls": [_call("select-2", "set_tool_categories",
                              enabled_categories=["creation_entities"])]},
        {"tool_calls": [_call("read-2", "list_creation_entities", artifact="world_style")]},
        {"content": "已读取相关资料，请确认角色构思。", "tool_calls": []},
    ]
    completion = _stream_completion(responses)
    executor = AsyncMock(return_value={"status": "ok", "detail": "Read complete", "data": {}})

    async def persist(value):
        snapshots.append(value)

    with patch("app.services.novel_creation_agent.LLMGateway.stream_chat_completion_with_tools", completion), patch(
        "app.services.creation_agent_execution.execute_workspace_action", executor,
    ):
        result = asyncio.run(run_creation_agent(
            db, session=session, message="生成角色与关系", model="openai:test",
            provider_request_budget=request_budget,
            prepare_model_messages=_test_context_preparer("生成角色与关系", captured=captures),
            persist_runtime_state=persist,
        ))
    assert [call.args[2]["tool"] for call in executor.await_args_list] == [
        "get_creation_artifact", "list_creation_entities",
    ]
    retry_messages = completion.call_args_list[3].kwargs["messages"]
    denied = [json.loads(m["content"]) for m in retry_messages
              if m.get("tool_call_id") in {"write-denied", "read-denied"}]
    assert len(denied) == 2
    assert all(x["data"]["executed"] is False and x["data"]["retryable"] for x in denied)
    assert all("set_tool_categories" in x["data"]["available_tools"] for x in denied)
    assert not any("list_creation_entities" in x["data"]["available_tools"] for x in denied)
    assistant = next(m for m in retry_messages if m.get("reasoning_content"))
    assert assistant["reasoning_content"] == "Need an entity before writing."
    assert snapshots
    assert result["reply"]


@pytest.mark.parametrize("reason", ["native_tool_not_open", "invalid_native_tool_arguments_json"])
def test_protocol_failure_does_not_misdiagnose_context_capacity(reason):
    error = ConversationContextError(ConversationContextErrorCode.PROTOCOL_INVALID,
                                     "private protocol failure", details={"reason": reason})
    message, details = safe_creation_agent_error(error)
    assert "此前进度已保留" in message
    assert "上下文处理失败" not in message
    assert "缩小" not in details["next_action"]


def test_first_denial_without_capacity_stops_without_claiming_repeated_model_failure():
    db = _db()
    session = _ready_session(db)
    completion = _stream_completion({"tool_calls": [_call("unopened", "get_creation_snapshot")]})
    executor = AsyncMock()
    with patch("app.services.novel_creation_agent.LLMGateway.stream_chat_completion_with_tools", completion), patch(
        "app.services.creation_agent_execution.execute_workspace_action", executor,
    ), pytest.raises(ConversationContextError) as caught:
        asyncio.run(run_creation_agent(
            db, session=session, message="继续", model="openai:test",
            provider_request_budget=lambda: request_budget(1),
            prepare_model_messages=_test_context_preparer("继续"),
        ))
    assert caught.value.code is ConversationContextErrorCode.TOOL_TRANSACTION_OVER_CAPACITY
    assert caught.value.details["termination_reason"] == "capacity"
    assert caught.value.details["native_tool_name_rejections"] == 1
    assert "连续选择" not in safe_creation_agent_error(caught.value)[0]
    executor.assert_not_awaited()
    assert completion.call_count == 1
