package com.siming.mobile.data.authoring

import androidx.room.withTransaction
import com.siming.mobile.data.cataloging.catalogingHash
import com.siming.mobile.data.local.*
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*

/** One transactional journal for all author deletions in the mobile replica. */
internal class LocalRecycleStore(private val database: SimingDatabase) {
    private val dao = database.dao()

    suspend fun capture(
        id: String = UUID.randomUUID().toString(), projectId: String, type: String, entityId: String,
        title: String, snapshot: RecycleSnapshot, now: Long = System.currentTimeMillis(),
    ): RecycleEntry {
        val project = dao.entity(ReplicaEntity.key(projectId, "project", projectId))
        val deletedAt = if (snapshot.syncable) dao.projectMutations(projectId).firstOrNull { it.mutationId == id }
            ?.clientModifiedAt?.let { Instant.parse(it).toEpochMilli() } ?: now else now
        val entry = RecycleEntry(id, projectId, type, entityId, title.ifBlank { type },
            project?.payload()?.text("title").orEmpty(), deletedAt, deletedAt + RECYCLE_RETENTION_MILLIS,
            Json.encodeToString(snapshot))
        dao.saveRecycleEntry(entry)
        return entry
    }

    suspend fun captureChanges(id: String, row: ReplicaEntity, before: List<ReplicaEntity>, beforeRuns: List<LocalCatalogingRun>) {
        val old = before.associateBy { it.key }
        val after = dao.projectPackageSnapshot(row.projectId).filter { it != old[it.key] }
        val runs = dao.catalogingRuns(row.projectId)
        val changedRuns = runs.filter { run -> beforeRuns.firstOrNull { it.id == run.id } != run }
        capture(id, row.projectId, row.entityType, row.entityId,
            row.payload().text("title").ifBlank { row.payload().text("name") },
            RecycleSnapshot(before = after.mapNotNull { old[it.key] }, after = after,
                beforeRuns = beforeRuns.filter { oldRun -> changedRuns.any { it.id == oldRun.id } }, afterRuns = changedRuns))
    }

    suspend fun requireInactive(projectId: String) {
        require(dao.catalogingRuns(projectId).none { it.status == "running" }) { "作品正在建档，请先取消任务再操作回收站" }
    }

    suspend fun restore(entryId: String, now: Long = System.currentTimeMillis()) = database.withTransaction {
        val entry = requireNotNull(dao.recycleEntry(entryId)) { "回收项不存在或已永久删除" }
        require(!entry.isExpired(now)) { "回收项已满 7 天，无法恢复" }
        if (entry.state == "restoring") return@withTransaction entry
        requireInactive(entry.projectId)
        val snapshot = entry.snapshot()
        require(snapshot.kind != "files") { "草稿请通过草稿回收服务恢复" }
        if (snapshot.kind == "project") {
            require(dao.allProjectReplicas(entry.projectId).isEmpty()) { "同一作品已重新导入，请先处理现有副本，不能覆盖恢复" }
            snapshot.projectPackage?.let { stored ->
                val file = java.io.File(stored.localFilePath)
                require(file.isFile && com.siming.mobile.data.sha256File(file) == stored.packageSha256) { "导入包不存在或已变化，不能恢复待同步作品" }
            }
            dao.saveEntities(snapshot.before)
            snapshot.mutations.forEach { dao.saveMutation(it.copy(state = if (it.state == "sending") "pending" else it.state)) }
            snapshot.conflicts.forEach { dao.saveConflict(it) }
            snapshot.projectPackage?.let { dao.saveProjectPackage(it.copy(syncState = if (it.syncState == "uploading") "pending" else it.syncState)) }
            snapshot.beforeRuns.forEach { dao.saveCatalogingRun(it) }
            dao.includeProject(entry.projectId)
        } else {
            if (snapshot.kind != "creation") require(dao.entity(ReplicaEntity.key(entry.projectId, "project", entry.projectId))?.operation == "upsert") { "请先恢复所属作品" }
            for (expected in snapshot.after) require(sameRecycleRecord(dao.entity(expected.key), expected)) { "删除后的资料已修改或存在同步冲突，无法覆盖恢复" }
            for (expected in snapshot.afterRuns) {
                val current = dao.catalogingRun(expected.id)
                require(current?.copy(syncState = expected.syncState) == expected) { "建档记录已变化，无法覆盖恢复" }
            }
            validateRestoredReferences(entry.projectId, snapshot.before)
            if (entry.entityType == "chapter_draft") {
                require(dao.projectSnapshot(entry.projectId).none { it.entityType == "chapter_draft" && it.entityId != entry.entityId && it.payload().text("status") in setOf("pending", "generated") }) { "已有待处理章节草稿，请先保存或丢弃后恢复" }
            }
            val old = snapshot.before.associateBy { it.key }
            val changed = snapshot.after.map { after ->
                val prior = old[after.key]
                val current = dao.entity(after.key)
                (prior ?: after.copy(operation = "delete", payloadJson = null, contentHash = catalogingHash("null")))
                    .copy(revision = current?.revision ?: after.revision, dirty = snapshot.syncable, localModifiedAt = now)
            }
            dao.saveEntities(changed)
            snapshot.beforeRuns.forEach { dao.saveCatalogingRun(it) }
            if (snapshot.syncable) {
                val commandId = UUID.randomUUID().toString()
                LocalAuthoringStore(database).command(entry.projectId, "recycle_restore",
                    buildJsonObject { put("entry_id", entry.id) }, buildJsonObject {}, changed, id = commandId)
                dao.updateRecycleEntry(entry.copy(state = "restoring", restoreMutationId = commandId))
            }
        }
        if (!snapshot.syncable) dao.deleteRecycleEntry(entryId)
        entry
    }

    private suspend fun validateRestoredReferences(projectId: String, restored: List<ReplicaEntity>) {
        val restoring = restored.filter { it.operation == "upsert" }.map { it.key }.toSet()
        for (row in restored.filter { it.operation == "upsert" }) {
            val payload = row.payload()
            val fields = mutableMapOf(
                "outline_node_id" to "outline", "chapter_id" to "chapter", "source_chapter_id" to "chapter",
                "target_chapter_id" to "chapter", "resolved_chapter_id" to "chapter", "character_id" to "character",
                "character_a_id" to "character", "character_b_id" to "character", "entry_id" to "world",
                "worldbuilding_entry_id" to "world", "source_entry_id" to "world", "target_entry_id" to "world",
            )
            if (row.entityType == "outline") fields["parent_id"] = "outline"
            if (row.entityType in setOf("character", "character_relation")) { fields["from"] = "character"; fields["to"] = "character" }
            if (row.entityType == "character_relation") {
                val from = payload.text("from").ifBlank { payload.text("character_a_id") }
                val to = payload.text("to").ifBlank { payload.text("character_b_id") }
                require(dao.projectSnapshot(projectId).none { current -> current.entityType == "character_relation" && current.entityId != row.entityId &&
                    current.payload().let { it.text("from").ifBlank { it.text("character_a_id") } == from && it.text("to").ifBlank { it.text("character_b_id") } == to }
                }) { "同一角色关系已经重新建立，不能重复恢复" }
            }
            for ((field, type) in fields) {
                val id = payload.text(field)
                if (id.isBlank()) continue
                val key = ReplicaEntity.key(projectId, type, id)
                require(key in restoring || dao.entity(key)?.operation == "upsert") { "关联资料已删除，请先恢复关联的${type}资料" }
            }
        }
    }

    suspend fun purge(entryId: String, sync: Boolean = true) = database.withTransaction {
        val entry = dao.recycleEntry(entryId) ?: return@withTransaction null
        val snapshot = entry.snapshot()
        val changes = mutableListOf<ReplicaEntity>()
        if (entry.state == "deleted" && entry.entityType == "chapter_draft") {
            snapshot.after.forEach { after ->
                val current = dao.entity(after.key)
                if (current != null && sameRecycleRecord(current, after)) {
                    val cleared = current.copy(operation = "delete", payloadJson = null, contentHash = catalogingHash("null"), dirty = sync && snapshot.syncable)
                    dao.saveEntity(cleared)
                    changes += cleared
                }
            }
        }
        if (sync && snapshot.syncable && entry.state == "deleted") LocalAuthoringStore(database).command(entry.projectId, "recycle_purge",
            buildJsonObject { put("entry_id", entry.id) }, buildJsonObject {}, changes)
        dao.deleteRecycleEntry(entryId)
        entry
    }
}
