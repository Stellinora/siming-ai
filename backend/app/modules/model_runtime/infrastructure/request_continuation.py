"""Keep a recovered tool request's wire settings with its native transaction."""
from __future__ import annotations

from copy import deepcopy

from app.ai.request_policy import MODEL_REQUEST_POLICY, non_thinking_defaults
from app.core.exceptions import LLMError

CONTINUATION_STATE_TYPE = "siming_tool_request_v1"


def _binding(adapter, provider: str, model: str) -> dict:
    return {
        "provider": provider,
        "model": model,
        "base_url": adapter.base_url or getattr(adapter, "DEFAULT_BASE_URL", ""),
        "api_protocol": "responses" if adapter.api_protocol == "responses" else "chat_completions",
    }


def recovery_continuation(adapter, provider: str, model: str, body: dict) -> dict:
    """Create runtime metadata, never provider-authored reasoning or arguments."""
    return {
        "type": CONTINUATION_STATE_TYPE, **_binding(adapter, provider, model),
        "extra_body": deepcopy(body),
    }


def prepare_request_continuation(
    messages: list[dict], extra_body: dict | None, adapter, provider: str, model: str,
) -> tuple[list[dict], dict | None, dict | None]:
    """Consume only this active tool chain's matching, persisted request policy.

    The metadata travels in the existing opaque transaction state so recovery
    survives serialization. It is always removed before calling an adapter.
    Closed author turns and other endpoints cannot change the new request.
    """
    binding = _binding(adapter, provider, model)
    latest_author = max(
        (i for i, item in enumerate(messages) if item.get("role") == "user"), default=-1,
    )
    continuation = None
    rendered = []
    for index, message in enumerate(messages):
        item = dict(message)
        states = message.get("provider_state")
        if isinstance(states, (list, tuple)):
            native_states = []
            for state in states:
                if not isinstance(state, dict) or state.get("type") != CONTINUATION_STATE_TYPE:
                    native_states.append(state)
                    continue
                if (
                    index > latest_author and message.get("role") == "assistant"
                    and message.get("tool_calls")
                    and all(state.get(key) == value for key, value in binding.items())
                ):
                    allowed = non_thinking_defaults(
                        binding["base_url"], binding["api_protocol"], "tool_recovery", None,
                    )
                    if not allowed or state.get("extra_body") != allowed:
                        raise LLMError("工具回合的模型请求恢复状态无效，未发送请求。")
                    continuation = deepcopy(state)
            if native_states:
                item["provider_state"] = native_states
            else:
                item.pop("provider_state", None)
        rendered.append(item)
    if continuation is None:
        return rendered, extra_body, None
    body = dict(extra_body or {})
    recovered = continuation["extra_body"]
    for key in MODEL_REQUEST_POLICY["explicit_thinking_fields"]:
        if key in body and (key not in recovered or body[key] != recovered[key]):
            raise LLMError("当前工具回合的思考模式与已保存的恢复状态不一致，请在新回合切换模式。")
    return rendered, {**body, **recovered}, continuation


def attach_request_continuation(result: dict, continuation: dict | None) -> dict:
    if continuation is None:
        return result
    return {
        **result,
        "provider_state": [*(result.get("provider_state") or []), deepcopy(continuation)],
    }
