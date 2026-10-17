package com.siming.mobile.data.local

import com.siming.mobile.data.authoring.MobileRecycleFiles
import java.nio.file.Files
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class RecycleEntryTest {
    @Test fun deadlineIsExactly168HoursAndSerializationKeepsCompleteRecoveryData() {
        val row = ReplicaEntity("p|chapter|c", "p", "chapter", "c", 9, "upsert", "{\"content\":\"正文\"}", "h", "now", true, true)
        val snapshot = RecycleSnapshot(before = listOf(row), mutations = listOf(OutboxMutation("m", "p", "chapter", "c", "delete", 9, null, "now", sentPayloadHash = "sent")))
        val entry = RecycleEntry("id", "p", "chapter", "c", "章节", "作品", 1000, 1000 + RECYCLE_RETENTION_MILLIS, Json.encodeToString(snapshot))
        assertEquals(168L * 60 * 60 * 1000, RECYCLE_RETENTION_MILLIS)
        assertFalse(entry.isExpired(entry.expiresAt - 1))
        assertTrue(entry.isExpired(entry.expiresAt))
        assertEquals(snapshot, entry.snapshot())
    }

    @Test fun restoreNeverTreatsAnEditedOrConflictedLiveRecordAsItsExpectedPostDeleteState() {
        val row = ReplicaEntity("k", "p", "outline", "o", 1, "upsert", "{\"title\":\"卷\",\"a\":1}", "h", "now")
        assertTrue(sameRecycleRecord(row.copy(revision = 2, dirty = false, payloadJson = "{\"a\":1,\"title\":\"卷\"}"), row))
        assertTrue(sameRecycleRecord(row.copy(payloadJson = "{\"title\":\"卷\",\"a\":1,\"updated_at\":\"server-ack\"}"), row))
        assertFalse(sameRecycleRecord(row.copy(conflicted = true), row))
        assertFalse(sameRecycleRecord(row.copy(payloadJson = "{\"title\":\"修改\"}"), row))
        assertFalse(sameRecycleRecord(row, row.copy(operation = "delete")))
        assertFalse(sameRecycleRecord(row.copy(operation = "delete", conflicted = true), row.copy(operation = "delete")))
    }

    @Test fun retainedFilesAreScopedAndNeverEraseAnUpdatedJournal() {
        val root = Files.createTempDirectory("recycle-files-test").toFile()
        try {
            val folder = root.resolve("mobile-chapter-write-runs").apply { mkdirs() }
            val file = folder.resolve("test-draft.json")
            file.writeText("""{"project_id":"p","state":"generated","content":"原稿"}""")
            val store = MobileRecycleFiles(root)
            val snapshot = store.snapshot("p")
            assertEquals(1, snapshot.size)
            assertTrue(store.snapshot("other").isEmpty())
            file.writeText("""{"project_id":"p","state":"generated","content":"新稿"}""")
            assertTrue(runCatching { store.requireUnchanged(snapshot) }.isFailure)
            store.purgeUnchanged(snapshot)
            assertTrue(file.exists())
            assertTrue(runCatching { store.purgeUnchanged(mapOf("mobile-chapter-write-runs/../../outside.json" to "")) }.isFailure)
        } finally { root.deleteRecursively() }
    }
}
