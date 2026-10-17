"""Completion boundaries shared by native API transports."""
from ..core.exceptions import LLMIncompleteResponseError


def require_complete_response(reason: str | None, max_tokens: int | None = None) -> None:
    complete = {
        "stop", "tool_calls", "function_call", "completed", "end_turn", "stop_sequence", "tool_use",
    }
    if reason and str(reason).lower() not in complete:
        raise LLMIncompleteResponseError(str(reason), max_tokens)
