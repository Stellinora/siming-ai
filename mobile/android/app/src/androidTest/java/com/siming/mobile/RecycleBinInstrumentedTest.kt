package com.siming.mobile

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.siming.mobile.data.SimingRepository
import com.siming.mobile.data.authoring.*
import com.siming.mobile.data.local.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RecycleBinInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private fun database() = Room.inMemoryDatabaseBuilder(context, SimingDatabase::class.java).build()
    private fun obj(vararg fields: Pair<String, String>) = buildJsonObject { fields.forEach { (k, v) -> put(k, v) } }

    @Test fun relationshipReplacementRetainsIdsAndRecyclesOnlyRemovedEdges() = runBlocking {
        val db = database()
        try {
            val store = LocalAuthoringStore(db); val dao = db.dao()
            store.save("p", "project", "p", obj("title" to "关系"))
            listOf("a", "b", "c").forEach { store.save("p", "character", it, obj("name" to it)) }
            fun relation(target: String, description: String) = obj("target_character_id" to target, "description" to description)
            store.replaceRelationships("p", "a", JsonArray(listOf(relation("b", "旧关系"), relation("c", "将移除"))))
            val original = store.read.relationshipNetwork("p").getValue("edges").jsonArray.map { it.jsonObject }
            val originalId = original.single { it.text("to") == "b" }.text("id")
            store.replaceRelationships("p", "a", JsonArray(listOf(relation("b", "已更新"))))
            val entry = dao.recycleEntries().single()
            val current = store.read.relationshipNetwork("p").getValue("edges").jsonArray.single().jsonObject
            assertEquals(originalId, current.text("id"))
            assertEquals("已更新", current.text("description"))
            LocalRecycleStore(db).restore(entry.id)
            val restored = store.read.relationshipNetwork("p").getValue("edges").jsonArray.map { it.jsonObject }
            assertEquals(2, restored.size)
            assertEquals("已更新", restored.single { it.text("to") == "b" }.text("description"))
            assertEquals("将移除", restored.single { it.text("to") == "c" }.text("description"))
        } finally { db.close() }
    }

    @Test fun chapterDeleteRestorePreservesRelationsAndQueuesStableOrderedRecovery() = runBlocking {
        val db = database()
        try {
            val store = LocalAuthoringStore(db); val recycle = LocalRecycleStore(db); val dao = db.dao()
            store.save("p", "project", "p", obj("title" to "回收测试"))
            store.save("p", "chapter", "c", obj("title" to "章", "content" to "唯一正文"))
            val before = dao.projectPackageSnapshot("p").filter { it.entityType != "project" }.associate { it.key to it.payloadJson }
            store.delete("p", "chapter", "c")
            val entry = dao.recycleEntries().single()
            assertEquals(RECYCLE_RETENTION_MILLIS, entry.expiresAt - entry.deletedAt)
            assertEquals(entry.id, dao.projectMutations("p").last().mutationId)
            assertEquals("delete", dao.entity(ReplicaEntity.key("p", "chapter", "c"))!!.operation)
            recycle.restore(entry.id)
            before.forEach { (key, payload) -> assertEquals(payload, dao.entity(key)!!.payloadJson) }
            val restored = dao.recycleEntry(entry.id)!!
            assertEquals("restoring", restored.state)
            val command = dao.projectMutations("p").last()
            assertEquals(restored.restoreMutationId, command.mutationId)
            assertEquals("recycle_restore", Json.parseToJsonElement(command.payloadJson!!).jsonObject.text("command"))
            // The recovery copy survives a failed/uncertain sync until the stable command is acknowledged.
            recycle.restore(entry.id)
            assertEquals(command.mutationId, dao.projectMutations("p").last().mutationId)
            store.acknowledge(command)
            assertNull(dao.recycleEntry(entry.id))
        } finally { db.close() }
    }

    @Test fun changedSurvivingRelationRejectsWholeRestoreAndKeepsSnapshot() = runBlocking {
        val db = database()
        try {
            val store = LocalAuthoringStore(db); val dao = db.dao()
            store.save("p", "project", "p", obj("title" to "冲突测试"))
            store.save("p", "outline", "o", obj("title" to "章纲", "node_type" to "chapter"))
            store.save("p", "chapter", "c", obj("title" to "章", "content" to "正文", "outline_node_id" to "o"))
            store.delete("p", "outline", "o")
            val entry = dao.recycleEntries().single()
            store.save("p", "chapter", "c", obj("content" to "删除后作者修改"))
            assertTrue(runCatching { LocalRecycleStore(db).restore(entry.id) }.isFailure)
            assertEquals("delete", dao.entity(ReplicaEntity.key("p", "outline", "o"))!!.operation)
            assertEquals("删除后作者修改", store.read.requireEntity("p", "chapter", "c").text("content"))
            assertNotNull(dao.recycleEntry(entry.id))
        } finally { db.close() }
    }

    @Test fun expiryAndPermanentDeleteDoNotRestoreDataOrLeaveRecoverableSnapshots() = runBlocking {
        val db = database()
        try {
            val store = LocalAuthoringStore(db); val dao = db.dao(); val recycle = LocalRecycleStore(db)
            store.save("p", "project", "p", obj("title" to "期限"))
            store.save("p", "world", "w", obj("name" to "故城", "category" to "location"))
            store.delete("p", "world", "w")
            val entry = dao.recycleEntries().single()
            assertTrue(runCatching { recycle.restore(entry.id, now = entry.expiresAt) }.isFailure)
            recycle.purge(entry.id)
            assertNull(dao.recycleEntry(entry.id))
            assertEquals("delete", dao.entity(ReplicaEntity.key("p", "world", "w"))!!.operation)
            assertTrue(runCatching { recycle.restore(entry.id) }.isFailure)
            recycle.purge(entry.id) // Idempotent permanent deletion.
            Unit
        } finally { db.close() }
    }

    @Test fun discardedReplicaDraftIsRecoverableButNeverOverwritesANewerPendingDraft() = runBlocking {
        val db = database()
        try {
            val store = LocalAuthoringStore(db); val dao = db.dao()
            store.save("p", "project", "p", obj("title" to "草稿"))
            fun draft(id: String) = ReplicaEntity(ReplicaEntity.key("p", "chapter_draft", id), "p", "chapter_draft", id, 0, "upsert",
                obj("id" to id, "project_id" to "p", "status" to "pending", "title" to "未保存", "content" to "草稿全文").toString(), "hash", "now")
            dao.saveEntity(draft("d"))
            store.closeReplicaDraft("p", "d", "discarded")
            val entry = dao.recycleEntries().single()
            dao.saveEntity(draft("new"))
            assertTrue(runCatching { LocalRecycleStore(db).restore(entry.id) }.isFailure)
            assertEquals("discarded", store.read.requireEntity("p", "chapter_draft", "d").text("status"))
            LocalRecycleStore(db).purge(entry.id)
            assertNull(dao.entity(ReplicaEntity.key("p", "chapter_draft", "d"))!!.payloadJson)
            assertEquals("pending", store.read.requireEntity("p", "chapter_draft", "new").text("status"))
        } finally { db.close() }
    }

    @Test fun runningCatalogingBlocksDeletionAndReimportBlocksLocalProjectRestore() = runBlocking {
        val db = database()
        try {
            val store = LocalAuthoringStore(db); val dao = db.dao(); val repository = SimingRepository(context, db)
            store.save("p", "project", "p", obj("title" to "活跃任务"))
            val run = LocalCatalogingRun("r", "p", "c", 1, "h", sourceFingerprint = "h", sourceJson = "[]", model = "fixture", createdAt = "now", updatedAt = "now")
            dao.saveCatalogingRun(run)
            assertTrue(runCatching { repository.deleteProject("p") }.isFailure)
            assertTrue(dao.recycleEntries().isEmpty())
            dao.saveCatalogingRun(run.copy(status = "cancelled"))
            repository.deleteProject("p")
            val entry = dao.recycleEntries().single()
            store.save("p", "project", "p", obj("title" to "新的导入"))
            assertTrue(runCatching { repository.restoreRecycleEntry(entry.id) }.isFailure)
            assertEquals("新的导入", store.read.requireEntity("p", "project", "p").text("title"))
        } finally { db.close() }
    }
}
