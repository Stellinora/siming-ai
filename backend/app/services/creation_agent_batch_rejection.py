"""Receipt a denied native batch before letting the same model correct it."""
from __future__ import annotations

import json

from app.services.conversation_context.errors import (
    ConversationContextError,
    ConversationContextErrorCode,
)
from app.services.conversation_context.tool_transactions import (
    NativeToolCall,
    NativeToolResult,
    ToolTransaction,
)
from app.services.creation_agent_native_protocol import build_creation_execution_receipt
from app.services.creation_agent_state import (
    CreationExecutionBindings,
    CreationTurnState,
    _durable_runtime_snapshot,
)
from app.services.workspace.native_tool_batch import (
    MAX_NATIVE_TOOL_NAME_REJECTIONS,
    NativeToolBatchNotOpen,
)


async def reject_creation_native_batch(
    state: CreationTurnState,
    bindings: CreationExecutionBindings,
    error: NativeToolBatchNotOpen,
    result: dict,
    iteration: int,
) -> None:
    """No business handler runs, including otherwise valid calls in this batch."""
    state.native_tool_name_rejections += 1
    state.native_transaction_count += 1
    number = state.native_transaction_count
    error.recovery_fits = state.native_tool_name_rejections < MAX_NATIVE_TOOL_NAME_REJECTIONS
    transaction = ToolTransaction(
        transaction_id=f"creation-transaction-{number}",
        assistant_message_id=f"creation-tool-assistant-{number}",
        assistant_content=str(result.get("content") or ""),
        assistant_reasoning_content=str(result.get("reasoning_content") or ""),
        assistant_provider_state=tuple(result.get("provider_state") or ()),
        calls=tuple(NativeToolCall(
            call_id=call["id"], name=call["function"]["name"],
            arguments_json=call["function"]["arguments"],
        ) for call in error.calls),
    )
    preview = transaction
    for call in transaction.calls:
        preview = preview.add_result(NativeToolResult(
            call_id=call.call_id,
            content=json.dumps(error.model_error_result(call.name), ensure_ascii=False),
        ))
    # Same conservative byte ceiling used by workspace rejection admission.
    budget = state.provider_request_budget()
    fits_capacity = bool(budget is not None and len(json.dumps(
        preview.native_messages(), ensure_ascii=False, allow_nan=False,
    ).encode("utf-8")) <= budget.tool_transaction_budget_tokens)
    error.recovery_fits = error.recovery_fits and fits_capacity
    receipts = []
    for call in transaction.calls:
        denied = error.model_error_result(call.name)
        content = json.dumps(denied, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        native_result, receipt = build_creation_execution_receipt(
            session_id=str(state.session.id), turn_execution_id=state.turn_execution_id,
            transaction_number=number, call=call, result=denied, model_content=content,
            read_tools=set(), write_tools=set(), write_success_statuses=set(),
        )
        transaction = transaction.add_result(native_result)
        receipts.append(receipt)
        state.tool_results.append(denied)
    state.pending_transaction_receipts[transaction.transaction_id] = tuple(receipts)
    state.tool_transactions.append(transaction.mark_delivered())
    state.protocol_messages.extend(transaction.native_messages())
    await state.persist_runtime_state(_durable_runtime_snapshot(state))
    message = (
        "模型选用了当前未开放的工具，整批未执行，正在重新选择…"
        if error.recovery_fits else (
            "工具拒绝回执超过当前模型剩余容量，本批次未执行；此前进度已保留。"
            if not fits_capacity else
            "模型连续选用未开放的工具，本轮已停止；此前进度已保留。"
        )
    )
    await bindings.emit_progress(
        state.on_event, state.progress_events, "tool_batch_rejected",
        message,
        {"reason": error.reason, "retryable": error.recovery_fits,
         "rejection_count": state.native_tool_name_rejections},
    )
    if not error.recovery_fits:
        raise ConversationContextError(
            (ConversationContextErrorCode.PROTOCOL_INVALID if fits_capacity else
             ConversationContextErrorCode.TOOL_TRANSACTION_OVER_CAPACITY),
            error.message,
            details={**error.details, "iteration": iteration + 1,
                     "termination_reason": "retry_limit" if fits_capacity else "capacity",
                     "native_tool_name_rejections": state.native_tool_name_rejections},
        )
