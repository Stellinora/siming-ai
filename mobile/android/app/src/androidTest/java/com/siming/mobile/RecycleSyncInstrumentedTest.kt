package com.siming.mobile

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.siming.mobile.data.SimingRepository
import com.siming.mobile.data.authoring.LocalAuthoringStore
import com.siming.mobile.data.authoring.text
import com.siming.mobile.data.local.*
import com.siming.mobile.security.SecureTokenStore
import com.siming.mobile.security.StoredTokenPair
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Actual mobile HTTP/outbox execution against an isolated Gateway protocol fixture. */
@RunWith(AndroidJUnit4::class)
class RecycleSyncInstrumentedTest {
    @Test fun offlineDeleteAndRestorePreserveSnapshotAcrossLostReceiptOrPcConflict() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val tokens = SecureTokenStore(context); val originalTokens = tokens.read()
        try {
            for (conflict in listOf(false, true)) {
                val db = Room.inMemoryDatabaseBuilder(context, SimingDatabase::class.java).build()
                val server = MockWebServer()
                try {
                    val store = LocalAuthoringStore(db); val dao = db.dao(); val repo = SimingRepository(context, db)
                    store.save("recycle-sync-fixture", "project", "recycle-sync-fixture", buildJsonObject { put("title", "同步测试") })
                    store.save("recycle-sync-fixture", "character", "c", buildJsonObject { put("name", "原角色") })
                    dao.clearOutbox()
                    dao.projectPackageSnapshot("recycle-sync-fixture").forEach { dao.saveEntity(it.copy(revision = 1, dirty = false)) }
                    val before = dao.projectPackageSnapshot("recycle-sync-fixture")
                    repo.deleteEntity("recycle-sync-fixture", "character", "c")
                    val deleted = dao.projectPackageSnapshot("recycle-sync-fixture")
                    val recycle = dao.recycleEntries().single()
                    repo.restoreRecycleEntry(recycle.id)
                    val restoreId = dao.recycleEntry(recycle.id)!!.restoreMutationId!!
                    var remote = before
                    var firstRestore = true
                    var restoreCommitted = false
                    val requests = mutableListOf<Pair<String, String>>()
                    server.dispatcher = object : Dispatcher() {
                        override fun dispatch(request: RecordedRequest): MockResponse {
                            val path = request.requestUrl!!.encodedPath
                            val data: JsonElement = when {
                                path.endsWith("/sync/push") -> {
                                    val mutation = Json.parseToJsonElement(request.body.readUtf8()).jsonObject.getValue("mutations").jsonArray.single().jsonObject
                                    val id = mutation.text("mutation_id")
                                    if (mutation.text("operation") == "delete") {
                                        assertEquals(recycle.id, id)
                                        assertEquals("character", mutation.text("entity_type"))
                                        requests += "delete" to id; remote = deleted
                                    } else {
                                        val payload = mutation.getValue("payload").jsonObject
                                        assertEquals("authoring_command", mutation.text("entity_type"))
                                        assertEquals("recycle_restore", payload.text("command"))
                                        assertEquals(recycle.id, payload.getValue("arguments").jsonObject.text("entry_id"))
                                        requests += "restore" to id
                                        if (conflict) return MockResponse().setResponseCode(409).setBody("资料已在 PC 修改，不能覆盖恢复")
                                        remote = before; restoreCommitted = true
                                        if (firstRestore) { firstRestore = false; return MockResponse().setResponseCode(503).setBody("receipt lost") }
                                    }
                                    buildJsonObject {
                                        put("protocol_version", 1); put("cursor", 3)
                                        put("results", buildJsonArray { add(buildJsonObject { put("mutation_id", id); put("status", if (restoreCommitted) "duplicate" else "applied"); put("revision", 3) }) })
                                    }
                                }
                                path.endsWith("/sync/bootstrap") -> buildJsonObject {
                                    put("protocol_version", 1); put("cursor", 3); put("projects", buildJsonArray { add(JsonPrimitive("recycle-sync-fixture")) })
                                    put("entities", JsonArray(remote.map { row -> buildJsonObject {
                                        put("project_id", row.projectId); put("entity_type", row.entityType); put("entity_id", row.entityId)
                                        put("operation", row.operation); put("revision", 3); put("content_hash", row.contentHash); put("server_modified_at", row.serverModifiedAt)
                                        row.payloadJson?.let { put("payload", Json.parseToJsonElement(it)) }
                                    } }))
                                }
                                path.endsWith("/sync/conflicts") -> JsonArray(emptyList())
                                path.endsWith("/sync/pull") -> buildJsonObject { put("protocol_version", 1); put("from_cursor", 0); put("next_cursor", 3); put("has_more", false); put("changes", JsonArray(emptyList())) }
                                else -> error("Unexpected request $path")
                            }
                            return MockResponse().setHeader("Content-Type", "application/json").setBody(buildJsonObject { put("code", 200); put("message", "ok"); put("data", data) }.toString())
                        }
                    }
                    server.start()
                    tokens.save(StoredTokenPair("fixture", "2099-01-01T00:00:00Z", "fixture", "2099-01-01T00:00:00Z"))
                    dao.saveConnection(GatewayConnection(baseUrl = server.url("/").toString().trimEnd('/'), gatewayName = "fixture", gatewayFingerprint = "fixture", deviceId = "fixture", deviceRole = "owner", protocolVersion = 1))
                    assertTrue(runCatching { repo.syncNow() }.isFailure)
                    assertEquals("restoring", dao.recycleEntry(recycle.id)!!.state)
                    assertEquals("原角色", store.read.requireEntity("recycle-sync-fixture", "character", "c").text("name"))
                    assertTrue(dao.cursor()!!.lastError!!.isNotBlank())
                    if (!conflict) {
                        repo.syncNow()
                        assertNull(dao.recycleEntry(recycle.id))
                        assertEquals(0, dao.pendingMutationCount())
                        assertEquals(listOf("delete" to recycle.id, "restore" to restoreId, "restore" to restoreId), requests)
                    } else {
                        assertNotNull(dao.recycleEntry(recycle.id))
                        assertEquals(restoreId, dao.projectMutations("recycle-sync-fixture").single().mutationId)
                    }
                } finally { server.shutdown(); db.close() }
            }
        } finally { if (originalTokens == null) tokens.clear() else tokens.save(originalTokens) }
    }
}
