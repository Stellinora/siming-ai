package com.siming.mobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.MenuBook
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp

internal data class ProjectPrimaryDestination(
    val key: String, val label: String, val icon: ImageVector, val defaultSection: String,
)

internal val projectReferenceSections = listOf(
    "character" to "角色", "world" to "世界观", "foreshadowing" to "伏笔", "governance" to "叙事治理",
)

internal val projectPrimaryDestinations = listOf(
    ProjectPrimaryDestination("chapter", "写作", Icons.AutoMirrored.Outlined.MenuBook, "chapter"),
    ProjectPrimaryDestination("outline", "大纲", Icons.Outlined.AccountTree, "outline"),
    ProjectPrimaryDestination("assistant", "助手", Icons.Outlined.AutoAwesome, "assistant"),
    ProjectPrimaryDestination("reference", "资料", Icons.Outlined.FolderOpen, "reference"),
)

internal fun projectPrimaryKey(section: String): String = when (section) {
    "chapter", "outline", "assistant" -> section
    else -> "reference"
}

internal data class ProjectPage(val key: String, val title: String, val description: String, val icon: ImageVector)
internal val projectPages = listOf(
    ProjectPage("chapter", "章节与正文", "写作、编辑、版本历史", Icons.AutoMirrored.Outlined.MenuBook),
    ProjectPage("outline", "大纲规划", "卷章结构与 AI 草稿", Icons.Outlined.AccountTree),
    ProjectPage("assistant", "项目助手", "对话、规划与 AI 写作", Icons.Outlined.AutoAwesome),
    ProjectPage("project", "作品信息", "书名与简介", Icons.Outlined.Edit),
    ProjectPage("character", "角色", "人物设定与关系", Icons.Outlined.Person),
    ProjectPage("world", "世界观", "地点、势力与世界规则", Icons.Outlined.Public),
    ProjectPage("foreshadowing", "伏笔", "铺设、回收与状态", Icons.Outlined.Link),
    ProjectPage("governance", "叙事治理", "连续性、因果与故事承诺", Icons.Outlined.FactCheck),
    ProjectPage("tools", "建档与导出", "建档任务、进度、导出作品", Icons.Outlined.Inventory2),
    ProjectPage("recycle", "回收站", "恢复删除的数据、永久删除", Icons.Outlined.DeleteOutline),
)

internal fun searchProjectPages(query: String) = projectPages.filter {
    query.isBlank() || it.title.contains(query.trim(), true) || it.description.contains(query.trim(), true)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ProjectPageDirectory(onDismiss: () -> Unit, onSelected: (String) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDismiss, modifier = Modifier.fillMaxHeight(0.92f), sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Text("全部页面", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(horizontal = 20.dp))
        OutlinedTextField(query, { query = it }, placeholder = { Text("搜索页面，例如：建档、世界观、回收站") },
            leadingIcon = { Icon(Icons.Outlined.Search, null) }, singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(16.dp))
        LazyColumn(Modifier.fillMaxWidth().weight(1f), contentPadding = PaddingValues(bottom = 24.dp)) {
            searchProjectPages(query).forEach { page ->
                item(key = page.key) { WorkspaceActionRow(page.title, page.description, page.icon, { onSelected(page.key) }) }
            }
            if (searchProjectPages(query).isEmpty()) item { Text("未找到页面", Modifier.padding(20.dp)) }
        }
    }
}

@Composable
internal fun ProjectPrimaryNavigation(selected: String, onSelected: (String) -> Unit) {
    NavigationBar(containerColor = SimingPaperWarm, tonalElevation = 0.dp) {
        projectPrimaryDestinations.forEach { destination ->
            NavigationBarItem(selected = projectPrimaryKey(selected) == destination.key,
                onClick = { onSelected(destination.defaultSection) },
                icon = { Icon(destination.icon, null) }, label = { Text(destination.label) })
        }
    }
}

@Composable
internal fun ProjectReferenceHome(onSelected: (String) -> Unit, onEditProject: () -> Unit) {
    LazyColumn(contentPadding = PaddingValues(16.dp, 16.dp, 16.dp, 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
            Text("故事资料", style = MaterialTheme.typography.headlineSmall)
            Text("把人物、规则与故事线索放在一起。", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        item {
            OutlinedCard {
                WorkspaceActionRow("作品信息", "书名与简介", Icons.Outlined.Edit, onEditProject)
                HorizontalDivider()
                WorkspaceActionRow("角色", "人物设定与关系", Icons.Outlined.Person, { onSelected("character") })
                HorizontalDivider()
                WorkspaceActionRow("世界观", "地点、势力与世界规则", Icons.Outlined.Public, { onSelected("world") })
                HorizontalDivider()
                WorkspaceActionRow("伏笔", "铺设与回收", Icons.Outlined.Link, { onSelected("foreshadowing") })
                HorizontalDivider()
                WorkspaceActionRow("叙事治理", "故事承诺与连续性", Icons.Outlined.FactCheck, { onSelected("governance") })
            }
        }
        item {
            OutlinedCard {
                WorkspaceActionRow("建档与导出", "整理章节资料、查看任务、导出作品", Icons.Outlined.Inventory2,
                    { onSelected("tools") })
            }
        }
    }
}
