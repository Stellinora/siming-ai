"""A recovered DeepSeek tool call remains callable in the next native step."""
from __future__ import annotations

import asyncio
import json
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.ai.base import BaseAdapter
from app.core.exceptions import LLMError
from app.modules.model_runtime.infrastructure.gateway import LLMGateway
from app.modules.model_runtime.infrastructure.request_continuation import (
    CONTINUATION_STATE_TYPE,
    prepare_request_continuation,
    recovery_continuation,
)
from app.services.agent_tool_stream import collect_tool_turn
from app.services.conversation_context.codec import _transaction_from_dict
from app.services.conversation_context.tool_transactions import (
    NativeToolCall,
    NativeToolResult,
    ToolTransaction,
)


@pytest.mark.parametrize("protocol,disabled", [
    ("chat_completions", {"thinking": {"type": "disabled"}}),
    ("responses", {"reasoning": {"effort": "none"}}),
])
def test_recovery_policy_survives_persisted_tool_transaction_and_stream_resume(monkeypatch, protocol, disabled):
    calls = []

    class Endpoint(BaseAdapter):
        @property
        def provider_name(self):
            return "deepseek"

        async def chat_completion(self, **kwargs):
            calls.append(deepcopy(kwargs))
            return {"content": "read", "provider_state": [{"type": "native", "id": "preserved"}]}

        async def stream_chat_completion(self, **kwargs):
            calls.append(deepcopy(kwargs))
            yield "read"

        async def stream_chat_completion_with_tools(self, **kwargs):
            calls.append(deepcopy(kwargs))
            if len(calls) == 1:
                yield {"type": "reasoning_delta", "delta": "unfinished reasoning"}
                yield {"type": "done", "finish_reason": "length"}
                return
            if len(calls) == 3:
                yield {"type": "reasoning_delta", "delta": "transport activity"}
                raise TimeoutError("simulated interrupted response")
            yield {
                "type": "tool_call_delta", "index": 0, "id": f"call-{len(calls)}",
                "name": "read", "arguments_delta": "{}",
            }
            yield {"type": "done", "finish_reason": "tool_calls", "reasoning_content": ""}

    config = SimpleNamespace(
        api_key="test", base_url="https://api.deepseek.com", api_protocol=protocol,
    )
    monkeypatch.setattr(LLMGateway, "_parse_model", staticmethod(lambda _value: ("deepseek", "deepseek-flash")))
    monkeypatch.setattr(LLMGateway, "_load_config", staticmethod(lambda _value: config))
    monkeypatch.setattr(LLMGateway, "_get_adapter", staticmethod(lambda _value: Endpoint))
    monkeypatch.setattr("app.modules.model_runtime.infrastructure.gateway.asyncio.sleep", AsyncMock())
    options = {"model": "deepseek:deepseek-flash", "tools": [{
        "type": "function", "function": {"name": "read", "parameters": {"type": "object"}},
    }], "retry": 0, "max_tokens": 4096}

    async def run():
        messages = [{"role": "user", "content": "读取资料"}]
        first = await collect_tool_turn(LLMGateway, messages=messages, **options)
        assert first["reasoning_content"] == ""
        assert first["provider_state"][0]["type"] == CONTINUATION_STATE_TYPE
        transaction = ToolTransaction(
            transaction_id="tx", assistant_message_id="assistant", assistant_content="",
            calls=(NativeToolCall("call-2", "read", "{}"),),
            assistant_provider_state=tuple(first["provider_state"]),
        ).add_result(NativeToolResult("call-2", '{"revision":1}')).mark_delivered()
        reloaded = _transaction_from_dict(json.loads(json.dumps(transaction.to_dict())))
        messages += list(reloaded.native_messages())
        second = await collect_tool_turn(LLMGateway, messages=messages, **options)
        assert second["provider_state"] == first["provider_state"]
        nonstream = await LLMGateway.chat_completion(messages=messages, **options)
        assert nonstream["provider_state"] == [
            {"type": "native", "id": "preserved"}, *first["provider_state"],
        ]
        text_options = {key: value for key, value in options.items() if key != "tools"}
        assert [part async for part in LLMGateway.stream_chat_completion(messages=messages, **text_options)] == ["read"]
        messages.append({"role": "user", "content": "新的任务"})
        await collect_tool_turn(LLMGateway, messages=messages, **options)

    asyncio.run(run())
    assert calls[0]["extra_body"] is None
    assert [call["extra_body"] for call in calls[1:-1]] == [disabled] * 5
    assert calls[-1]["extra_body"] is None
    assert all(
        state.get("type") != CONTINUATION_STATE_TYPE
        for call in calls for message in call["messages"] for state in message.get("provider_state", [])
    )
    assert calls[2]["messages"][-1] == {"role": "tool", "tool_call_id": "call-2", "content": '{"revision":1}'}


def _fixture():
    adapter = SimpleNamespace(base_url="https://api.deepseek.com", api_protocol="chat_completions")
    state = recovery_continuation(adapter, "deepseek", "deepseek-flash", {"thinking": {"type": "disabled"}})
    messages = [
        {"role": "user", "content": "当前任务"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "call"}],
         "provider_state": [{"type": "reasoning", "encrypted_content": "original"}, state]},
    ]
    return adapter, messages


@pytest.mark.parametrize("change", ["provider", "model", "endpoint", "protocol", "new_turn"])
def test_recovered_settings_do_not_leak_to_other_model_or_turn(change):
    adapter, messages = _fixture()
    provider, model = "deepseek", "deepseek-flash"
    if change == "provider":
        provider = "custom"
    elif change == "model":
        model = "another-model"
    elif change == "endpoint":
        adapter.base_url = "https://proxy.example.com"
    elif change == "protocol":
        adapter.api_protocol = "responses"
    else:
        messages.append({"role": "user", "content": "新的请求"})
    original = deepcopy(messages)
    rendered, body, continuation = prepare_request_continuation(messages, None, adapter, provider, model)
    assert body is None and continuation is None
    assert rendered[1]["provider_state"] == [{"type": "reasoning", "encrypted_content": "original"}]
    assert messages == original


def test_recovered_settings_do_not_override_explicit_thinking_change():
    adapter, messages = _fixture()
    with pytest.raises(LLMError, match="新回合切换模式"):
        prepare_request_continuation(messages, {"thinking": {"type": "enabled"}}, adapter, "deepseek", "deepseek-flash")


def test_malformed_recovery_state_cannot_inject_arbitrary_request_settings():
    adapter, messages = _fixture()
    messages[-1]["provider_state"][-1]["extra_body"]["max_tokens"] = 1
    with pytest.raises(LLMError, match="恢复状态无效"):
        prepare_request_continuation(messages, None, adapter, "deepseek", "deepseek-flash")
