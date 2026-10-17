package com.siming.mobile.data.agent

import kotlinx.serialization.json.*

internal fun outlineToolPayload(args: JsonObject): JsonObject {
    if ("character_ids" !in args) return args
    val ids = args["character_ids"]
    require(ids is JsonArray && ids.all { it is JsonPrimitive && it.isString && it.content.isNotBlank() }) { "角色 ID 必须是字符串数组" }
    require(ids.distinct().size == ids.size) { "大纲角色关联不能重复" }
    // Explicit tool links replace links carried by an existing rich replica.
    return JsonObject((args - "character_ids") + ("characters" to JsonArray(ids.map { id ->
        buildJsonObject { put("character_id", id) }
    })))
}

/** Tool fields map to the same formal fields as the desktop character handler. */
internal fun characterToolPayload(args: JsonObject, current: JsonObject? = null): JsonObject {
    fun text(key: String) = (args[key] as? JsonPrimitive)?.contentOrNull.orEmpty().trim()
    val additions = buildList {
        listOf("说话风格" to "speech_style", "当前动机" to "motivation", "核心冲突" to "conflict").forEach { (label, key) ->
            text(key).takeIf(String::isNotEmpty)?.let { add("$label：$it") }
        }
    }.joinToString("\n")
    if (current != null && "background" !in args && additions.isEmpty()) return args
    val base = if ("background" in args || current == null) text("background")
        else (current["background"] as? JsonPrimitive)?.contentOrNull.orEmpty().trim()
    val separator = if (current == null) "\n" else "\n\n"
    val background = listOf(base, additions).filter(String::isNotEmpty).joinToString(separator).take(8000)
    return JsonObject(args + ("background" to JsonPrimitive(background)))
}

internal fun characterToolAiConfig(args: JsonObject, characterId: String, current: JsonObject? = null): JsonObject? {
    val config = args["ai_config"] as? JsonObject ?: JsonObject(emptyMap())
    fun text(key: String) = (config[key] as? JsonPrimitive)?.contentOrNull.orEmpty()
    val prompt = text("custom_system_prompt").ifBlank { (args["custom_system_prompt"] as? JsonPrimitive)?.contentOrNull.orEmpty() }.trim()
    if (config.isEmpty() && prompt.isEmpty() && "custom_system_prompt" !in args) return null
    val phrases = config["catchphrases"] ?: JsonArray(emptyList())
    require(phrases is JsonArray && phrases.all { it is JsonPrimitive && it.isString }) { "catchphrases 必须是字符串数组" }
    if (current != null) return buildJsonObject {
        current.forEach { (key, value) -> put(key, value) }
        put("character_id", characterId)
        listOf("tone_style" to 100, "verbosity" to 50, "emotion_tendency" to 100).forEach { (key, limit) ->
            text(key).takeIf(String::isNotEmpty)?.let { put(key, it.take(limit)) }
        }
        if ("catchphrases" in config) put("catchphrases", phrases)
        if (prompt.isNotEmpty()) put("custom_system_prompt", prompt)
    }
    return buildJsonObject {
        put("character_id", characterId)
        put("tone_style", text("tone_style").ifBlank { (args["tone_style"] as? JsonPrimitive)?.contentOrNull ?: "neutral" }.take(100))
        put("catchphrases", phrases)
        put("verbosity", text("verbosity").ifBlank { "moderate" }.take(50))
        put("emotion_tendency", text("emotion_tendency").ifBlank { "neutral" }.take(100))
        put("custom_system_prompt", prompt.takeIf(String::isNotEmpty)?.let(::JsonPrimitive) ?: JsonNull)
    }
}
