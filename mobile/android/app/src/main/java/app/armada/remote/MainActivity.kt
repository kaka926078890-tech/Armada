package app.armada.remote

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    private val vm: SessionVm by viewModels()
    private val notifPerm = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        takeRunIdFromIntent(intent?.getStringExtra("runId") ?: intent?.data?.getQueryParameter("runId"))
        if (intent?.data != null) vm.bind(intent.data.toString())
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notifPerm.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        setContent { MaterialTheme { Root(vm) } }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        takeRunIdFromIntent(intent.getStringExtra("runId") ?: intent.data?.getQueryParameter("runId"))
        intent.data?.let { vm.bind(it.toString()) }
        vm.adoptPendingOpen()
    }
}

@Composable
fun Root(vm: SessionVm) {
    val state by vm.state.collectAsState()
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val obs = LifecycleEventObserver { _, e ->
            when (e) {
                Lifecycle.Event.ON_START -> vm.setForeground(true)
                Lifecycle.Event.ON_STOP -> vm.setForeground(false)
                else -> {}
            }
        }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }
    LaunchedEffect(Unit) { vm.adoptPendingOpen() }
    if (!state.bound) BindScreen(vm, state) else FleetNav(vm, state)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BindScreen(vm: SessionVm, state: UiState) {
    var paste by remember { mutableStateOf("") }
    Scaffold(topBar = { TopAppBar(title = { Text("绑定") }) }) { pad ->
        Column(Modifier.padding(pad).padding(16.dp)) {
            OutlinedTextField(
                value = paste,
                onValueChange = { paste = it },
                label = { Text("armada-relay://op?…") },
                modifier = Modifier.fillMaxWidth().height(160.dp),
            )
            Spacer(Modifier.height(12.dp))
            Button(onClick = { vm.bind(paste) }, enabled = paste.isNotBlank()) { Text("绑定") }
            state.bindError?.let { Text(it, color = Color.Red, modifier = Modifier.padding(top = 8.dp)) }
            Text("绑定后按「机器 → 工作区」选仓。点进仓看任务，顶部派发。", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 16.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetNav(vm: SessionVm, state: UiState) {
    val nav = rememberNavController()
    LaunchedEffect(state.pendingOpenRunId) {
        val id = state.pendingOpenRunId ?: return@LaunchedEffect
        nav.navigate("run/$id") { popUpTo("fleet") }
        vm.consumePendingOpen()
    }
    NavHost(nav, startDestination = "fleet") {
        composable("fleet") { FleetScreen(vm, state, onOpen = { nav.navigate("ws/${it.workspaceId}") }, onRefresh = { vm.startLive() }) }
        composable("ws/{id}", arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
            val id = entry.arguments?.getString("id").orEmpty()
            val w = state.workspaces.firstOrNull { it.workspaceId == id } ?: return@composable
            WorkspaceScreen(vm, state, w, onOpenRun = { nav.navigate("run/$it") })
        }
        composable("run/{id}", arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
            RunDetailScreen(vm, state, entry.arguments?.getString("id").orEmpty())
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetScreen(vm: SessionVm, state: UiState, onOpen: (WorkspaceDto) -> Unit, onRefresh: () -> Unit) {
    val groups = state.workspaces.groupBy { it.machineId }
    Scaffold(topBar = {
        TopAppBar(
            title = { Text("舰队") },
            navigationIcon = { TextButton(onClick = { vm.unbind() }) { Text("解绑") } },
            actions = { TextButton(onClick = onRefresh) { Text("刷新") } },
        )
    }) { pad ->
        LazyColumn(Modifier.padding(pad)) {
            if (state.hubOffline) item { Text("中台离线或没有打开的仓", modifier = Modifier.padding(16.dp), color = Color.Gray) }
            groups.forEach { (mid, slots) ->
                item {
                    val name = slots.firstOrNull { it.machineName.isNotEmpty() }?.machineName ?: mid
                    val online = slots.any { it.online }
                    Row(Modifier.padding(16.dp, 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(8.dp).clip(CircleShape).background(if (online) Color(0xFF22C55E) else Color.Gray))
                        Spacer(Modifier.width(8.dp))
                        Text(name, style = MaterialTheme.typography.titleSmall)
                    }
                }
                items(slots, key = { it.workspaceId }) { w ->
                    val unread = state.board.runs.filter { it.machineId == w.machineId && it.workspaceRoot == w.workspaceRoot }.count { vm.isUnread(it) }
                    val live = state.board.runs.any { it.machineId == w.machineId && it.workspaceRoot == w.workspaceRoot && it.isLive }
                    Row(Modifier.fillMaxWidth().clickable { onOpen(w) }.padding(24.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(w.label)
                                if (live) {
                                    Spacer(Modifier.width(8.dp))
                                    CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp)
                                }
                            }
                            Text(w.workspaceRoot, style = MaterialTheme.typography.bodySmall, color = Color.Gray, maxLines = 1)
                        }
                        if (unread > 0) {
                            Box(Modifier.background(Color.Red, RoundedCornerShape(10.dp)).padding(6.dp, 2.dp)) {
                                Text(if (unread > 99) "99+" else "$unread", color = Color.White, style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceScreen(vm: SessionVm, state: UiState, workspace: WorkspaceDto, onOpenRun: (String) -> Unit) {
    var tab by remember { mutableStateOf(BoardColumn.Completed) }
    var showArchived by remember { mutableStateOf(false) }
    var showDispatch by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val src = if (showArchived) state.board.hidden else state.board.runs
    val boardRuns = src.filter { it.machineId == workspace.machineId && it.workspaceRoot == workspace.workspaceRoot }
    val filtered = boardRuns.filter { it.column == tab }
    val hiddenN = state.board.hidden.count { it.machineId == workspace.machineId && it.workspaceRoot == workspace.workspaceRoot }
    Scaffold(topBar = {
        TopAppBar(
            title = { Text(workspace.label) },
            actions = {
                TextButton(onClick = { showArchived = !showArchived }) {
                    Text(if (showArchived) "返回看板" else if (hiddenN > 0) "查看已隐藏 $hiddenN" else "查看已隐藏")
                }
                if (!showArchived) TextButton(onClick = { showDispatch = true }) { Text("派发") }
            },
        )
    }) { pad ->
        Column(Modifier.padding(pad)) {
            Row(Modifier.padding(8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                BoardColumn.entries.forEach { col ->
                    val n = boardRuns.count { it.column == col }
                    FilterChip(selected = tab == col, onClick = { tab = col }, label = { Text(if (n > 0) "${col.title} $n" else col.title) })
                }
            }
            state.lastError?.let { Text(it, color = Color.Red, modifier = Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall) }
            if (showArchived) Text("已隐藏的任务仍保留，可取消隐藏。", modifier = Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall, color = Color.Gray)
            if (filtered.isEmpty()) Text("这一列还没有任务", modifier = Modifier.padding(16.dp), color = Color.Gray)
            LazyColumn {
                items(filtered, key = { it.runId }) { run ->
                    Row(Modifier.fillMaxWidth().clickable { onOpenRun(run.runId) }.padding(12.dp)) {
                        Column(Modifier.weight(1f)) {
                            Text(run.prompt, maxLines = 2)
                            val cap = when {
                                run.pendingAsk != null && run.status == "running" -> "待处理"
                                run.queuedOutbound.isNotEmpty() -> "队列 ${run.queuedOutbound.size}"
                                else -> statusLabel(run.status)
                            }
                            Text(cap, style = MaterialTheme.typography.bodySmall, color = Color.Gray)
                        }
                        if (run.showsArchive && !showArchived) {
                            TextButton(onClick = {
                                vm.hideLocal(run.runId, true)
                                scope.launch {
                                    try {
                                        val next = vm.api().archive(run.runId)
                                        vm.hideLocal(run.runId, true, next)
                                        vm.refresh()
                                    } catch (e: Exception) {
                                        vm.revertHide(run.runId)
                                    }
                                }
                            }) { Text("隐藏") }
                        }
                        if (showArchived) {
                            TextButton(onClick = {
                                vm.hideLocal(run.runId, false)
                                scope.launch {
                                    try {
                                        val next = vm.api().unarchive(run.runId)
                                        vm.hideLocal(run.runId, false, next)
                                        vm.refresh()
                                    } catch (_: Exception) {
                                        vm.revertHide(run.runId)
                                    }
                                }
                            }) { Text("取消隐藏") }
                        }
                    }
                }
            }
        }
    }
    if (showDispatch) DispatchSheet(vm, workspace, null) { showDispatch = false; tab = it }
}

@Composable
fun DispatchSheet(vm: SessionVm, workspace: WorkspaceDto, followupRunId: String?, onDone: (BoardColumn) -> Unit) {
    var prompt by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val trimmed = prompt.trim()
    Column(Modifier.fillMaxWidth().padding(16.dp).verticalScroll(rememberScrollState())) {
        Text(if (followupRunId == null) "派发任务" else "续聊", style = MaterialTheme.typography.titleLarge)
        Text("${workspace.machineName} · ${workspace.label}", style = MaterialTheme.typography.bodySmall)
        if (followupRunId != null) Text("在当前对话里继续，不会新开一条任务", style = MaterialTheme.typography.bodySmall, color = Color.Gray)
        OutlinedTextField(value = prompt, onValueChange = { prompt = it }, modifier = Modifier.fillMaxWidth().height(220.dp), label = { Text("Prompt") })
        Text(if (trimmed.isEmpty()) "粘贴后应显示字数" else "${prompt.length} 字", style = MaterialTheme.typography.bodySmall)
        err?.let { Text(it, color = Color.Red) }
        Button(
            onClick = {
                sending = true
                scope.launch {
                    try {
                        val run = if (followupRunId != null) vm.api().followup(followupRunId, trimmed) else vm.api().dispatch(workspace.workspaceId, trimmed)
                        vm.refresh()
                        onDone(run.column)
                    } catch (e: Exception) {
                        err = e.message
                    } finally {
                        sending = false
                    }
                }
            },
            enabled = !sending && trimmed.isNotEmpty(),
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        ) { Text(if (sending) "发送中…" else if (followupRunId == null) "派发" else "发送") }
        OutlinedButton(onClick = { onDone(BoardColumn.Completed) }, modifier = Modifier.fillMaxWidth()) { Text("取消") }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RunDetailScreen(vm: SessionVm, state: UiState, runId: String) {
    var run by remember { mutableStateOf(state.board.runs.find { it.runId == runId } ?: state.board.hidden.find { it.runId == runId }) }
    var err by remember { mutableStateOf<String?>(null) }
    var showFollow by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val slot = run?.let { r -> state.workspaces.firstOrNull { it.machineId == r.machineId && it.workspaceRoot == r.workspaceRoot } }
    DisposableEffect(runId) {
        vm.setWatching(runId)
        onDispose { if (state.watchingId == runId) vm.setWatching(null) }
    }
    fun adopt(fetched: RunDto) {
        run = coalesceFinalText(fetched, run)
    }
    LaunchedEffect(runId) {
        try {
            adopt(vm.api().run(runId))
            vm.markOpened(runId)
            err = null
        } catch (e: Exception) {
            err = e.message
        }
        while (true) {
            if (state.streamHealthy) {
                delay(1000)
                continue
            }
            delay(3000)
            runCatching { adopt(vm.api().run(runId)) }
        }
    }
    val streamed = state.board.runs.find { it.runId == runId } ?: state.board.hidden.find { it.runId == runId }
    LaunchedEffect(streamed) {
        val next = streamed ?: return@LaunchedEffect
        val local = run
        adopt(next)
        if (state.watchingId == runId) vm.markOpened(runId)
        if (detailShouldReload(local, next)) {
            runCatching { adopt(vm.api().run(runId)) }
        }
    }
    Scaffold(topBar = {
        TopAppBar(
            title = { Text("详情") },
            actions = {
                TextButton(onClick = { showFollow = true }, enabled = slot != null && run?.canFollowup == true) { Text("续聊") }
            },
        )
    }) { pad ->
        Column(Modifier.padding(pad).padding(16.dp).verticalScroll(rememberScrollState())) {
            val r = run
            if (r == null) CircularProgressIndicator()
            else {
                err?.let { Text(it, color = Color.Red) }
                Text(statusLabel(r.status), style = MaterialTheme.typography.titleMedium)
                Text("${r.workspaceRoot}", style = MaterialTheme.typography.bodySmall, color = Color.Gray)
                r.displayError?.let { Text(it, color = Color.Red) }
                Text("提示词", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 12.dp))
                MarkdownBox(r.prompt)
                Text("回复", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 12.dp))
                if (!r.finalText.isNullOrEmpty()) MarkdownBox(r.finalText!!)
                else Text(if (r.isLive) "还没有终态正文" else "没有正文", color = Color.Gray)
                r.pendingAsk?.let { AskBlock(vm, runId, it) { runCatching { adopt(vm.api().run(runId)) } } }
                if (r.queuedOutbound.isNotEmpty()) {
                    Text("${r.queuedOutbound.size} 条排队消息", style = MaterialTheme.typography.bodySmall)
                    r.queuedOutbound.forEach { Text(it.prompt) }
                }
                Button(onClick = {
                    val cm = ctx.getSystemService(ClipboardManager::class.java)
                    cm.setPrimaryClip(ClipData.newPlainText("finalText", r.finalText ?: ""))
                }) { Text("复制正文") }
                if (r.isLive) OutlinedButton(onClick = { scope.launch { runCatching { vm.api().cancel(runId) }; runCatching { adopt(vm.api().run(runId)) } } }) { Text("取消任务") }
                if (r.showsRetry) Button(onClick = { scope.launch { runCatching { vm.api().retry(runId) }; vm.refresh(); runCatching { adopt(vm.api().run(runId)) } } }) { Text("重试") }
                if (r.isArchived) OutlinedButton(onClick = {
                    vm.hideLocal(runId, false, r)
                    scope.launch {
                        try {
                            val next = vm.api().unarchive(runId)
                            vm.hideLocal(runId, false, next)
                            vm.refresh()
                            run = next
                        } catch (_: Exception) {
                            vm.revertHide(runId)
                        }
                    }
                }) { Text("取消隐藏") }
                else if (r.showsArchive) OutlinedButton(onClick = {
                    vm.hideLocal(runId, true, r)
                    scope.launch {
                        try {
                            val next = vm.api().archive(runId)
                            vm.hideLocal(runId, true, next)
                            vm.refresh()
                        } catch (e: Exception) {
                            vm.revertHide(runId)
                            err = hideError((e as? RelayException)?.code ?: "")
                        }
                    }
                }) { Text("隐藏") }
            }
        }
    }
    if (showFollow && slot != null) DispatchSheet(vm, slot, runId) { showFollow = false; scope.launch { vm.refresh(); runCatching { adopt(vm.api().run(runId)) } } }
}

@Composable
fun AskBlock(vm: SessionVm, runId: String, ask: PendingAskDto, onDone: suspend () -> Unit) {
    val scope = rememberCoroutineScope()
    var optionId by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    val plan = isPlanAsk(ask)
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp).background(Color(0xFFF4F4F5), RoundedCornerShape(12.dp)).padding(14.dp)) {
        if (plan) {
            Text("Created Plan", style = MaterialTheme.typography.titleMedium)
            Text(ask.questions.firstOrNull()?.prompt.orEmpty())
            val overview = ask.questions.firstOrNull()?.options?.firstOrNull()?.text
            if (!overview.isNullOrEmpty() && overview != "Build") MarkdownBox(overview)
            err?.let { Text(it, color = Color.Red) }
            Button(
                onClick = {
                    val q = ask.questions.firstOrNull() ?: return@Button
                    val opt = q.options.firstOrNull() ?: return@Button
                    busy = "continue"
                    scope.launch {
                        try {
                            val body = JSONObject()
                                .put("request_id", ask.requestId)
                                .put("action", "continue")
                                .put("answers", JSONArray().put(JSONObject().put("question_id", q.id).put("option_ids", JSONArray().put(opt.id))))
                            vm.api().answer(runId, body)
                            onDone()
                        } catch (e: Exception) {
                            err = e.message
                            busy = null
                        }
                    }
                },
                enabled = busy == null,
                modifier = Modifier.fillMaxWidth(),
                colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = Color(0xFFF1B467), contentColor = Color.Black),
            ) { Text(if (busy == "continue") "Building..." else "Build") }
        } else {
            Text("需要选择", style = MaterialTheme.typography.titleMedium)
            ask.questions.forEach { q ->
                Text(q.prompt)
                q.options.forEach { o ->
                    val selected = optionId == o.id
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 4.dp).border(if (selected) 2.dp else 1.dp, if (selected) Color(0xFF599CE7) else Color.LightGray, RoundedCornerShape(10.dp)).clickable { optionId = o.id }.padding(12.dp),
                    ) {
                        Text(o.label.ifEmpty { o.id.uppercase() }, color = Color.Gray)
                        Spacer(Modifier.width(8.dp))
                        Text(askOptionBody(o.label, o.text))
                    }
                }
            }
            err?.let { Text(it, color = Color.Red) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = {
                        busy = "skip"
                        scope.launch {
                            try {
                                vm.api().answer(runId, JSONObject().put("request_id", ask.requestId).put("action", "skip"))
                                onDone()
                            } catch (e: Exception) {
                                err = e.message
                                busy = null
                            }
                        }
                    },
                    enabled = busy == null,
                    modifier = Modifier.weight(1f),
                ) { Text(if (busy == "skip") "Skipping..." else "跳过") }
                Button(
                    onClick = {
                        val q = ask.questions.firstOrNull() ?: return@Button
                        val oid = optionId ?: return@Button
                        busy = "continue"
                        scope.launch {
                            try {
                                val body = JSONObject()
                                    .put("request_id", ask.requestId)
                                    .put("action", "continue")
                                    .put("answers", JSONArray().put(JSONObject().put("question_id", q.id).put("option_ids", JSONArray().put(oid))))
                                vm.api().answer(runId, body)
                                onDone()
                            } catch (e: Exception) {
                                err = e.message
                                busy = null
                            }
                        }
                    },
                    enabled = optionId != null && busy == null,
                    modifier = Modifier.weight(1f),
                    colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = Color(0xFF599CE7)),
                ) { Text(if (busy == "continue") "Continuing..." else "继续") }
            }
        }
    }
}

@Composable
fun MarkdownBox(text: String) {
    AndroidView(
        factory = { c ->
            WebView(c).apply {
                webViewClient = WebViewClient()
                settings.javaScriptEnabled = false
                setBackgroundColor(0)
            }
        },
        update = { it.loadDataWithBaseURL(null, MarkdownHtml.from(text), "text/html", "utf-8", null) },
        modifier = Modifier.fillMaxWidth().height(180.dp),
    )
}

fun statusLabel(status: String) = when (status) {
    "queued" -> "排队中"
    "dispatched" -> "已派发"
    "binding" -> "绑定中"
    "running" -> "运行中"
    "completed" -> "已完成"
    "cancelled" -> "已取消"
    "error", "aborted", "unknown" -> "异常"
    else -> status
}
