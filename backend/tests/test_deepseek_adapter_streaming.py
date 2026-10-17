"""Regression tests for DeepSeek reasoning/content stream handling."""
import asyncio
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.ai.deepseek_adapter import DeepSeekAdapter
from app.core.exceptions import LLMError


def _chunk(*, content=None, reasoning_content=None, choices=True):
    if not choices:
        return SimpleNamespace(choices=[])
    delta = SimpleNamespace(
        content=content,
        reasoning_content=reasoning_content,
    )
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)])


def _async_stream(*chunks):
    async def generate():
        for chunk in chunks:
            yield chunk

    return generate()


class DeepSeekStreamingTest(unittest.TestCase):
    def test_nonstream_tool_response_preserves_native_reasoning_for_continuation(self):
        reasoning = "先读取真实资料，再更新立项。"
        native_call = SimpleNamespace(
            id="call-original",
            function=SimpleNamespace(name="get_creation_session", arguments='{"session_id":"s1"}'),
        )
        first = SimpleNamespace(
            choices=[SimpleNamespace(
                finish_reason="tool_calls",
                message=SimpleNamespace(content=None, reasoning_content=reasoning, tool_calls=[native_call]),
            )],
            model="deepseek-flash", usage=None,
        )
        second = SimpleNamespace(
            choices=[SimpleNamespace(
                finish_reason="stop",
                message=SimpleNamespace(content="已读取", reasoning_content="读取完成", tool_calls=None),
            )],
            model="deepseek-flash", usage=None,
        )
        adapter = DeepSeekAdapter(api_key="sk-test")
        client = MagicMock()
        client.chat.completions.create = AsyncMock(side_effect=[first, second])
        adapter._get_client = MagicMock(return_value=client)
        messages = [{"role": "user", "content": "读取立项资料"}]
        tools = [{"type": "function", "function": {
            "name": "get_creation_session", "parameters": {"type": "object"},
        }}]

        async def run():
            result = await adapter.chat_completion(messages=messages, model="deepseek-flash", tools=tools)
            self.assertEqual(result["reasoning_content"], reasoning)
            self.assertEqual(result["content"], "")
            messages.extend([
                {"role": "assistant", **{key: result[key] for key in ("content", "reasoning_content", "tool_calls")}},
                {"role": "tool", "tool_call_id": "call-original", "content": '{"revision":1}'},
            ])
            return await adapter.chat_completion(messages=messages, model="deepseek-flash", tools=tools)

        result = asyncio.run(run())
        self.assertEqual(result["content"], "已读取")
        continued = client.chat.completions.create.await_args.kwargs["messages"][1]
        self.assertEqual(continued["reasoning_content"], reasoning)
        self.assertEqual(continued["tool_calls"][0]["id"], "call-original")

    def test_discovered_models_reach_text_and_native_tool_streams_unchanged(self):
        for model in ("deepseek-flash", "deepseek-future-test-model"):
            for native_tools in (False, True):
                with self.subTest(model=model, native_tools=native_tools):
                    adapter = self._adapter_with_stream(_chunk(content="OK"))

                    async def collect():
                        method = adapter.stream_chat_completion_with_tools if native_tools else adapter.stream_chat_completion
                        return [event async for event in method(
                            messages=[{"role": "user", "content": "hello"}], model=model,
                        )]

                    events = asyncio.run(collect())
                    self.assertIn({"type": "content_delta", "delta": "OK"} if native_tools else "OK", events)
                    create = adapter._get_client.return_value.chat.completions.create
                    self.assertEqual(create.await_args.kwargs["model"], model)

    @staticmethod
    def _adapter_with_stream(*chunks):
        adapter = DeepSeekAdapter(api_key="sk-test")
        client = MagicMock()
        client.chat.completions.create = AsyncMock(
            return_value=_async_stream(*chunks)
        )
        adapter._get_client = MagicMock(return_value=client)
        return adapter

    def test_stream_ignores_usage_chunks_without_choices(self):
        adapter = self._adapter_with_stream(
            _chunk(choices=False),
            _chunk(content="final answer"),
        )

        async def collect():
            return [part async for part in adapter.stream_chat_completion(
                messages=[{"role": "user", "content": "hello"}],
                model="deepseek-v4-flash",
            )]

        chunks = asyncio.run(collect())
        self.assertEqual("".join(chunks), "final answer")
        self.assertIn("", chunks)  # Transport activity must reset the gateway idle timer.
        create = adapter._get_client.return_value.chat.completions.create
        self.assertEqual(
            create.await_args.kwargs["extra_body"],
            {"thinking": {"type": "disabled"}},
        )

    def test_stream_preserves_explicit_thinking_preference(self):
        adapter = self._adapter_with_stream(
            _chunk(reasoning_content="thinking"),
            _chunk(content="final answer"),
        )

        async def collect():
            return [part async for part in adapter.stream_chat_completion(
                messages=[{"role": "user", "content": "hello"}],
                model="deepseek-v4-flash",
                extra_body={"thinking": {"type": "enabled"}},
            )]

        chunks = asyncio.run(collect())
        self.assertEqual("".join(chunks), "final answer")
        self.assertIn("", chunks)  # Transport activity must reset the gateway idle timer.
        create = adapter._get_client.return_value.chat.completions.create
        self.assertEqual(
            create.await_args.kwargs["extra_body"],
            {"thinking": {"type": "enabled"}},
        )

    def test_reasoning_only_stream_reports_missing_final_answer(self):
        adapter = self._adapter_with_stream(
            _chunk(reasoning_content="thinking"),
            _chunk(choices=False),
        )

        async def collect():
            return [part async for part in adapter.stream_chat_completion(
                messages=[{"role": "user", "content": "hello"}],
                model="deepseek-v4-flash",
            )]

        with self.assertRaises(LLMError) as raised:
            asyncio.run(collect())

        self.assertIn("最终回答为空", str(raised.exception))
        self.assertIn("无需永久关闭", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
