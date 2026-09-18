package app.armada.remote

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.MotionEvent
import android.view.View
import android.webkit.WebResourceRequest
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
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
        setContent { AppearanceRoot(vm) }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        takeRunIdFromIntent(intent.getStringExtra("runId") ?: intent.data?.getQueryParameter("runId"))
        intent.data?.let { vm.bind(it.toString()) }
        vm.adoptPendingOpen()
    }
}

val LocalAppTheme = compositionLocalOf { "dark" }
val LocalFontScale = compositionLocalOf { "normal" }

val AccentBlue = Color(0xFF599CE7)
val PlanYellow = Color(0xFFF1B467)
val StatusGreen = Color(0xFF22C55E)
val StatusRed = Color(0xFFDC2626)
val StatusBlue = Color(0xFF3B82F6)
val StatusGray = Color(0xFF9CA3AF)
val StatusOrange = Color(0xFFF59E0B)

fun appearanceTextScale(scale: String): Float = when (scale) {
    "large" -> 1.25f
    "xlarge" -> 1.5f
    else -> 1f
}

fun armadaColorScheme(dark: Boolean) = (if (dark) darkColorScheme() else lightColorScheme()).copy(
    primary = AccentBlue,
    onPrimary = Color.White,
    secondary = AccentBlue,
    tertiary = AccentBlue,
)

fun statusColor(status: String) = when (statusTint(status)) {
    "green" -> StatusGreen
    "blue" -> StatusBlue
    "red" -> StatusRed
    "gray" -> StatusGray
    else -> StatusOrange
}

fun rowChromeColor(chrome: RowChrome) = when (chrome) {
    RowChrome.Red -> StatusRed
    RowChrome.Green -> StatusGreen
    RowChrome.None -> Color.Transparent
}

@Composable
fun AppearanceRoot(vm: SessionVm) {
    val theme by vm.theme.collectAsState()
    val fontScale by vm.fontScale.collectAsState()
    val textScale = appearanceTextScale(fontScale)
    val scheme = armadaColorScheme(theme != "light")
    val density = LocalDensity.current
    MaterialTheme(colorScheme = scheme) {
        CompositionLocalProvider(
            LocalAppTheme provides theme,
            LocalFontScale provides fontScale,
            LocalDensity provides Density(density = density.density, fontScale = textScale),
        ) { Root(vm) }
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

@Composable
fun BarButton(
    text: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    filled: Boolean = false,
    danger: Boolean = false,
    compact: Boolean = false,
    expand: Boolean = false,
    fillColor: Color? = null,
    textColor: Color? = null,
    onClick: () -> Unit,
) {
    val fg = textColor ?: when {
        danger || filled -> Color.White
        else -> MaterialTheme.colorScheme.onSurface
    }
    val bg = fillColor ?: when {
        danger -> StatusRed
        filled -> AccentBlue
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    val shape = RoundedCornerShape(10.dp)
    Box(
        modifier
            .then(if (expand) Modifier.fillMaxWidth() else Modifier)
            .heightIn(min = if (compact) 32.dp else 44.dp)
            .alpha(if (enabled) 1f else 0.4f)
            .clip(shape)
            .background(bg)
            .then(
                if (!filled && !danger) Modifier.border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.18f), shape)
                else Modifier,
            )
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = if (compact) 12.dp else 14.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = fg, style = MaterialTheme.typography.labelLarge, maxLines = 1)
    }
}

@Composable
fun ToolbarText(
    text: String,
    enabled: Boolean = true,
    accent: Boolean = false,
    onClick: () -> Unit,
) {
    TextButton(onClick = onClick, enabled = enabled) {
        Text(
            text,
            color = if (!enabled) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f) else if (accent) AccentBlue else MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
        )
    }
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
            Button(onClick = { vm.bind(paste) }, enabled = paste.isNotBlank(), modifier = Modifier.fillMaxWidth().height(48.dp), colors = ButtonDefaults.buttonColors(containerColor = AccentBlue, contentColor = Color.White)) { Text("绑定") }
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
        nav.navigate(runNavRoute(id)) { popUpTo("fleet") }
        vm.consumePendingOpen()
    }
    NavHost(nav, startDestination = "fleet") {
        composable("fleet") {
            FleetScreen(
                vm,
                state,
                onOpen = { nav.navigate(workspaceNavRoute(it.workspaceId)) },
                onRefresh = { vm.startLive() },
                onSettings = { nav.navigate("settings") },
            )
        }
        composable("settings") { SettingsScreen(vm, onBack = { nav.popBackStack() }) }
        composable(
            "ws?id={id}",
            arguments = listOf(navArgument("id") { type = NavType.StringType }),
        ) { entry ->
            val id = entry.arguments?.getString("id").orEmpty()
            val w = liveWorkspace(id, state.workspaces) ?: return@composable
            WorkspaceScreen(
                vm,
                state,
                w,
                onBack = { nav.popBackStack() },
                onOpenRun = { nav.navigate(runNavRoute(it)) },
            )
        }
        composable(
            "run?id={id}",
            arguments = listOf(navArgument("id") { type = NavType.StringType }),
        ) { entry ->
            RunDetailScreen(vm, state, entry.arguments?.getString("id").orEmpty(), onBack = { nav.popBackStack() })
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetScreen(vm: SessionVm, state: UiState, onOpen: (WorkspaceDto) -> Unit, onRefresh: () -> Unit, onSettings: () -> Unit) {
    val groups = state.workspaces.groupBy { it.machineId }
    Scaffold(topBar = {
        TopAppBar(
            title = { Text("舰队") },
            navigationIcon = { ToolbarText("解绑", onClick = { vm.unbind() }) },
            actions = {
                ToolbarText("设置", onClick = onSettings)
                ToolbarText("刷新", accent = true, onClick = onRefresh)
            },
        )
    }) { pad ->
        LazyColumn(Modifier.padding(pad)) {
            if (state.hubOffline) item { Text("中台离线或没有打开的仓", modifier = Modifier.padding(16.dp), color = Color.Gray) }
            groups.forEach { (mid, slots) ->
                item {
                    val name = slots.firstOrNull { it.machineName.isNotEmpty() }?.machineName ?: mid
                    val online = slots.any { it.online }
                    Row(Modifier.padding(16.dp, 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(8.dp).clip(CircleShape).background(if (online) StatusGreen else StatusGray))
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
                            Box(
                                Modifier.background(StatusRed, RoundedCornerShape(10.dp)).padding(horizontal = 5.dp, vertical = 2.dp)
                                    .heightIn(min = 18.dp),
                                contentAlignment = Alignment.Center,
                            ) {
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
fun WorkspaceScreen(vm: SessionVm, state: UiState, workspace: WorkspaceDto, onBack: () -> Unit, onOpenRun: (String) -> Unit) {
    var tab by remember { mutableStateOf(BoardColumn.Completed) }
    var showArchived by remember { mutableStateOf(false) }
    var showDispatch by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val src = if (showArchived) state.board.hidden else state.board.runs
    val boardRuns = src.filter { it.machineId == workspace.machineId && it.workspaceRoot == workspace.workspaceRoot }
    val filtered = boardRuns.filter { it.column == tab }
    val hiddenN = state.board.hidden.count { it.machineId == workspace.machineId && it.workspaceRoot == workspace.workspaceRoot }
    val hideLabel = when {
        showArchived -> "返回看板"
        hiddenN > 0 -> "已隐藏 $hiddenN"
        else -> "已隐藏"
    }
    Scaffold(topBar = {
        TopAppBar(
            title = { Text(workspace.label, maxLines = 1) },
            navigationIcon = { ToolbarText("返回", onClick = onBack) },
            actions = {
                ToolbarText(hideLabel, onClick = { showArchived = !showArchived })
                if (!showArchived) ToolbarText("派发", accent = true, enabled = workspace.canInject, onClick = { showDispatch = true })
            },
        )
    }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (!workspace.canInject) {
                Text(
                    operatorMessage("CDP_NOT_READY"),
                    color = StatusRed,
                    modifier = Modifier.fillMaxWidth().background(StatusRed.copy(alpha = 0.08f)).padding(16.dp, 8.dp),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Row(
                Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                BoardColumn.entries.forEach { col ->
                    val n = boardRuns.count { it.column == col }
                    val selected = tab == col
                    val alert = columnHasAlert(boardRuns, col) { vm.isUnread(it) }
                    Row(
                        Modifier.clip(RoundedCornerShape(50))
                            .background(if (selected) AccentBlue.copy(alpha = 0.18f) else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f))
                            .clickable { tab = col }
                            .heightIn(min = 36.dp)
                            .padding(horizontal = 12.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(col.title, style = if (selected) MaterialTheme.typography.labelLarge else MaterialTheme.typography.bodyMedium, maxLines = 1)
                        if (n > 0) {
                            Spacer(Modifier.width(4.dp))
                            Text("$n", style = MaterialTheme.typography.labelSmall)
                        }
                        if (alert) {
                            Spacer(Modifier.width(4.dp))
                            Box(Modifier.size(7.dp).clip(CircleShape).background(StatusRed))
                        }
                    }
                }
            }
            state.lastError?.let { Text(it, color = StatusRed, modifier = Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall) }
            if (showArchived) Text("已隐藏的任务仍保留，可取消隐藏。", modifier = Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
            if (filtered.isEmpty()) Text("这一列还没有任务", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
            LazyColumn(Modifier.weight(1f)) {
                items(filtered, key = { it.runId }) { run ->
                    val unread = vm.isUnread(run)
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.weight(1f).clickable { onOpenRun(run.runId) }) {
                            RunRow(run, unread)
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            if (vm.canMarkUnread(run)) {
                                TextButton(onClick = { vm.markUnread(run.runId, hold = false) }) { Text("未读") }
                            }
                            if (run.showsArchive && !showArchived) {
                                TextButton(
                                    onClick = {
                                        vm.hideLocal(run.runId, true)
                                        scope.launch {
                                            try {
                                                val next = vm.api().archive(run.runId)
                                                vm.hideLocal(run.runId, true, next)
                                                vm.refresh()
                                            } catch (_: Exception) {
                                                vm.revertHide(run.runId)
                                            }
                                        }
                                    },
                                    colors = ButtonDefaults.textButtonColors(contentColor = StatusRed),
                                ) { Text("隐藏") }
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
                    HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
                }
            }
        }
    }
    if (showDispatch) {
        DispatchModal(
            vm = vm,
            workspace = workspace,
            followupRunId = null,
            onSent = { tab = it },
            onDismiss = { showDispatch = false },
        )
    }
}

@Composable
fun RunRow(run: RunDto, unread: Boolean) {
    val cap = when {
        run.pendingAsk != null && run.status == "running" -> "待处理"
        run.queuedOutbound.isNotEmpty() -> "队列 ${run.queuedOutbound.size}"
        else -> statusLabel(run.status)
    }
    val captionColor = when {
        run.pendingAsk != null -> StatusRed
        unread && run.status == "completed" -> StatusGreen
        unread && run.status in setOf("error", "aborted", "unknown") -> StatusRed
        else -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
    }
    Row(verticalAlignment = Alignment.Top) {
        Box(Modifier.width(3.dp).height(36.dp).clip(RoundedCornerShape(1.5.dp)).background(rowChromeColor(runRowChrome(run, unread))))
        Spacer(Modifier.width(10.dp))
        Box(Modifier.padding(top = 6.dp).size(8.dp).clip(CircleShape).background(statusColor(run.status)))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(run.prompt, maxLines = 2)
            Text(cap, style = MaterialTheme.typography.bodySmall, color = captionColor)
        }
        if (unread) {
            Box(
                Modifier.padding(top = 8.dp).size(7.dp).clip(CircleShape)
                    .background(if (run.status == "completed" && run.pendingAsk == null) StatusGreen else StatusRed),
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DispatchModal(
    vm: SessionVm,
    workspace: WorkspaceDto,
    followupRunId: String?,
    onSent: (BoardColumn) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        DispatchSheet(
            vm,
            workspace,
            followupRunId,
            onSent = {
                onSent(it)
                onDismiss()
            },
            onDismiss = onDismiss,
        )
    }
}

@Composable
fun DispatchSheet(vm: SessionVm, workspace: WorkspaceDto, followupRunId: String?, onSent: (BoardColumn) -> Unit, onDismiss: () -> Unit) {
    val state by vm.state.collectAsState()
    var prompt by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var listening by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val speech = remember {
        PromptSpeech(context, emit = {
            prompt = dictationPrompt(it)
            listening = it.listening
        }, onError = { err = it })
    }
    DisposableEffect(Unit) { onDispose { speech.release() } }
    LaunchedEffect(Unit) { vm.loadSnippets() }
    val micPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) speech.start(prompt) else err = dictationMessage("MIC_DENIED")
    }
    val trimmed = prompt.trim()
    Column(
        Modifier.fillMaxWidth().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(if (followupRunId == null) "派发任务" else "续聊", style = MaterialTheme.typography.titleLarge)
        Text("${workspace.machineName} · ${workspace.label}", style = MaterialTheme.typography.bodySmall)
        if (followupRunId != null) Text("在当前对话里继续，不会新开一条任务", style = MaterialTheme.typography.bodySmall, color = Color.Gray)
        if (!workspace.canInject) Text(operatorMessage("CDP_NOT_READY"), color = Color.Red, style = MaterialTheme.typography.bodySmall)
        if (state.snippets.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                state.snippets.forEach { snippet ->
                    BarButton(snippet.title, compact = true) {
                        prompt = appendSnippetBody(prompt, snippet.body)
                    }
                }
            }
        }
        OutlinedTextField(
            value = prompt,
            onValueChange = { prompt = it },
            modifier = Modifier.fillMaxWidth().height(220.dp),
            label = { Text("Prompt") },
            readOnly = listening,
        )
        Text(if (trimmed.isEmpty()) "粘贴或语音后应显示字数" else "${prompt.length} 字", style = MaterialTheme.typography.bodySmall)
        if (listening) Text("正在听…说完点停止，改完再派发", style = MaterialTheme.typography.bodySmall, color = Color.Gray)
        err?.let { Text(it, color = Color.Red) }
        BarButton(if (listening) "停止" else "语音", expand = true, enabled = !sending, onClick = {
            if (listening) speech.stop()
            else if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) speech.start(prompt)
            else micPerm.launch(Manifest.permission.RECORD_AUDIO)
        })
        BarButton(
            if (sending) "发送中…" else if (followupRunId == null) "派发" else "发送",
            filled = true,
            expand = true,
            enabled = workspace.canInject && !sending && !listening && trimmed.isNotEmpty(),
            onClick = {
                if (listening) speech.stop()
                sending = true
                scope.launch {
                    try {
                        val run = if (followupRunId != null) vm.api().followup(followupRunId, trimmed) else vm.api().dispatch(workspace.workspaceId, trimmed)
                        vm.refresh()
                        onSent(run.column)
                    } catch (e: Exception) {
                        err = e.message
                    } finally {
                        sending = false
                    }
                }
            },
        )
        BarButton("取消", expand = true, onClick = { speech.release(); onDismiss() })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RunDetailScreen(vm: SessionVm, state: UiState, runId: String, onBack: () -> Unit) {
    var run by remember { mutableStateOf(state.board.runs.find { it.runId == runId } ?: state.board.hidden.find { it.runId == runId }) }
    var err by remember { mutableStateOf<String?>(null) }
    var showFollow by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val slot = run?.let { r -> state.workspaces.firstOrNull { it.machineId == r.machineId && it.workspaceRoot == r.workspaceRoot } }
    DisposableEffect(runId) {
        vm.setWatching(runId)
        onDispose {
            if (state.watchingId == runId) vm.setWatching(null)
            vm.clearUnreadHold(runId)
        }
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
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("详情") },
                navigationIcon = { ToolbarText("返回", onClick = onBack) },
                actions = {
                    ToolbarText("续聊", accent = true, enabled = slot?.canInject == true && run?.canFollowup == true) { showFollow = true }
                },
            )
        },
        bottomBar = bar@{
            val r = run ?: return@bar
            DetailActionBar(
                copy = {
                    val cm = ctx.getSystemService(ClipboardManager::class.java)
                    cm.setPrimaryClip(ClipData.newPlainText("finalText", r.finalText ?: ""))
                },
                unread = if (vm.canMarkUnread(r)) ({ vm.markUnread(runId, hold = true) }) else null,
                hide = if (r.isArchived) {
                    {
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
                    }
                } else if (r.showsArchive) {
                    {
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
                    }
                } else null,
                hideTitle = if (r.isArchived) "取消隐藏" else "隐藏",
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val r = run
            if (r == null) CircularProgressIndicator()
            else {
                err?.let { Text(it, color = StatusRed) }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(10.dp).clip(CircleShape).background(statusColor(r.status)))
                    Spacer(Modifier.width(8.dp))
                    Text(statusLabel(r.status), style = MaterialTheme.typography.titleMedium)
                }
                val ws = r.let { runDto -> state.workspaces.firstOrNull { it.machineId == runDto.machineId && it.workspaceRoot == runDto.workspaceRoot } }
                Text("${ws?.machineName.orEmpty()} · ${ws?.label ?: r.workspaceRoot}", style = MaterialTheme.typography.bodyMedium)
                Text(r.workspaceRoot, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                r.displayError?.let { Text(operatorMessage(it), color = StatusRed) }
                if (slot?.canInject == false && r.displayError != "CDP_NOT_READY") Text(operatorMessage("CDP_NOT_READY"), color = StatusRed)
                DetailPromptCard(r.prompt)
                DetailReplyBlock(r.finalText, r.isLive)
                r.pendingAsk?.let { AskBlock(vm, runId, it) { runCatching { adopt(vm.api().run(runId)) } } }
                if (r.queuedOutbound.isNotEmpty()) {
                    Text("${r.queuedOutbound.size} 条排队消息", style = MaterialTheme.typography.bodySmall)
                    r.queuedOutbound.forEach { Text(it.prompt) }
                }
                if (r.isLive) BarButton("取消任务", danger = true, expand = true, onClick = { scope.launch { runCatching { vm.api().cancel(runId) }; runCatching { adopt(vm.api().run(runId)) } } })
                if (r.showsRetry) BarButton("重试", filled = true, expand = true, enabled = slot?.canInject == true, onClick = { scope.launch { runCatching { vm.api().retry(runId) }; vm.refresh(); runCatching { adopt(vm.api().run(runId)) } } })
            }
        }
    }
    if (showFollow) {
        slot?.let { ws ->
            DispatchModal(
                vm = vm,
                workspace = ws,
                followupRunId = runId,
                onSent = { scope.launch { vm.refresh(); runCatching { adopt(vm.api().run(runId)) } } },
                onDismiss = { showFollow = false },
            )
        }
    }
}

@Composable
fun DetailPromptCard(text: String) {
    var contentH by remember(text) { mutableFloatStateOf(40f) }
    var expanded by remember(text) { mutableStateOf(false) }
    val overflows = contentH > DETAIL_PROMPT_MAX_HEIGHT
    val shown = if (expanded) maxOf(contentH, 24f) else detailPromptShownHeight(contentH)
    val card = MaterialTheme.colorScheme.surfaceVariant
    Row(
        Modifier.fillMaxWidth().height(IntrinsicSize.Min).clip(RoundedCornerShape(12.dp)).background(card),
    ) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(AccentBlue))
        Column(Modifier.weight(1f).padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("提示词", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                Spacer(Modifier.weight(1f))
                if (overflows) BarButton(if (expanded) "收起" else "展开", compact = true) { expanded = !expanded }
            }
            Box(Modifier.fillMaxWidth().height(shown.dp).clip(RoundedCornerShape(4.dp))) {
                MarkdownFrame(text, heightDp = maxOf(contentH, 24f), onHeight = { contentH = it })
                if (overflows && !expanded) {
                    Box(
                        Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(36.dp)
                            .background(Brush.verticalGradient(listOf(card.copy(alpha = 0f), card))),
                    )
                }
            }
        }
    }
}

@Composable
fun DetailReplyBlock(text: String?, isLive: Boolean) {
    var height by remember(text) { mutableFloatStateOf(80f) }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("回复", style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.width(8.dp))
            Box(Modifier.weight(1f).height(1.dp).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f)))
        }
        if (!text.isNullOrEmpty()) {
            MarkdownFrame(text, heightDp = detailReplyShownHeight(height), onHeight = { height = it })
        } else {
            Text(if (isLive) "还没有终态正文" else "没有正文", color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
        }
    }
}

@Composable
fun DetailActionBar(copy: () -> Unit, unread: (() -> Unit)?, hide: (() -> Unit)?, hideTitle: String) {
    val items = buildList {
        add("复制正文" to copy)
        if (unread != null) add("标为未读" to unread)
        if (hide != null) add(hideTitle to hide)
    }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        items.forEachIndexed { index, (title, action) ->
            if (index > 0) {
                Box(Modifier.width(1.dp).height(28.dp).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.2f)))
            }
            Box(
                Modifier.weight(1f).heightIn(min = 52.dp).clickable(onClick = action),
                contentAlignment = Alignment.Center,
            ) {
                Text(title, color = AccentBlue, style = MaterialTheme.typography.labelLarge, maxLines = 1)
            }
        }
    }
}

@Composable
fun AskBlock(vm: SessionVm, runId: String, ask: PendingAskDto, onDone: suspend () -> Unit) {
    val scope = rememberCoroutineScope()
    var optionId by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    val plan = isPlanAsk(ask)
    Box(Modifier.fillMaxWidth().height(IntrinsicSize.Min).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceVariant)) {
        Box(
            Modifier.align(Alignment.CenterStart).padding(vertical = 10.dp, horizontal = 4.dp)
                .width(4.dp).fillMaxHeight().clip(RoundedCornerShape(1.5.dp))
                .background(if (plan) PlanYellow else AccentBlue),
        )
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (plan) {
                Text("Created Plan", style = MaterialTheme.typography.titleMedium)
                Text(ask.questions.firstOrNull()?.prompt.orEmpty())
                val overview = ask.questions.firstOrNull()?.options?.firstOrNull()?.text
                if (!overview.isNullOrEmpty() && overview != "Build") MarkdownFrame(overview)
                err?.let { Text(it, color = StatusRed) }
                BarButton(
                    if (busy == "continue") "Building..." else "Build",
                    filled = true,
                    expand = true,
                    enabled = busy == null,
                    fillColor = PlanYellow,
                    textColor = Color.Black,
                    onClick = click@{
                    val q = ask.questions.firstOrNull() ?: return@click
                    val opt = q.options.firstOrNull() ?: return@click
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
                })
            } else {
                Text("需要选择", style = MaterialTheme.typography.titleMedium)
                ask.questions.forEach { q ->
                    Text(q.prompt)
                    q.options.forEach { o ->
                        val selected = optionId == o.id
                        Row(
                            Modifier.fillMaxWidth().padding(vertical = 4.dp)
                                .clip(RoundedCornerShape(10.dp))
                                .background(if (selected) AccentBlue.copy(alpha = 0.12f) else Color.Transparent)
                                .border(if (selected) 2.dp else 1.dp, if (selected) AccentBlue else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f), RoundedCornerShape(10.dp))
                                .clickable(enabled = busy == null) { optionId = o.id }
                                .padding(12.dp),
                        ) {
                            Text(o.label.ifEmpty { o.id.uppercase() }, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                            Spacer(Modifier.width(8.dp))
                            Text(askOptionBody(o.label, o.text))
                        }
                    }
                }
                err?.let { Text(it, color = StatusRed) }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    BarButton(if (busy == "skip") "Skipping..." else "跳过", compact = true, modifier = Modifier.weight(1f), enabled = busy == null, onClick = {
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
                    })
                    BarButton(if (busy == "continue") "Continuing..." else "继续", filled = true, compact = true, modifier = Modifier.weight(1f), enabled = optionId != null && busy == null, onClick = click@{
                        val q = ask.questions.firstOrNull() ?: return@click
                        val oid = optionId ?: return@click
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
                    })
                }
            }
        }
    }
}

private class MarkdownHolder {
    var lastKey = ""
    var onHeight: (Float) -> Unit = {}
}

@Composable
fun MarkdownFrame(text: String, heightDp: Float? = null, onHeight: ((Float) -> Unit)? = null) {
    val fontScale = LocalFontScale.current
    val theme = LocalAppTheme.current
    var measured by remember(text, fontScale, theme) { mutableFloatStateOf(heightDp ?: 80f) }
    val holder = remember { MarkdownHolder() }
    holder.onHeight = { h ->
        measured = h
        onHeight?.invoke(h)
    }
    val shown = heightDp ?: maxOf(measured, 80f)
    AndroidView(
        factory = { c ->
            WebView(c).apply {
                settings.javaScriptEnabled = true
                isVerticalScrollBarEnabled = false
                isHorizontalScrollBarEnabled = false
                isNestedScrollingEnabled = false
                overScrollMode = View.OVER_SCROLL_NEVER
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                setOnTouchListener { v, event ->
                    if (event.actionMasked == MotionEvent.ACTION_MOVE) {
                        v.parent?.requestDisallowInterceptTouchEvent(false)
                    }
                    event.actionMasked == MotionEvent.ACTION_MOVE
                }
                webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView, url: String?) {
                        view.evaluateJavascript(MarkdownHtml.MEASURE_JS) { raw ->
                            val h = raw?.trim('"')?.toFloatOrNull() ?: return@evaluateJavascript
                            holder.onHeight(maxOf(h, 1f))
                        }
                    }
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        val uri = request.url
                        val scheme = uri.scheme ?: return false
                        if (scheme == "http" || scheme == "https") {
                            runCatching { view.context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                            return true
                        }
                        return false
                    }
                }
            }
        },
        update = { web ->
            val key = "$text|$fontScale|$theme"
            if (holder.lastKey != key) {
                holder.lastKey = key
                web.loadDataWithBaseURL(null, MarkdownHtml.from(text, fontScale, theme), "text/html", "utf-8", null)
            }
        },
        modifier = Modifier.fillMaxWidth().height(shown.dp),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(vm: SessionVm, onBack: () -> Unit) {
    val state by vm.state.collectAsState()
    val theme by vm.theme.collectAsState()
    val fontScale by vm.fontScale.collectAsState()
    LaunchedEffect(Unit) { vm.loadSnippets() }
    Scaffold(topBar = {
        TopAppBar(
            title = { Text("设置") },
            navigationIcon = { ToolbarText("返回", onClick = onBack) },
        )
    }) { pad ->
        Column(
            Modifier.padding(pad).padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("外观")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BarButton("黑夜", filled = theme == "dark", compact = true) { vm.setAppearanceTheme("dark") }
                BarButton("明亮", filled = theme == "light", compact = true) { vm.setAppearanceTheme("light") }
            }
            Text("字号")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BarButton("正常", filled = fontScale == "normal", compact = true) { vm.setAppearanceFontScale("normal") }
                BarButton("大", filled = fontScale == "large", compact = true) { vm.setAppearanceFontScale("large") }
                BarButton("超大", filled = fontScale == "xlarge", compact = true) { vm.setAppearanceFontScale("xlarge") }
            }
            Text("快捷提示词")
            state.lastError?.let { Text(it, color = Color.Red, style = MaterialTheme.typography.bodySmall) }
            if (state.snippets.isEmpty()) {
                Text("还没有快捷提示词，请在中台添加", color = Color.Gray)
            } else {
                state.snippets.forEach { snippet ->
                    androidx.compose.runtime.key(snippet.id) {
                        PromptSnippetSettingsRow(
                            snippet = snippet,
                            onSave = { next ->
                                vm.saveSnippets(state.snippets.map { if (it.id == next.id) next else it })
                            },
                            onDelete = {
                                vm.saveSnippets(state.snippets.filter { it.id != snippet.id })
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun PromptSnippetSettingsRow(
    snippet: PromptSnippet,
    onSave: suspend (PromptSnippet) -> Unit,
    onDelete: suspend () -> Unit,
) {
    var title by remember { mutableStateOf(snippet.title) }
    var body by remember { mutableStateOf(snippet.body) }
    var busy by remember { mutableStateOf(false) }
    var rowError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Column(
        Modifier.fillMaxWidth().border(1.dp, Color.Gray, RoundedCornerShape(8.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = title,
            onValueChange = { title = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("标题") },
        )
        OutlinedTextField(
            value = body,
            onValueChange = { body = it },
            modifier = Modifier.fillMaxWidth().height(120.dp),
            label = { Text("提示词") },
        )
        rowError?.let { Text(it, color = Color.Red, style = MaterialTheme.typography.bodySmall) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            BarButton("删除", enabled = !busy, danger = true, compact = true) {
                busy = true
                scope.launch {
                    try {
                        onDelete()
                    } catch (e: Exception) {
                        rowError = e.message
                    } finally {
                        busy = false
                    }
                }
            }
            BarButton(if (busy) "保存中…" else "保存", enabled = !busy, filled = true, compact = true) {
                busy = true
                scope.launch {
                    try {
                        onSave(snippet.copy(title = title, body = body))
                        rowError = null
                    } catch (e: Exception) {
                        rowError = e.message
                    } finally {
                        busy = false
                    }
                }
            }
        }
    }
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
