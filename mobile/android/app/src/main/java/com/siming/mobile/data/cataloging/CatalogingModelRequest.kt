package com.siming.mobile.data.cataloging

import com.siming.mobile.data.network.DirectAgentStreamActivity
import com.siming.mobile.data.network.DirectAgentTurn
import com.siming.mobile.data.network.DirectApiClient
import com.siming.mobile.data.network.DirectApiConfig
import com.siming.mobile.data.agent.MobileFallbackUtf8ByteTokenCounter
import com.siming.mobile.data.agent.MobileGenerationModelBinding
import com.siming.mobile.data.agent.MobileRequestBudgetEnvelope
import com.siming.mobile.data.agent.MobileRequestTokenComponents
import com.siming.mobile.data.agent.MobileUtf8ByteTokenCounter
import com.siming.mobile.data.agent.buildMobileRequestBudget
import com.siming.mobile.data.agent.mobileCanonicalSha256
import kotlinx.serialization.json.*

/** Model settings are exported from the same PC cataloging contract as the tools. */
internal class CatalogingModelRequest(definition: JsonObject) {
    val idleTimeoutSeconds = definition.number("stream_idle_timeout_seconds")
    private val maxOutputTokens = definition.number("max_output_tokens")
    private val temperature = definition.getValue("temperature").jsonPrimitive.double
    private val taskType = definition.getValue("task_type").jsonPrimitive.content

    init {
        require(idleTimeoutSeconds > 0 && maxOutputTokens > 0) { "建档模型调用契约无效" }
    }

    /** Account for the serialized provider request, including the currently scoped tools. */
    fun budget(
        api: DirectApiClient,
        config: DirectApiConfig,
        messages: List<JsonObject>,
        tools: JsonArray,
    ): MobileRequestBudgetEnvelope {
        val effective = config.withContextWindowFallback()
        val output = minOf(effective.maxOutputTokens, maxOutputTokens)
        val counter = if (effective.contextCapacitySource == DirectApiConfig.CONTEXT_CAPACITY_FALLBACK)
            MobileFallbackUtf8ByteTokenCounter else MobileUtf8ByteTokenCounter
        val protocols = if (effective.protocol == DirectApiConfig.PROTOCOL_AUTO)
            listOf(DirectApiConfig.PROTOCOL_CHAT_COMPLETIONS, DirectApiConfig.PROTOCOL_RESPONSES)
        else listOf(effective.protocol)
        val payloadTokens = protocols.maxOf { protocol ->
            counter.countValue(api.agentRequestPayload(
                config = effective.copy(protocol = protocol), messages = messages, tools = tools,
                toolChoice = "auto", temperature = temperature, maxOutputTokens = output,
                extraBody = buildJsonObject { put("moshu_task_type", taskType) }, stream = true,
            ))
        }
        val messageTokens = counter.countValue(JsonArray(messages))
        val schemaTokens = counter.countValue(tools)
        return buildMobileRequestBudget(
            binding = MobileGenerationModelBinding(
                taskType = taskType, provider = "android_direct_api", modelName = effective.model,
                normalizedModel = effective.model, protocol = effective.protocol,
                contextWindowTokens = requireNotNull(effective.contextWindowTokens), maxOutputTokens = output,
                tokenCounterId = counter.counterId, capacityAssurance = counter.assurance,
                promptContractHash = mobileCanonicalSha256(JsonPrimitive(messages.firstOrNull()?.text("content").orEmpty())),
                toolSchemaHash = mobileCanonicalSha256(tools),
                configFingerprint = mobileCanonicalSha256(buildJsonObject {
                    put("base_url", effective.baseUrl); put("model", effective.model)
                    put("protocol", effective.protocol); put("context_window_tokens", effective.contextWindowTokens)
                    put("max_output_tokens", output); put("safety_margin_tokens", effective.safetyMarginTokens)
                }),
            ),
            counter = counter,
            components = MobileRequestTokenComponents(
                currentTurnLedgerTokens = messageTokens, toolSchemaTokens = schemaTokens,
                providerProtocolTokens = (payloadTokens - messageTokens - schemaTokens).coerceAtLeast(0),
            ),
            safetyMarginTokens = effective.safetyMarginTokens,
        )
    }

    suspend fun execute(
        api: DirectApiClient,
        config: DirectApiConfig,
        messages: List<JsonObject>,
        tools: JsonArray,
        onActivity: suspend (DirectAgentStreamActivity) -> Unit,
    ): DirectAgentTurn {
        budget(api, config, messages, tools).requireSendable()
        return api.streamAgentTurn(
            config = config,
            messages = messages,
            tools = tools,
            toolChoice = "auto",
            temperature = temperature,
            maxOutputTokens = minOf(config.maxOutputTokens, maxOutputTokens),
            extraBody = buildJsonObject { put("moshu_task_type", taskType) },
            streamIdleTimeoutMillis = idleTimeoutSeconds * 1000L,
            onActivity = onActivity,
        )
    }
}
