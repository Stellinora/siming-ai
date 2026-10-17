package com.siming.mobile

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.siming.mobile.data.agent.characterToolPayload
import com.siming.mobile.data.agent.outlineToolPayload
import com.siming.mobile.data.authoring.LocalAuthoringStore
import com.siming.mobile.data.local.SimingDatabase
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WorkspaceToolPersistenceTest {
    @Test fun toolFieldsPersistWithoutGatewayAndConfigFailureRollsBackCharacter() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context, SimingDatabase::class.java).build()
        try {
            val store = LocalAuthoringStore(db)
            store.save("p", "project", "p", buildJsonObject { put("title", "独立测试") })
            val args = Json.parseToJsonElement("""{"name":"甲","speech_style":"轻声","ai_config":{"tone_style":"calm","custom_system_prompt":"轻声说话"}}""").jsonObject
            store.save("p", "character", "a", characterToolPayload(args))
            assertEquals("说话风格：轻声", store.read.requireEntity("p", "character", "a").getValue("background").jsonPrimitive.content)
            val config = store.read.records("p", "character_ai_config").single()
            assertEquals("a", config.getValue("character_id").jsonPrimitive.content)
            assertEquals("轻声说话", config.getValue("custom_system_prompt").jsonPrimitive.content)
            store.save("p", "outline", "o", buildJsonObject {
                put("title", "章"); put("node_type", "chapter")
                put("character_ids", JsonArray(listOf(JsonPrimitive("a"))))
            })
            assertEquals("a", store.read.records("p", "outline_node_character").single().getValue("character_id").jsonPrimitive.content)
            val oldOutline = store.read.requireEntity("p", "outline", "o")
            store.save("p", "outline", "o", JsonObject(oldOutline + outlineToolPayload(buildJsonObject {
                put("character_ids", JsonArray(emptyList()))
            })))
            assertTrue(store.read.records("p", "outline_node_character").isEmpty())
            val bad = JsonObject(args + ("ai_config" to buildJsonObject { put("catchphrases", 123) }))
            assertTrue(runCatching { store.save("p", "character", "bad", characterToolPayload(bad)) }.isFailure)
            assertTrue(store.read.records("p", "character").none { it["id"]?.jsonPrimitive?.content == "bad" })
            assertTrue(db.dao().pendingMutations(100).any { it.entityType == "character_ai_config" })
        } finally { db.close() }
    }
}
