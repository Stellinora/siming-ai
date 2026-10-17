package com.siming.mobile.data.network

import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Uses the generated PC contract after the actual wire protocol is resolved. */
internal object ModelRequestPolicy {
    private val definition = Json.parseToJsonElement(MODEL_REQUEST_POLICY_JSON).jsonObject
    private val endpoints = definition.getValue("endpoints").jsonObject
    private val explicitThinkingFields = definition.getValue("explicit_thinking_fields")
        .jsonArray.map { it.jsonPrimitive.content }.toSet()

    private fun endpoint(config: DirectApiConfig, protocol: String): JsonObject? {
        val url = config.baseUrl.trim().toHttpUrlOrNull() ?: return null
        if (!url.isHttps || url.port != 443) return null
        return endpoints[url.host.removeSuffix(".")]?.jsonObject?.get(protocol)?.jsonObject
    }

    fun toolChoice(config: DirectApiConfig, requested: String?): String? =
        requested.takeUnless {
            endpoint(config, config.protocol)?.get("supports_tool_choice")?.jsonPrimitive?.boolean == false
        }

    fun extraBody(
        config: DirectApiConfig,
        protocol: String,
        extraBody: JsonObject?,
        textOnly: Boolean,
    ): JsonObject? {
        val payload = extraBody.orEmpty().filterKeys { !it.startsWith("moshu_") && !it.startsWith("local_cli_") }
        val mode = if (extraBody?.get("moshu_task_type")?.jsonPrimitive?.content == "cataloging") {
            "cataloging"
        } else if (textOnly) "text" else "tools"
        val policy = endpoint(config, protocol)
        val modes = policy?.get("non_thinking_modes")?.jsonArray.orEmpty().map { it.jsonPrimitive.content }
        val defaults = if (mode in modes && payload.keys.none { it in explicitThinkingFields }) {
            policy?.get("non_thinking_body")?.jsonObject.orEmpty()
        } else emptyMap()
        return (defaults + payload).takeIf { it.isNotEmpty() }?.let(::JsonObject)
    }
}
