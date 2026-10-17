package com.siming.mobile.data.authoring

import java.io.File
import kotlinx.serialization.json.*

/** Only private author journals may be retained or erased by the recycle bin. */
internal class MobileRecycleFiles(private val root: File) {
    private val directories = setOf("mobile-chapter-write-runs", "mobile-outline-drafts", "mobile-assistant-conversations")

    fun snapshot(projectId: String): Map<String, String> = buildMap {
        directories.forEach { directory ->
            File(root, directory).listFiles { file -> file.isFile && file.extension == "json" }.orEmpty().forEach { file ->
                val content = file.readText(Charsets.UTF_8)
                val data = runCatching { Json.parseToJsonElement(content).jsonObject }.getOrNull()
                if (data?.get("project_id")?.jsonPrimitive?.contentOrNull == projectId) put("$directory/${file.name}", content)
            }
        }
    }

    fun draft(projectId: String, type: String, id: String): Map<String, String> {
        val directory = if (type == "chapter_draft") "mobile-chapter-write-runs" else "mobile-outline-drafts"
        return snapshot(projectId).filterKeys { it == "$directory/$id.json" }
    }

    fun requireUnchanged(files: Map<String, String>) {
        files.forEach { (name, content) ->
            val file = resolve(name)
            require(!file.exists() || file.readText(Charsets.UTF_8) == content) { "草稿或会话已经变化，无法覆盖恢复" }
        }
    }

    fun purgeUnchanged(files: Map<String, String>) {
        files.forEach { (name, content) ->
            val file = resolve(name)
            if (file.isFile && file.readText(Charsets.UTF_8) == content) check(file.delete()) { "无法清理已删除的本机文件" }
        }
    }

    fun restoreMissing(files: Map<String, String>) {
        requireUnchanged(files)
        files.forEach { (name, content) ->
            val file = resolve(name)
            if (!file.exists()) {
                file.parentFile?.mkdirs()
                val temporary = File(file.parentFile, ".${file.name}.${java.util.UUID.randomUUID()}.tmp")
                try {
                    temporary.writeText(content, Charsets.UTF_8)
                    java.nio.file.Files.move(temporary.toPath(), file.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE)
                } finally { temporary.delete() }
            }
        }
    }

    fun purgeDiscarded(files: Map<String, String>) {
        files.forEach { (name, original) ->
            val file = resolve(name)
            val current = file.takeIf { it.isFile }?.readText()?.let { Json.parseToJsonElement(it).jsonObject }
            if (current != null && current["state"]?.jsonPrimitive?.contentOrNull == "discarded" &&
                com.siming.mobile.data.local.sameRecycledDraft(current, Json.parseToJsonElement(original).jsonObject)) {
                check(file.delete()) { "无法清理已丢弃的草稿" }
            }
        }
    }

    private fun resolve(name: String): File {
        val parts = name.split('/')
        require(parts.size == 2 && parts[0] in directories && parts[1].endsWith(".json") && !parts[1].contains('\\'))
        val file = File(root, name).canonicalFile
        require(file.toPath().startsWith(root.canonicalFile.toPath()) && file.parentFile == File(root, parts[0]).canonicalFile) { "无效的回收文件路径" }
        return file
    }
}
