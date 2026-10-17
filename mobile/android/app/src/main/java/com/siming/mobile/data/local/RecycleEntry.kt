package com.siming.mobile.data.local

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

const val RECYCLE_RETENTION_MILLIS: Long = 7L * 24 * 60 * 60 * 1000

/** List projection deliberately excludes full novels and recovery payloads. */
data class RecycleEntrySummary(
    val id: String,
    val projectId: String,
    val entityType: String,
    val title: String,
    val projectTitle: String,
    val deletedAt: Long,
    val expiresAt: Long,
    val state: String,
)

@Entity(tableName = "recycle_entries", indices = [Index(value = ["expiresAt"]), Index(value = ["projectId"])])
data class RecycleEntry(
    @PrimaryKey val id: String,
    val projectId: String,
    val entityType: String,
    val entityId: String,
    val title: String,
    val projectTitle: String,
    val deletedAt: Long,
    val expiresAt: Long,
    val snapshotJson: String,
    val state: String = "deleted",
    val restoreMutationId: String? = null,
) {
    fun isExpired(now: Long) = now >= expiresAt
    internal fun snapshot(): RecycleSnapshot = Json.decodeFromString(snapshotJson)
}

/** The deletion transaction owns this change set; it is never a second live replica. */
@Serializable
internal data class RecycleSnapshot(
    val kind: String = "entity",
    val syncable: Boolean = true,
    val before: List<ReplicaEntity> = emptyList(),
    val after: List<ReplicaEntity> = emptyList(),
    val beforeRuns: List<LocalCatalogingRun> = emptyList(),
    val afterRuns: List<LocalCatalogingRun> = emptyList(),
    val mutations: List<OutboxMutation> = emptyList(),
    val conflicts: List<LocalConflict> = emptyList(),
    val projectPackage: StoredProjectPackage? = null,
    val files: Map<String, String> = emptyMap(),
)

internal fun sameRecycleRecord(current: ReplicaEntity?, expected: ReplicaEntity?): Boolean =
    if (current?.conflicted == true) false
    else if (expected == null || expected.operation == "delete") current == null || current.operation == "delete"
    else current != null && current.operation == expected.operation &&
        current.payloadJson?.let { Json.parseToJsonElement(it).jsonObject - "updated_at" } ==
            expected.payloadJson?.let { Json.parseToJsonElement(it).jsonObject - "updated_at" }

internal fun sameRecycledDraft(current: JsonObject, original: JsonObject): Boolean =
    current["state"]?.jsonPrimitive?.contentOrNull in setOf("discarded", original["state"]?.jsonPrimitive?.contentOrNull) &&
        JsonObject(current - setOf("state", "updated_at")) == JsonObject(original - setOf("state", "updated_at"))
