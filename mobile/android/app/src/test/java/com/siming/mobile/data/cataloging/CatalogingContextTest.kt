package com.siming.mobile.data.cataloging

import com.siming.mobile.data.network.DirectApiClient
import com.siming.mobile.data.network.DirectApiConfig
import java.io.File
import kotlin.test.*
import kotlinx.serialization.json.*

class CatalogingContextTest {
    private val contract = CatalogingContract(Json.parseToJsonElement(
        File("src/main/assets/pc_workspace_prompt_contract.json").readText(),
    ).jsonObject)
    private val api = DirectApiClient()
    private val config = DirectApiConfig("local", "https://example.test/v1", "fixture-key", "local-model",
        DirectApiConfig.PROTOCOL_CHAT_COMPLETIONS, contextWindowTokens = 64_000)
    private val task = buildJsonObject {
        put("task", "为当前已保存章节建档"); put("project_id", "project-1"); put("job_id", "job-1")
        put("chapter_id", "chapter-1"); put("chapter_run_id", "run-1"); put("chapter_version", 1)
    }
    private val schemas = contract.schemasForPlan(false)
    private fun measure(messages: List<JsonObject>) = contract.modelRequest.budget(api, config, messages, schemas)
    private fun candidate(text: String) = CatalogCandidate("candidate-1", buildJsonObject {
        put("type", "chapter_summary"); put("summary_text", text)
    })
    private fun transaction(id: String, name: String, arguments: JsonObject, result: JsonObject) = listOf(
        buildJsonObject {
            put("role", "assistant"); put("content", "")
            put("tool_calls", buildJsonArray { add(buildJsonObject {
                put("id", id); put("type", "function"); put("function", buildJsonObject {
                    put("name", name); put("arguments", arguments.toString())
                })
            }) })
        },
        buildJsonObject { put("role", "tool"); put("tool_call_id", id); put("content", result.toString()) },
    )
    private fun read(history: CatalogingContext, id: String, name: String, arguments: JsonObject, data: JsonObject) {
        val result = buildJsonObject { put("tool", name); put("status", "ok"); put("data", data) }
        history.rememberRead(name, arguments, result)
        history.append(transaction(id, name, arguments, result))
    }
    private fun inflate(history: CatalogingContext) {
        repeat(32) { index -> history.append(transaction("save-$index", "save_external_cataloging_candidates",
            buildJsonObject { put("candidates", buildJsonArray { add(candidate("过时版本".repeat(500)).payload) }) },
            buildJsonObject { put("status", "ok"); put("data", "重复候选回执".repeat(500)) },
        )) }
    }
    private fun checkpoint(messages: List<JsonObject>) = Json.parseToJsonElement(messages[1].text("content")).jsonObject

    @Test fun `overflow replaces repeated receipts with complete current state and latest correction`() {
        val history = CatalogingContext(contract.systemPrompt, task, listOf(candidate("初始旧摘要")))
        val chapter = buildJsonObject { put("content", "完整章节正文🌙".repeat(350)) }
        val archive = buildJsonObject { put("background", "完整角色背景".repeat(150)); put("id", "hero") }
        read(history, "read-chapter", "get_next_external_cataloging_chapter", buildJsonObject { put("job_id", "job-1") }, chapter)
        repeat(2) { read(history, "read-hero-$it", "read_cataloging_archive", buildJsonObject { put("kind", "character"); put("ids", jsonStrings(listOf("hero"))) }, archive) }
        inflate(history)
        val rejected = buildJsonObject { put("invalid", "完整待修正参数") }
        val last = transaction("repair", "save_external_cataloging_candidates", rejected, buildJsonObject { put("status", "error"); put("detail", "保留最近工具错误") })
        history.append(last)
        val fullAudit = history.auditMessages.toList()
        val current = listOf(candidate("当前数据库的完整摘要"))
        val prepared = history.prepare(current, "character_update", listOf("缺少章级大纲"), ::measure)
        val state = checkpoint(prepared)
        assertEquals("cataloging_checkpoint.v1", state.text("schema"))
        assertEquals("job-1", state.text("job_id"))
        assertEquals("character_update", state.text("selected_type"))
        val reads = state.objects("source_reads")
        assertEquals(2, reads.size)
        assertEquals(chapter, reads.first().obj("result").obj("data"))
        assertEquals(archive, reads.last().obj("result").obj("data"))
        assertEquals(current.map(CatalogCandidate::toJson), state.obj("resume").objects("accepted_candidates"))
        assertEquals(listOf("缺少章级大纲"), state.obj("resume").strings("missing_required_items"))
        assertEquals(last, prepared.takeLast(2))
        assertEquals(fullAudit, history.auditMessages)
        assertTrue(measure(prepared).fitsCurrent)
        assertFalse(prepared.toString().contains("初始旧摘要"))
        assertFalse(prepared.toString().contains("过时版本"))

        history.append(transaction("updated", "save_external_cataloging_candidates", buildJsonObject {}, buildJsonObject { put("status", "ok") }))
        val updated = listOf(candidate("后续更新的完整摘要"))
        val next = history.prepare(updated, "chapter_link", emptyList(), ::measure)
        assertEquals(updated.map(CatalogCandidate::toJson), checkpoint(next).obj("resume").objects("accepted_candidates"))
        assertEquals(2, history.checkpoints.size)
        assertFalse(next.toString().contains("当前数据库的完整摘要"))
    }

    @Test fun `latest source read appears once and native tool transaction stays intact`() {
        val history = CatalogingContext(contract.systemPrompt, task, emptyList())
        inflate(history)
        val chapter = buildJsonObject { put("content", "只出现一次的完整原章") }
        read(history, "latest-read", "get_next_external_cataloging_chapter", buildJsonObject { put("include_content", true) }, chapter)
        val latest = history.auditMessages.takeLast(2)
        val prepared = history.prepare(emptyList(), null, listOf("缺少摘要"), ::measure)
        assertTrue(checkpoint(prepared).objects("source_reads").isEmpty())
        assertEquals(latest, prepared.takeLast(2))
        assertEquals(chapter, Json.parseToJsonElement(prepared.last().text("content")).jsonObject.obj("data"))
    }

    @Test fun `mandatory state overflow never truncates chapter or discards retained candidates`() {
        val history = CatalogingContext(contract.systemPrompt, task, emptyList())
        val chapter = buildJsonObject { put("content", "绝不能裁掉的正文".repeat(8_000)) }
        read(history, "large-chapter", "get_next_external_cataloging_chapter", buildJsonObject {}, chapter)
        val audit = history.auditMessages.toList()
        val current = listOf(candidate("已经保存的完整摘要"))
        val error = assertFailsWith<com.siming.mobile.data.agent.MobileConversationContextException> {
            history.prepare(current, null, emptyList(), ::measure)
        }
        assertEquals(com.siming.mobile.data.agent.MobileConversationContextErrorCode.REQUIRED_STATE_OVER_CAPACITY, error.code)
        assertTrue(error.message.orEmpty().contains("正文和候选已保留"))
        assertEquals(audit, history.auditMessages)
        assertEquals("已经保存的完整摘要", current.single().payload.text("summary_text"))
        assertTrue(history.checkpoints.isEmpty())
    }
}
