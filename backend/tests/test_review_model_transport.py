"""Real SDK / simulated transport checks for request and completion boundaries."""
import asyncio
from contextlib import suppress
from functools import wraps
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.ai import anthropic_adapter, openai_adapter
from app.ai.anthropic_adapter import AnthropicAdapter
from app.ai.openai_adapter import OpenAIAdapter
from app.core.exceptions import LLMError, LLMIncompleteResponseError
from app.modules.model_runtime.infrastructure.gateway import LLMGateway


def run_async(fn):
    @wraps(fn)
    def run(*args, **kwargs):
        return asyncio.run(fn(*args, **kwargs))
    return run

@pytest.fixture(autouse=True)
def isolated_model():
    with patch.object(LLMGateway, "_parse_model", return_value=("audit", "test")), \
         patch.object(LLMGateway, "_load_config", return_value=CONFIG), \
         patch.object(LLMGateway, "_get_adapter", return_value=OpenAIAdapter):
        yield

CONFIG = SimpleNamespace(
    api_key="synthetic-audit-key", base_url="https://example.invalid/v1",
    provider="audit", api_protocol="chat_completions", cli_command=None, cli_args=None,
)


@pytest.mark.parametrize("adapter,namespace,factory", [(OpenAIAdapter, openai_adapter, "TracedOpenAIHttpClient"), (AnthropicAdapter, anthropic_adapter, "TracedAnthropicHttpClient")])
@run_async
async def test_gateway_is_the_only_retry_owner(adapter, namespace, factory):
    requests = []
    clients = []

    def handler(request):
        requests.append(request)
        return httpx.Response(503, headers={"retry-after-ms": "1"},
                              json={"error": {"message": "synthetic unavailable"}})

    def client_factory():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        clients.append(client)
        return client

    with patch.object(namespace, factory, side_effect=client_factory), patch("asyncio.sleep", new=AsyncMock()), patch.object(LLMGateway, "_get_adapter", return_value=adapter):
        for retry in (0, 3):
            requests.clear()
            with suppress(LLMError):
                await LLMGateway.chat_completion(
                    messages=[{"role": "user", "content": "synthetic audit"}],
                    model="audit:test", max_tokens=30, timeout=3, retry=retry,
                )
            assert len(requests) == retry + 1
    for client in clients:
        await client.aclose()


@run_async
async def test_reasoning_activity_does_not_timeout_text_stream():
    frames = []

    async def create(**kwargs):
        async def stream():
            for index in range(10):
                await asyncio.sleep(0.025)
                frames.append(index)
                yield SimpleNamespace(
                    choices=[SimpleNamespace(finish_reason=None, delta=SimpleNamespace(
                        content=None, reasoning_content="thinking", tool_calls=None))],
                    usage=None,
                )
            yield SimpleNamespace(
                choices=[SimpleNamespace(finish_reason="stop", delta=SimpleNamespace(
                    content="finished", reasoning_content=None, tool_calls=None))],
                usage=None,
            )
        return stream()

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    with patch.object(OpenAIAdapter, "_get_client", return_value=client):
        for tools in (False, True):
            frames.clear()
            received = []
            error = None
            generator = (
                LLMGateway.stream_chat_completion_with_tools if tools
                else LLMGateway.stream_chat_completion
            )
            try:
                async for event in generator(
                    messages=[{"role": "user", "content": "synthetic audit"}],
                    model="audit:test", timeout=0.12, retry=0, resume=0,
                ):
                    received.append(event)
            except LLMError as exc:
                error = str(exc)
            assert error is None
            assert len(frames) == 10
            assert received



@run_async
async def test_nonstream_truncation_is_not_delivered():
    clients = []

    def handler(request):
        return httpx.Response(200, json={
            "id": "synthetic-response", "object": "chat.completion", "created": 0,
            "model": "test", "choices": [{"index": 0, "finish_reason": "length",
                "message": {"role": "assistant", "content": "unfinished prose"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 30, "total_tokens": 40},
        })

    def client_factory():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        clients.append(client)
        return client

    with patch.object(openai_adapter, "TracedOpenAIHttpClient", side_effect=client_factory), pytest.raises(LLMIncompleteResponseError):
        await LLMGateway.chat_completion(
            messages=[{"role": "user", "content": "synthetic"}],
            model="audit:test", max_tokens=30, timeout=3, retry=3,
        )
    for client in clients:
        await client.aclose()


@run_async
async def test_deconstruct_uses_endpoint_policy():
    from app.ai.request_policy import provider_extra_body
    from app.services.deconstruct import map_reduce

    mocked = AsyncMock(return_value={"content": "{}"})
    with patch.object(map_reduce, "LLMGateway", SimpleNamespace(chat_completion=mocked)), \
         patch.object(map_reduce, "map_output_limit_for", return_value=100):
        await map_reduce.repair_json_output("{invalid", "custom:deepseek-r1")
        metadata = mocked.call_args.kwargs["extra_body"]
        assert "thinking" not in (provider_extra_body(metadata, "https://api.siliconflow.cn/v1", text_only=True) or {})


@pytest.mark.parametrize("reason", ["incomplete", "failed", "cancelled"])
@run_async
async def test_responses_completion_rejects_unfinished_results(reason):
    response = SimpleNamespace(status=reason, output_text="partial prose")
    client = SimpleNamespace(responses=SimpleNamespace(create=AsyncMock(return_value=response)))
    adapter = OpenAIAdapter(api_key="test", api_protocol="responses")
    with patch.object(adapter, "_get_client", return_value=client), pytest.raises(LLMIncompleteResponseError):
        await adapter.chat_completion(messages=[], model="test")


@run_async
async def test_anthropic_nonstream_rejects_output_limit():
    client = SimpleNamespace(messages=SimpleNamespace(create=AsyncMock(return_value=SimpleNamespace(stop_reason="max_tokens"))))
    adapter = AnthropicAdapter(api_key="test")
    with patch.object(adapter, "_get_client", return_value=client), pytest.raises(LLMIncompleteResponseError):
        await adapter.chat_completion(messages=[], model="test", max_tokens=20)
