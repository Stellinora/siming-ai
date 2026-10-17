package com.siming.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Restore
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.siming.mobile.data.local.RecycleEntrySummary
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

internal fun recycleTypeLabel(type: String) = when (type) {
    "local_project" -> "本机作品"
    "chapter" -> "章节"
    "outline" -> "大纲"
    "character" -> "角色"
    "character_relation" -> "角色关系"
    "world" -> "世界观"
    "chapter_draft" -> "章节草稿"
    "outline_draft" -> "大纲草稿"
    "creation_session" -> "立项资料"
    else -> "作品资料"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RecycleBinWorkspace(viewModel: MainViewModel, onBack: () -> Unit, snackbar: SnackbarHostState, projectId: String? = null) {
    val entries by viewModel.recycleEntries.collectAsStateWithLifecycle()
    var query by rememberSaveable { mutableStateOf("") }
    var permanentTarget by remember { mutableStateOf<RecycleEntrySummary?>(null) }
    val ui by viewModel.uiState
    BackHandler(onBack = onBack)
    LaunchedEffect(Unit) { viewModel.refreshRecycleBin() }
    val filtered = entries.filter { (projectId == null || it.projectId == projectId) &&
        (query.isBlank() || it.title.contains(query, true) || it.projectTitle.contains(query, true) || recycleTypeLabel(it.entityType).contains(query, true)) }
    Scaffold(containerColor = SimingPaper, snackbarHost = { SnackbarHost(snackbar) }, topBar = {
        TopAppBar(title = { Text("回收站") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "返回") } })
    }) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Text("删除后保留 7 天", style = MaterialTheme.typography.titleLarge)
                Text("这里只显示从这台手机删除的内容，保留 7 天，也可立即永久删除。电脑删除的内容在电脑回收站恢复。本机作品仅恢复到手机；资料遇到后续改动或同步冲突时会停止恢复。", style = MaterialTheme.typography.bodyMedium)
            }
            item { OutlinedTextField(query, { query = it }, placeholder = { Text("搜索作品、资料或类型") }, leadingIcon = { Icon(Icons.Outlined.Search, null) }, modifier = Modifier.fillMaxWidth(), singleLine = true) }
            if (filtered.isEmpty()) item { Text("回收站暂无符合条件的内容", modifier = Modifier.padding(vertical = 24.dp)) }
            items(filtered, key = { it.id }) { entry ->
                OutlinedCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(entry.title, style = MaterialTheme.typography.titleMedium)
                        Text(listOf(recycleTypeLabel(entry.entityType), entry.projectTitle).filter(String::isNotBlank).joinToString(" · "), style = MaterialTheme.typography.bodySmall)
                        Text("保留至 ${DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(entry.expiresAt))}", style = MaterialTheme.typography.bodySmall)
                        if (entry.state == "restoring") Text("已在本机恢复，待同步确认；冲突可在同步页处理", style = MaterialTheme.typography.bodySmall)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilledTonalButton(onClick = { viewModel.restoreRecycleEntry(entry.id) }, enabled = !ui.busy && entry.state == "deleted") {
                                Icon(Icons.Outlined.Restore, null, Modifier.size(18.dp)); Spacer(Modifier.width(4.dp)); Text("恢复")
                            }
                            TextButton(onClick = { permanentTarget = entry }, enabled = !ui.busy && entry.state == "deleted") {
                                Icon(Icons.Outlined.DeleteOutline, null, Modifier.size(18.dp)); Spacer(Modifier.width(4.dp)); Text("永久删除")
                            }
                        }
                    }
                }
            }
        }
    }
    permanentTarget?.let { entry ->
        AlertDialog(onDismissRequest = { permanentTarget = null }, title = { Text("永久删除《${entry.title}》？") },
            text = { Text("此回收项将立即清除，无法恢复。") },
            confirmButton = { TextButton(onClick = { permanentTarget = null; viewModel.permanentlyDeleteRecycleEntry(entry.id) }) { Text("永久删除", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { permanentTarget = null }) { Text("取消") } })
    }
}
