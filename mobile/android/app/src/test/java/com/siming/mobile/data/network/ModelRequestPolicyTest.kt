package com.siming.mobile.data.network

import kotlin.test.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Test

class ModelRequestPolicyTest {
    private val cases = javaClass.getResourceAsStream("/model_request_policy_cases.json")!!
        .bufferedReader().use { Json.parseToJsonElement(it.readText()).jsonArray }
        .map { it.jsonObject }
    private val controlFields = setOf("thinking", "reasoning", "reasoning_effort", "enable_thinking", "thinking_budget")
    private val tools = Json.parseToJsonElement("""[{"type":"function","function":{"name":"read","parameters":{"type":"object"}}}]""").jsonArray
    private fun config(case: JsonObject) = DirectApiConfig(
        case.getValue("label").jsonPrimitive.content, case.getValue("url").jsonPrimitive.content,
        "fixture-key", case.getValue("model").jsonPrimitive.content, case.getValue("protocol").jsonPrimitive.content,
    )

    private fun assertBody(case: JsonObject, payload: JsonObject) {
        assertEquals(case.getValue("expected"), JsonObject(payload.filterKeys { it in controlFields }), case["id"].toString())
        assertFalse(payload.keys.any { it.startsWith("moshu_") || it.startsWith("local_cli_") })
    }

    private fun client(case: JsonObject, onPayload: (JsonObject) -> Unit): DirectApiClient {
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            val buffer = Buffer()
            request.body!!.writeTo(buffer)
            onPayload(Json.parseToJsonElement(buffer.readUtf8()).jsonObject)
            val event = if (case.getValue("protocol").jsonPrimitive.content == DirectApiConfig.PROTOCOL_RESPONSES) {
                """{"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}}"""
            } else {
                """{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}"""
            }
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body("data: $event\n\ndata: [DONE]\n\n".toResponseBody("text/event-stream".toMediaType())).build()
        }.build()
        return DirectApiClient(http, retryDelaysMillis = emptyList())
    }

    @Test fun `standalone agent wire requests match all PC policy cases`() = runBlocking {
        cases.forEach { case ->
            var calls = 0
            val api = client(case) { payload ->
                calls++
                assertBody(case, payload)
                assertEquals(case["tool_choice"], payload["tool_choice"] ?: JsonNull, case["id"].toString())
            }
            val result = api.streamAgentTurn(config(case),
                listOf(buildJsonObject { put("role", "user"); put("content", "fixture") }),
                if (case.getValue("text_only").jsonPrimitive.boolean) JsonArray(emptyList()) else tools,
                toolChoice = "required", extraBody = case.getValue("extra").jsonObject)
            assertEquals("ok", result.content)
            assertEquals(1, calls)
        }
    }

    @Test fun `standalone text serializers use the same protocol policy`() = runBlocking {
        cases.filter { it.getValue("text_only").jsonPrimitive.boolean }.forEach { case ->
            val api = client(case) { assertBody(case, it) }
            val config = config(case)
            val extra = case.getValue("extra").jsonObject
            assertBody(case, api.completeRequestPayload(config, config.protocol, "system", "fixture", 500, 0.2, extra))
            assertEquals("ok", api.completeResumable(config, "system", "fixture", extraBody = extra))
        }
    }
}
