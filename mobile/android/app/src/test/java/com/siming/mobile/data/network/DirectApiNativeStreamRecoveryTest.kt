package com.siming.mobile.data.network

import java.io.IOException
import java.net.Proxy
import java.util.concurrent.TimeUnit
import kotlin.test.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

class DirectApiNativeStreamRecoveryTest {
    private val messages = listOf(buildJsonObject { put("role", "user"); put("content", "给已保存章节建档") })
    private val tools = Json.parseToJsonElement("""[{"type":"function","function":{"name":"save_candidates","parameters":{"type":"object","properties":{}}}}]""").jsonArray
    private fun client(delays: List<Long> = listOf(0, 0)) = DirectApiClient(
        client = OkHttpClient.Builder().proxy(Proxy.NO_PROXY).retryOnConnectionFailure(false)
            .readTimeout(2, TimeUnit.SECONDS).callTimeout(5, TimeUnit.SECONDS).build(),
        allowCleartextForTests = true, retryDelaysMillis = delays,
    )
    private fun config(server: MockWebServer, protocol: String) = DirectApiConfig(
        "fixture", server.url("/").toString(), "fixture-key", "fixture-model", protocol,
    )
    private fun sse(vararg events: String) = events.joinToString("") { "data: $it\n\n" }
    private fun response(body: String) = MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body)
    private fun interrupted(protocol: String) = if (protocol == DirectApiConfig.PROTOCOL_RESPONSES) sse(
        """{"type":"response.output_text.delta","delta":"丢弃的半段说明"}""",
        """{"type":"response.output_item.added","item":{"type":"function_call","id":"item-old","call_id":"call-old","name":"save_candidates","arguments":""}}""",
        """{"type":"response.function_call_arguments.delta","item_id":"item-old","delta":"{\"old\":"}""",
    ) else sse(
        """{"choices":[{"delta":{"content":"丢弃的半段说明"},"finish_reason":null}]}""",
        """{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-old","function":{"name":"save_candidates","arguments":"{\"old\":"}}]},"finish_reason":null}]}""",
    )
    private fun completed(protocol: String) = if (protocol == DirectApiConfig.PROTOCOL_RESPONSES) sse(
        """{"type":"response.output_text.delta","delta":"完整说明"}""",
        """{"type":"response.completed","response":{"status":"completed","output":[{"type":"reasoning","id":"r-new","encrypted_content":"opaque-new"},{"type":"function_call","call_id":"call-new","name":"save_candidates","arguments":"{\"new\":true}"}]}}""",
    ) else sse(
        """{"choices":[{"delta":{"reasoning_content":"本次有效思考","content":"完整说明"},"finish_reason":null}]}""",
        """{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-new","function":{"name":"save_candidates","arguments":"{\"new\":true}"}}]},"finish_reason":"tool_calls"}]}""",
        "[DONE]",
    )

    @Test fun `interrupted native response restarts original request and delivers only complete replacement`() = runBlocking {
        listOf(DirectApiConfig.PROTOCOL_CHAT_COMPLETIONS, DirectApiConfig.PROTOCOL_RESPONSES).forEach { protocol ->
            MockWebServer().use { server ->
                server.enqueue(response(interrupted(protocol)))
                server.enqueue(response(completed(protocol)))
                server.start()
                val content = mutableListOf<String>()
                val activities = mutableListOf<DirectAgentStreamActivity>()
                val turn = client().streamAgentTurn(config(server, protocol), messages, tools,
                    onContentDelta = { content += it }, onActivity = { activities += it })
                assertEquals(listOf("完整说明"), content)
                assertEquals("call-new", turn.toolCalls.single().id)
                assertEquals(buildJsonObject { put("new", true) }, turn.toolCalls.single().arguments)
                assertTrue(DirectAgentStreamActivity.TOOL_ARGUMENTS in activities)
                val original = server.takeRequest().body.readUtf8()
                assertEquals(original, server.takeRequest().body.readUtf8())
                assertFalse(original.contains("SIMING_RESUME"))
                assertFalse(original.contains("丢弃的半段说明"))
                assertEquals(2, server.requestCount)
                if (protocol == DirectApiConfig.PROTOCOL_RESPONSES) {
                    assertTrue(turn.assistantMessage.getValue("provider_state").toString().contains("opaque-new"))
                } else assertEquals("本次有效思考", turn.reasoningContent)
            }
        }
    }

    @Test fun `exhausted native retries do not publish partial content or calls`() = runBlocking {
        MockWebServer().use { server ->
            repeat(3) { server.enqueue(response(interrupted(DirectApiConfig.PROTOCOL_CHAT_COMPLETIONS))) }
            server.start()
            val content = mutableListOf<String>()
            assertFailsWith<IOException> {
                client().streamAgentTurn(config(server, DirectApiConfig.PROTOCOL_CHAT_COMPLETIONS), messages, tools,
                    onContentDelta = { content += it })
            }
            assertTrue(content.isEmpty())
            assertEquals(3, server.requestCount)
            val original = server.takeRequest().body.readUtf8()
            repeat(2) { assertEquals(original, server.takeRequest().body.readUtf8()) }
        }
    }

    @Test fun `explicit terminal and malformed native responses are not retried`() = runBlocking {
        val protocol = DirectApiConfig.PROTOCOL_CHAT_COMPLETIONS
        val cases = listOf(
            protocol to sse("""{"choices":[{"delta":{"content":"片段"},"finish_reason":"length"}]}"""),
            protocol to sse("""{"choices":[{"delta":{"refusal":"拒绝"},"finish_reason":"stop"}]}"""),
            protocol to sse("""{"choices":[{"delta":{"content":"片段"},"finish_reason":"content_filter"}]}"""),
            protocol to sse("""{"choices":[{"delta":{"content":"片段","tool_calls":[{"index":0,"id":"bad","function":{"name":"save_candidates","arguments":"{"}}]},"finish_reason":"tool_calls"}]}""", "[DONE]"),
            DirectApiConfig.PROTOCOL_RESPONSES to sse("""{"type":"response.output_text.delta","delta":"片段"}""", """{"type":"response.failed","response":{"status":"failed","error":{"message":"upstream failed"}}}"""),
        )
        cases.forEach { (transport, body) -> MockWebServer().use { server ->
            server.enqueue(response(body)); server.start()
            val content = mutableListOf<String>()
            assertFailsWith<DirectNativeToolProtocolException> {
                client().streamAgentTurn(config(server, transport), messages, tools, onContentDelta = { content += it })
            }
            assertTrue(content.isEmpty())
            assertEquals(1, server.requestCount)
        } }
    }

    @Test fun `native retries preserve cancellation and permanent HTTP errors`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response(interrupted(DirectApiConfig.PROTOCOL_CHAT_COMPLETIONS))); server.start()
            val activity = CompletableDeferred<Unit>()
            val work = launch {
                client(listOf(60_000)).streamAgentTurn(config(server, DirectApiConfig.PROTOCOL_CHAT_COMPLETIONS), messages, tools,
                    onActivity = { activity.complete(Unit) })
                fail("Cancelled response must not be returned")
            }
            withTimeout(1_000) { activity.await() }
            delay(50)
            withTimeout(1_000) { work.cancelAndJoin() }
            assertEquals(1, server.requestCount)
        }
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"message":"invalid key"}}""")); server.start()
            assertFailsWith<DirectApiHttpException> {
                client().streamAgentTurn(config(server, DirectApiConfig.PROTOCOL_CHAT_COMPLETIONS), messages, tools)
            }
            assertEquals(1, server.requestCount)
        }
    }

    @Test fun `transient HTTP retry does not retry a completed response when its consumer fails`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":{"message":"temporarily unavailable"}}"""))
            server.enqueue(response(completed(DirectApiConfig.PROTOCOL_CHAT_COMPLETIONS)))
            server.start()
            val failure = assertFailsWith<IOException> {
                client().streamAgentTurn(config(server, DirectApiConfig.PROTOCOL_CHAT_COMPLETIONS), messages, tools,
                    onContentDelta = { throw IOException("consumer failed") })
            }
            assertEquals("consumer failed", failure.message)
            assertEquals(2, server.requestCount)
            assertEquals(server.takeRequest().body.readUtf8(), server.takeRequest().body.readUtf8())
        }
    }
}
