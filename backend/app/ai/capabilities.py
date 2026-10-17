"""Native tool capability checks and endpoint request adjustments for the gateway."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.core.provider_errors import provider_field_rejected

from .request_policy import provider_tool_choice

TOOL_CAPABILITY_UNAVAILABLE = "tool_capability_unavailable"
TOOL_CAPABILITY_UNAVAILABLE_MESSAGE = (
    f"{TOOL_CAPABILITY_UNAVAILABLE}: 当前模型不支持原生工具调用，本次请求未发送。"
)


class ToolCapabilityUnavailableError(RuntimeError):
    """A caller required native tools that the selected provider cannot carry."""

    reason_code = TOOL_CAPABILITY_UNAVAILABLE

    def __init__(self) -> None:
        super().__init__(TOOL_CAPABILITY_UNAVAILABLE_MESSAGE)


@dataclass(frozen=True)
class ProviderCapabilities:
    supports_tools: bool = True
    supports_streaming_tools: bool = True


_NO_NATIVE_TOOLS = ProviderCapabilities(
    supports_tools=False,
    supports_streaming_tools=False,
)


PROVIDER_CAPABILITIES: dict[str, ProviderCapabilities] = {
    "openai": ProviderCapabilities(),
    "qwen": ProviderCapabilities(),
    "anthropic": ProviderCapabilities(),
    "deepseek": ProviderCapabilities(),
    "gemini": ProviderCapabilities(),
    # Agent CLIs do not emit OpenAI tool-call envelopes. Authorized workflows
    # attach Siming as a native MCP server inside the CLI process instead.
    "claude_cli": _NO_NATIVE_TOOLS,
    "codex_cli": _NO_NATIVE_TOOLS,
    "opencode_cli": _NO_NATIVE_TOOLS,
    "mimocode_cli": _NO_NATIVE_TOOLS,
    "cursor_cli": _NO_NATIVE_TOOLS,
    "kilocode_cli": _NO_NATIVE_TOOLS,
    "qwen_code_cli": _NO_NATIVE_TOOLS,
    "hermes_cli": _NO_NATIVE_TOOLS,
    "openclaw_cli": _NO_NATIVE_TOOLS,
    "dsh_cli": _NO_NATIVE_TOOLS,
    "custom_cli": _NO_NATIVE_TOOLS,
    # The managed llama.cpp server exposes OpenAI-compatible tool calls.  Do not
    # infer a model's capability from the fact that it runs locally: pass the
    # caller's tools through and let the selected model/template answer.  Agent
    # callers retain their existing error/empty-stream fallback paths.
    "local_llama_cpp": ProviderCapabilities(),
}


def provider_capabilities(provider: str) -> ProviderCapabilities:
    return PROVIDER_CAPABILITIES.get(provider, ProviderCapabilities())


def require_native_tool_capability(provider: str, tools: list[dict] | None) -> None:
    if tools and not provider_capabilities(provider).supports_tools:
        raise ToolCapabilityUnavailableError()


def sanitize_tool_request(
    provider: str,
    tools: list[dict] | None,
    tool_choice: str | dict | None,
    *, base_url: str | None = None, api_protocol: str = "chat_completions",
) -> tuple[list[dict] | None, str | dict | None, list[str]]:
    """Return provider-safe tool arguments or fail before unsupported tool I/O."""
    notes: list[str] = []
    safe_tools = tools
    safe_tool_choice = provider_tool_choice(base_url, api_protocol, tool_choice)

    require_native_tool_capability(provider, tools)
    if tool_choice is not None and safe_tool_choice is None:
        notes.append(f"{provider} 不支持当前 tool_choice 参数，已让模型自动选择工具")

    return safe_tools, safe_tool_choice, notes


def should_retry_without_tool_choice(error: BaseException) -> bool:
    """Detect provider errors caused specifically by tool_choice."""
    return provider_field_rejected(error, "tool_choice", "tool choice")


def normalize_retry_count(retry: int | None) -> int:
    """Treat retry as extra attempts, but always make at least one attempt.

    Existing call sites often pass retry=0 intending "do not retry"; the old
    gateway accidentally made zero attempts. This helper preserves the intent:
    retry=0 means one attempt, retry=1 means two attempts, etc.
    """
    try:
        value = int(retry or 0)
    except (TypeError, ValueError):
        value = 0
    return max(1, value + 1)


def request_meta(provider: str, model: str, notes: list[str]) -> dict[str, Any]:
    return {
        "provider": provider,
        "model": model,
        "adjustments": notes,
    }
