"""PC and Android run the same endpoint/protocol request cases."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.ai.capabilities import sanitize_tool_request
from app.ai.deepseek_adapter import DeepSeekAdapter
from app.ai.openai_adapter import OpenAIAdapter
from app.ai.request_policy import provider_extra_body

CASES = json.loads((Path(__file__).resolve().parents[2] /
                    "contracts/fixtures/model_request_policy_cases.json").read_text(encoding="utf-8"))
TOOLS = [{"type": "function", "function": {"name": "read", "parameters": {"type": "object"}}}]


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["id"])
def test_shared_policy_cases(case):
    assert (provider_extra_body(case["extra"], case["url"], case["protocol"],
                                text_only=case["text_only"]) or {}) == case["expected"]
    _, choice, _ = sanitize_tool_request(
        case["label"], TOOLS, "required", base_url=case["url"], api_protocol=case["protocol"],
    )
    assert choice == case["tool_choice"]


@pytest.mark.parametrize("adapter_class", [OpenAIAdapter, DeepSeekAdapter])
@pytest.mark.parametrize("case", CASES, ids=lambda case: case["id"])
def test_real_adapter_sends_protocol_specific_defaults(case, adapter_class):
    adapter = adapter_class(api_key="fixture-key", base_url=case["url"], api_protocol=case["protocol"])
    client = MagicMock()
    response = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content="ok", tool_calls=None))],
        model=case["model"], usage=None, output=[], output_text="ok", id="response-1", status="completed",
    )
    client.chat.completions.create = AsyncMock(return_value=response)
    client.responses.create = AsyncMock(return_value=response)
    adapter._get_client = lambda: client
    asyncio.run(adapter.chat_completion(
        messages=[{"role": "user", "content": "fixture"}], model=case["model"],
        extra_body=case["extra"], tools=[] if case["text_only"] else TOOLS, tool_choice="required",
    ))
    method = client.responses.create if case["protocol"] == "responses" else client.chat.completions.create
    wire = method.await_args.kwargs
    assert wire.get("extra_body", {}) == case["expected"]
    assert wire.get("tool_choice") == case["tool_choice"]
    assert not any(key.startswith("moshu_") for key in wire.get("extra_body", {}))
