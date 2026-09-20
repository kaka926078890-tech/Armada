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
import androidx.activity.enableEdgeToEdge
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
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.activity.result.PickVisualMediaRequest
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
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
        enableEdgeToEdge()
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

fun appearanceTextScale(scale: String): Float = when (scale) {
    "large" -> 1.25f
    "xlarge" -> 1.5f
    else -> 1f
}

@Composable
fun AppearanceRoot(vm: SessionVm) {
    val theme by vm.theme.collectAsState()
    val fontScale by vm.fontScale.collectAsState()
    val textScale = appearanceTextScale(fontScale)
    val dark = theme != "light"
    val scheme = armadaColorScheme(dark)
    val palette = iosPalette(dark)
    val density = LocalDensity.current
    val view = LocalView.current
    SideEffect {
        val window = (view.context as ComponentActivity).window
        WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !dark
        WindowCompat.getInsetsController(window, view).isAppearanceLightNavigationBars = !dark
    }
    MaterialTheme(colorScheme = scheme) {
        CompositionLocalProvider(
            LocalAppTheme provides theme,
            LocalFontScale provides fontScale,
            LocalIosFill provides iosFill(dark),
            LocalIosPalette provides palette,
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
fun BindScreen(vm: SessionVm, state: UiState) {
    var paste by remember { mutableStateOf("") }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            Column(Modifier.statusBarsPadding()) {
                IosNavBar("绑定", largeTitle = true)
                HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
            }
        },
    ) { pad ->
        Column(Modifier.padding(pad).verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
            GroupedSection("粘贴 App 邀请") {
                IosTextField(
                    value = paste,
                    onValueChange = { paste = it },
                    placeholder = "armada-relay://op?…",
                    modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp).padding(16.dp),
                    minLines = 4,
                    maxLines = 8,
                )
                GroupedDivider()
                Box(Modifier.padding(16.dp)) {
                    BarButton("绑定", filled = true, expand = true, enabled = paste.isNotBlank()) { vm.bind(paste) }
                }
            }
            state.bindError?.let {
                Text(it, color = StatusRed, modifier = Modifier.padding(horizontal = 20.dp))
            }
            Text(
                "绑定后按「机器 → 工作区」选仓。点进仓看任务，顶部派发。",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            )
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

@Composable
fun FleetScreen(vm: SessionVm, state: UiState, onOpen: (WorkspaceDto) -> Unit, onRefresh: () -> Unit, onSettings: () -> Unit) {
    val groups = state.workspaces.groupBy { it.machineId }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            Column(Modifier.statusBarsPadding()) {
                IosNavBar(
                    title = "舰队",
                    largeTitle = true,
                    leading = NavAction("解绑") { vm.unbind() },
                    trailing = listOf(
                        NavAction("设置", onClick = onSettings),
                        NavAction("刷新", onClick = onRefresh),
                    ),
                )
                HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
            }
        },
    ) { pad ->
        LazyColumn(Modifier.padding(pad)) {
            if (state.hubOffline) {
                item {
                    Text(
                        "中台离线或没有打开的仓",
                        modifier = Modifier.padding(20.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            state.cursorReload?.notice?.takeIf { it.isNotBlank() }?.let { notice ->
                item {
                    Text(
                        notice,
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                        color = MaterialTheme.colorScheme.tertiary,
                    )
                }
            }
            groups.forEach { (mid, slots) ->
                item {
                    val name = slots.firstOrNull { it.machineName.isNotEmpty() }?.machineName ?: mid
                    val online = slots.any { it.online }
                    GroupedSection(
                        header = name,
                        headerLeading = {
                            Box(Modifier.size(8.dp).clip(CircleShape).background(if (online) StatusGreen else StatusGray))
                        },
                    ) {
                        slots.forEachIndexed { index, w ->
                            val unread = state.board.runs.filter { it.machineId == w.machineId && it.workspaceRoot == w.workspaceRoot }.count { vm.isUnread(it) }
                            val live = state.board.runs.any { it.machineId == w.machineId && it.workspaceRoot == w.workspaceRoot && it.isLive }
                            if (index > 0) GroupedDivider()
                            Row(
                                Modifier.fillMaxWidth().clickable { onOpen(w) }.padding(horizontal = 16.dp, vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text("–", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Spacer(Modifier.width(8.dp))
                                Column(Modifier.weight(1f)) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(w.label, fontSize = 17.sp)
                                        if (live) {
                                            Spacer(Modifier.width(6.dp))
                                            CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp, color = StatusGray)
                                        }
                                    }
                                    Text(w.workspaceRoot, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                                }
                                UnreadBadge(unread)
                                Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
                            }
                        }
                        if (vm.machineNeedsReload(mid) && online) {
                            GroupedDivider()
                            Row(Modifier.padding(horizontal = 8.dp).fillMaxWidth().horizontalScroll(rememberScrollState())) {
                                TextButton(onClick = { vm.setCursorReload("now", machineId = mid) }) { Text("现在 Reload") }
                                TextButton(onClick = { vm.setCursorReload("when-idle", machineId = mid) }) { Text("空闲后自动") }
                                TextButton(onClick = { vm.setCursorReload("skip", machineId = mid) }) { Text("这次跳过") }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun WorkspaceScreen(vm: SessionVm, state: UiState, workspace: WorkspaceDto, onBack: () -> Unit, onOpenRun: (String) -> Unit) {
    var tab by remember { mutableStateOf(BoardColumn.Completed) }
    var showArchived by remember { mutableStateOf(false) }
    var showDispatch by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val sameSlot: (RunDto) -> Boolean = { it.machineId == workspace.machineId && it.workspaceRoot == workspace.workspaceRoot }
    val openRuns = state.board.runs.filter(sameSlot)
    val hiddenRuns = state.board.hidden.filter(sameSlot)
    val boardRuns = if (showArchived) hiddenRuns else openRuns
    val filtered = if (showArchived) boardRuns else boardRuns.filter { it.column == tab }
    val hiddenN = hiddenRuns.size
    fun archive(run: RunDto, hide: Boolean) {
        vm.hideLocal(run.runId, hide)
        scope.launch {
            try {
                val next = if (hide) vm.api().archive(run.runId) else vm.api().unarchive(run.runId)
                vm.hideLocal(run.runId, hide, next)
                vm.refresh()
            } catch (_: Exception) {
                vm.revertHide(run.runId)
            }
        }
    }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            Column(Modifier.statusBarsPadding()) {
                IosNavBar(
                    title = workspace.label,
                    leading = NavAction("‹ 舰队", onClick = onBack),
                    trailing = listOf(NavAction("派发") { showDispatch = true }),
                )
                HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
            }
        },
    ) { pad ->
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
                    val n = openRuns.count { it.column == col }
                    val selected = archiveChipSelected(showArchived, tab == col)
                    val alert = columnHasAlert(openRuns, col) { vm.isUnread(it) }
                    Row(
                        Modifier.clip(RoundedCornerShape(50))
                            .background(if (selected) AccentBlue.copy(alpha = 0.18f) else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f))
                            .clickable {
                                showArchived = false
                                tab = col
                            }
                            .heightIn(min = 36.dp)
                            .padding(horizontal = 12.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            col.title,
                            fontSize = 15.sp,
                            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                            maxLines = 1,
                        )
                        if (n > 0) {
                            Spacer(Modifier.width(4.dp))
                            Text("$n", fontSize = 11.sp)
                        }
                        if (alert) {
                            Spacer(Modifier.width(4.dp))
                            Box(Modifier.size(7.dp).clip(CircleShape).background(StatusRed))
                        }
                    }
                }
                Row(
                    Modifier.clip(RoundedCornerShape(50))
                        .background(if (showArchived) AccentBlue.copy(alpha = 0.18f) else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f))
                        .clickable { showArchived = true }
                        .heightIn(min = 36.dp)
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "已隐藏",
                        fontSize = 15.sp,
                        fontWeight = if (showArchived) FontWeight.SemiBold else FontWeight.Normal,
                        maxLines = 1,
                    )
                    if (hiddenN > 0) {
                        Spacer(Modifier.width(4.dp))
                        Text("$hiddenN", fontSize = 11.sp)
                    }
                }
            }
            LazyColumn(Modifier.weight(1f)) {
                state.lastError?.let { item { Text(it, color = StatusRed, modifier = Modifier.padding(20.dp), style = MaterialTheme.typography.bodySmall) } }
                if (showArchived) {
                    item {
                        Text(
                            "已隐藏的任务仍保留，可取消隐藏。",
                            modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (filtered.isEmpty()) {
                    item {
                        Text(if (showArchived) "还没有已隐藏的任务" else "这一列还没有任务", modifier = Modifier.padding(20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                } else {
                    items(filtered, key = { it.runId }) { run ->
                        val unread = vm.isUnread(run)
                        Box(
                            Modifier
                                .padding(horizontal = 16.dp, vertical = 4.dp)
                                .clip(RoundedCornerShape(12.dp))
                                .background(MaterialTheme.colorScheme.surface),
                        ) {
                            SwipeActionRow(
                                trailing = listOfNotNull(
                                    if (vm.canMarkUnread(run)) {
                                        SwipeAction("标为未读", StatusOrange) { vm.markUnread(run.runId, hold = false) }
                                    } else null,
                                    when {
                                        showArchived -> SwipeAction("取消隐藏", StatusGray) { archive(run, false) }
                                        run.showsArchive -> SwipeAction("隐藏", StatusRed) { archive(run, true) }
                                        else -> null
                                    },
                                ),
                            ) {
                                Box(Modifier.fillMaxWidth().clickable { onOpenRun(run.runId) }.padding(end = 12.dp, top = 10.dp, bottom = 10.dp)) {
                                    RunRow(run, unread)
                                }
                            }
                        }
                    }
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
    val badgeColor = when {
        run.pendingAsk != null -> StatusRed
        unread && run.status == "completed" -> StatusGreen
        unread && run.status in setOf("error", "aborted", "unknown") -> StatusRed
        else -> statusColor(run.status)
    }
    val chrome = when (runRowChrome(run, unread)) {
        RowChrome.Green -> StatusGreen
        RowChrome.Red -> StatusRed
        RowChrome.None -> Color.Transparent
    }
    val elapsed = boardCardElapsed(run.updatedAt, System.currentTimeMillis())
    Row(Modifier.height(IntrinsicSize.Min), verticalAlignment = Alignment.Top) {
        Box(
            Modifier
                .width(3.dp)
                .fillMaxHeight()
                .background(chrome),
        )
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(run.displayTitle, maxLines = 3, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Row(
                Modifier.padding(top = 8.dp).fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (unread) {
                    Box(
                        Modifier.size(6.dp).clip(CircleShape)
                            .background(if (run.status == "completed" && run.pendingAsk == null) StatusGreen else StatusRed),
                    )
                    Spacer(Modifier.width(6.dp))
                }
                Text(
                    cap,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = badgeColor,
                    modifier = Modifier
                        .clip(RoundedCornerShape(50))
                        .background(badgeColor.copy(alpha = 0.14f))
                        .padding(horizontal = 7.dp, vertical = 3.dp),
                )
                Spacer(Modifier.weight(1f))
                if (elapsed != null) {
                    Text(elapsed, fontSize = 11.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f))
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DispatchModal(
    vm: SessionVm,
    workspace: WorkspaceDto,
    followupRunId: String?,
    followupIsLive: Boolean = false,
    onSent: (BoardColumn) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.background,
    ) {
        DispatchSheet(
            vm,
            workspace,
            followupRunId,
            followupIsLive,
            onSent = {
                onSent(it)
                onDismiss()
            },
            onDismiss = onDismiss,
        )
    }
}

@Composable
fun DispatchSheet(vm: SessionVm, workspace: WorkspaceDto, followupRunId: String?, followupIsLive: Boolean, onSent: (BoardColumn) -> Unit, onDismiss: () -> Unit) {
    val state by vm.state.collectAsState()
    var prompt by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var listening by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    var drafts by remember { mutableStateOf(listOf<ImagePrepare.Ok>()) }
    var blobsAvailable by remember { mutableStateOf(true) }
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
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MAX_RUN_ATTACHMENTS)) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        val accepted = uris.take(MAX_RUN_ATTACHMENTS - drafts.size)
        if (uris.size > accepted.size) err = operatorMessage("ATTACHMENT_COUNT")
        val next = drafts.toMutableList()
        for ((i, uri) in accepted.withIndex()) {
            when (val got = prepareImageForUpload(context, uri, "image-$i")) {
                is ImagePrepare.Ok -> next += got
                is ImagePrepare.Fail -> err = if (got.code == "CONVERT") "无法转换这张图" else operatorMessage(got.code)
            }
        }
        drafts = next
    }
    fun addClipboard() {
        val uri = clipboardImageUri(context)
        if (uri == null) return
        if (!canAcceptMoreAttachments(drafts.size, 1)) {
            err = operatorMessage("ATTACHMENT_COUNT")
            return
        }
        when (val got = prepareImageForUpload(context, uri, "paste")) {
            is ImagePrepare.Ok -> drafts = drafts + got
            is ImagePrepare.Fail -> err = if (got.code == "CONVERT") "无法转换这张图" else operatorMessage(got.code)
        }
    }
    val trimmed = prompt.trim()
    val photoEnabled = !followupIsLive
    val canSend = workspace.canInject && !sending && !listening && (trimmed.isNotEmpty() || (photoEnabled && drafts.isNotEmpty()))
    fun send() {
        if (listening) {
            speech.stop()
            return
        }
        if (!canSend) return
        sending = true
        scope.launch {
            try {
                val ids = mutableListOf<String>()
                if (photoEnabled) {
                    for (draft in drafts) {
                        try {
                            ids += vm.api().uploadBlob(draft.bytes, draft.mime, draft.name).id
                        } catch (e: RelayException) {
                            if (e.code == "NO_ROUTE") {
                                blobsAvailable = false
                                drafts = emptyList()
                            }
                            throw e
                        }
                    }
                }
                val run = if (followupRunId != null) {
                    vm.api().followup(followupRunId, trimmed, ids)
                } else {
                    vm.api().dispatch(workspace.workspaceId, trimmed, ids)
                }
                vm.refresh()
                onSent(run.column)
            } catch (e: Exception) {
                err = e.message
            } finally {
                sending = false
            }
        }
    }
    Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding()) {
        IosNavBar(
            title = if (followupRunId == null) "派发任务" else "续聊",
            leading = NavAction("取消") { speech.release(); onDismiss() },
            trailing = listOf(NavAction(if (sending) "发送中…" else if (followupRunId == null) "派发" else "发送", enabled = canSend, onClick = { send() })),
        )
        HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
        Column(Modifier.verticalScroll(rememberScrollState())) {
            if (!workspace.canInject) {
                GroupedSection { Text(operatorMessage("CDP_NOT_READY"), color = StatusRed, modifier = Modifier.padding(16.dp)) }
            }
            err?.let { GroupedSection { Text(it, color = StatusRed, modifier = Modifier.padding(16.dp)) } }
            GroupedSection(header = if (workspace.machineName.isEmpty()) workspace.label else "${workspace.machineName} · ${workspace.label}") {
                Text(workspace.workspaceRoot, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(16.dp))
                if (followupRunId != null) {
                    GroupedDivider()
                    Text("在当前对话里继续，不会新开一条任务", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(16.dp))
                }
            }
            GroupedSection(
                header = "Prompt",
                footer = "语音只写入提示词，不会自动发送。",
            ) {
                if (state.snippets.isNotEmpty()) {
                    Row(
                        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(16.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        state.snippets.forEach { snippet ->
                            BarButton(snippet.title, compact = true) {
                                prompt = appendSnippetBody(prompt, snippet.body)
                            }
                        }
                    }
                    GroupedDivider()
                }
                Text(
                    if (trimmed.isEmpty() && drafts.isEmpty()) "粘贴或语音后应显示字数" else "${prompt.length} 字",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(16.dp),
                )
                if (listening) {
                    GroupedDivider()
                    Text("正在听…说完点停止，改完再派发", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(16.dp))
                }
            }
        }
        if (drafts.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                drafts.forEachIndexed { i, draft ->
                    val bmp = remember(draft.bytes) { android.graphics.BitmapFactory.decodeByteArray(draft.bytes, 0, draft.bytes.size) }
                    Box {
                        if (bmp != null) {
                            androidx.compose.foundation.Image(
                                bitmap = bmp.asImageBitmap(),
                                contentDescription = draft.name,
                                modifier = Modifier.size(56.dp).clip(RoundedCornerShape(8.dp)),
                                contentScale = ContentScale.Crop,
                            )
                        } else {
                            Box(Modifier.size(56.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f)))
                        }
                        Text(
                            "×",
                            color = Color.White,
                            modifier = Modifier
                                .align(Alignment.TopEnd)
                                .clickable { drafts = drafts.filterIndexed { idx, _ -> idx != i } }
                                .background(Color.Black.copy(alpha = 0.45f), CircleShape)
                                .padding(horizontal = 4.dp),
                        )
                    }
                }
            }
        }
        ComposerBar(
            value = prompt,
            onValueChange = { prompt = it },
            sending = sending,
            listening = listening,
            canSend = canSend,
            enabledMic = !sending,
            onMic = {
                if (listening) speech.stop()
                else if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) speech.start(prompt)
                else micPerm.launch(Manifest.permission.RECORD_AUDIO)
            },
            onSend = { send() },
            photoVisible = blobsAvailable,
            photoEnabled = photoEnabled && !sending,
            onPhoto = {
                if (!photoEnabled) {
                    err = operatorMessage("OUTBOUND_TEXT_ONLY")
                } else if (!canAcceptMoreAttachments(drafts.size, 1)) {
                    err = operatorMessage("ATTACHMENT_COUNT")
                } else {
                    picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                }
            },
            onPhotoLong = {
                if (!photoEnabled) err = operatorMessage("OUTBOUND_TEXT_ONLY")
                else addClipboard()
            },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RunDetailScreen(vm: SessionVm, state: UiState, runId: String, onBack: () -> Unit) {
    var run by remember { mutableStateOf(state.board.runs.find { it.runId == runId } ?: state.board.hidden.find { it.runId == runId }) }
    var err by remember { mutableStateOf<String?>(null) }
    var showFollow by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
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
        containerColor = LocalIosPalette.current.page,
        topBar = {
            Column(Modifier.statusBarsPadding()) {
                IosNavBar(
                    title = "详情",
                    leading = NavAction("‹ ${slot?.label ?: "舰队"}", onClick = onBack),
                    trailing = listOf(
                        NavAction("续聊", enabled = slot?.canInject == true && run?.canFollowup == true) { showFollow = true },
                    ),
                )
                HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
            }
        },
        bottomBar = bar@{
            val r = run ?: return@bar
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(LocalIosPalette.current.cell.copy(alpha = 0.92f))
                    .navigationBarsPadding(),
            ) {
                HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
                DetailActionBar(
                copy = {
                    val cm = ctx.getSystemService(ClipboardManager::class.java)
                    cm.setPrimaryClip(ClipData.newPlainText("finalText", r.finalText ?: ""))
                    copied = true
                    scope.launch {
                        delay(1500)
                        copied = false
                    }
                },
                copied = copied,
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
            }
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
                if (r.isLive || r.showsRetry) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (r.isLive) BarButton("取消任务", danger = true, compact = true, onClick = { scope.launch { runCatching { vm.api().cancel(runId) }; runCatching { adopt(vm.api().run(runId)) } } })
                        if (r.showsRetry) BarButton("重试", filled = true, compact = true, enabled = slot?.canInject == true, onClick = { scope.launch { runCatching { vm.api().retry(runId) }; vm.refresh(); runCatching { adopt(vm.api().run(runId)) } } })
                    }
                }
            }
        }
    }
    if (showFollow) {
        slot?.let { ws ->
            DispatchModal(
                vm = vm,
                workspace = ws,
                followupRunId = runId,
                followupIsLive = run?.isLive == true,
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
    val bubble = AccentBlue.copy(alpha = 0.18f)
    val screenWidthDp = LocalConfiguration.current.screenWidthDp
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Column(
            Modifier.width(screenWidthDp.dp * 0.78f).clip(RoundedCornerShape(18.dp)).background(bubble).padding(12.dp),
            horizontalAlignment = Alignment.End,
        ) {
            if (overflows) BarButton(if (expanded) "收起" else "展开", compact = true) { expanded = !expanded }
            Box(Modifier.fillMaxWidth().height(shown.dp)) {
                MarkdownFrame(text, heightDp = maxOf(contentH, 24f), onHeight = { contentH = it })
                if (overflows && !expanded) {
                    Box(
                        Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(28.dp)
                            .background(Brush.verticalGradient(listOf(bubble.copy(alpha = 0f), bubble))),
                    )
                }
            }
        }
    }
}

@Composable
fun DetailReplyBlock(text: String?, isLive: Boolean) {
    var height by remember(text) { mutableFloatStateOf(80f) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (!text.isNullOrEmpty()) {
            MarkdownFrame(text, heightDp = detailReplyShownHeight(height), onHeight = { height = it })
        } else {
            Text(if (isLive) "还没有终态正文" else "没有正文", color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
        }
    }
}

@Composable
fun AskBlock(vm: SessionVm, runId: String, ask: PendingAskDto, onDone: suspend () -> Unit) {
    val scope = rememberCoroutineScope()
    var optionId by remember { mutableStateOf<String?>(null) }
    var freeformText by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf<String?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    val plan = isPlanAsk(ask)
    val canContinue = continueAllowed(ask)
    val typed = freeformText.trim()
    Box(Modifier.fillMaxWidth().height(IntrinsicSize.Min).clip(RoundedCornerShape(12.dp)).background(LocalIosPalette.current.secondary)) {
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
                if (canContinue) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    BarButton(
                        if (busy == "continue") "Building..." else "Build",
                        filled = true,
                        compact = true,
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
                }
                }
            } else {
                Text("需要选择", style = MaterialTheme.typography.titleMedium)
                ask.questions.forEach { q ->
                    Text(q.prompt)
                    val rows = visibleAskOptions(q.options)
                    rows.forEach { o ->
                        val selected = optionId == o.id
                        Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                            Row(
                                Modifier.fillMaxWidth()
                                    .clip(RoundedCornerShape(10.dp))
                                    .background(if (selected) AccentBlue.copy(alpha = 0.12f) else Color.Transparent)
                                    .border(if (selected) 2.dp else 1.dp, if (selected) AccentBlue else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f), RoundedCornerShape(10.dp))
                                    .clickable(enabled = busy == null) {
                                        optionId = o.id
                                        if (o.freeform != true) freeformText = ""
                                    }
                                    .padding(horizontal = 10.dp, vertical = 8.dp)
                                    .heightIn(min = 36.dp),
                            ) {
                                Text(o.label.ifEmpty { o.id.uppercase() }, color = MaterialTheme.colorScheme.onSurfaceVariant, fontFamily = FontFamily.Monospace)
                                Spacer(Modifier.width(8.dp))
                                Text(askOptionBody(o.label, o.text))
                            }
                            if (selected && o.freeform == true) {
                                IosTextField(
                                    value = freeformText,
                                    onValueChange = { freeformText = it },
                                    placeholder = "Other...",
                                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp).heightIn(min = 36.dp),
                                    minLines = 1,
                                    maxLines = 6,
                                    readOnly = busy != null,
                                )
                            }
                        }
                    }
                }
                err?.let { Text(it, color = StatusRed) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                    BarButton(if (busy == "skip") "Skipping..." else "Skip", compact = true, enabled = busy == null, onClick = {
                        busy = "skip"
                        scope.launch {
                            try {
                                vm.api().answer(runId, JSONObject().put("request_id", ask.requestId).put("action", "skip"))
                                onDone()
                            } catch (e: Exception) {
                                err = e.message
                            }
                            busy = null
                        }
                    })
                    if (canContinue) {
                    val rows = visibleAskOptions(ask.questions.firstOrNull()?.options.orEmpty())
                    val pickedFreeform = isFreeformAskOption(rows, optionId)
                    BarButton(if (busy == "continue" || busy == "freeform") "Continuing..." else "Continue", filled = true, compact = true, enabled = (if (pickedFreeform) typed.isNotEmpty() else optionId != null) && busy == null, onClick = click@{
                        val q = ask.questions.firstOrNull() ?: return@click
                        val sendFreeform = pickedFreeform
                        if (sendFreeform && typed.isEmpty()) return@click
                        busy = if (sendFreeform) "freeform" else "continue"
                        scope.launch {
                            try {
                                val body = JSONObject().put("request_id", ask.requestId)
                                if (sendFreeform) {
                                    body.put("action", "freeform").put("text", typed).put("answers", JSONArray())
                                } else {
                                    val oid = optionId ?: return@launch
                                    body.put("action", "continue")
                                        .put("answers", JSONArray().put(JSONObject().put("question_id", q.id).put("option_ids", JSONArray().put(oid))))
                                }
                                vm.api().answer(runId, body)
                                onDone()
                            } catch (e: Exception) {
                                err = e.message
                            }
                            busy = null
                        }
                    })
                    }
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

@Composable
fun SettingsScreen(vm: SessionVm, onBack: () -> Unit) {
    val state by vm.state.collectAsState()
    val theme by vm.theme.collectAsState()
    val fontScale by vm.fontScale.collectAsState()
    LaunchedEffect(Unit) { vm.loadSnippets() }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            Column(Modifier.statusBarsPadding()) {
                IosNavBar("设置", leading = NavAction("‹ 舰队", onClick = onBack))
                HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
            }
        },
    ) { pad ->
        Column(Modifier.padding(pad).verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
            GroupedSection("外观") {
                Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    BarButton("黑夜", modifier = Modifier.weight(1f), filled = theme == "dark", compact = true, expand = true) { vm.setAppearanceTheme("dark") }
                    BarButton("明亮", modifier = Modifier.weight(1f), filled = theme == "light", compact = true, expand = true) { vm.setAppearanceTheme("light") }
                }
            }
            GroupedSection("字号") {
                Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    BarButton("正常", modifier = Modifier.weight(1f), filled = fontScale == "normal", compact = true, expand = true) { vm.setAppearanceFontScale("normal") }
                    BarButton("大", modifier = Modifier.weight(1f), filled = fontScale == "large", compact = true, expand = true) { vm.setAppearanceFontScale("large") }
                    BarButton("超大", modifier = Modifier.weight(1f), filled = fontScale == "xlarge", compact = true, expand = true) { vm.setAppearanceFontScale("xlarge") }
                }
            }
            GroupedSection("快捷提示词") {
                state.lastError?.let {
                    Text(it, color = StatusRed, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(16.dp))
                    GroupedDivider()
                }
                if (state.snippets.isEmpty()) {
                    Text("还没有快捷提示词，请在中台添加", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
                } else {
                    state.snippets.forEachIndexed { index, snippet ->
                        if (index > 0) GroupedDivider()
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
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        IosTextField(title, { title = it }, "标题", Modifier.fillMaxWidth())
        IosTextField(body, { body = it }, "提示词", Modifier.fillMaxWidth().height(90.dp), minLines = 3, maxLines = 8)
        rowError?.let { Text(it, color = StatusRed, style = MaterialTheme.typography.bodySmall) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Text(
                "保存",
                color = if (busy) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f) else AccentBlue,
                modifier = Modifier
                    .clickable(enabled = !busy) {
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
                    .padding(horizontal = 8.dp, vertical = 8.dp),
            )
            Text(
                "删除",
                color = if (busy) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f) else StatusRed,
                modifier = Modifier
                    .clickable(enabled = !busy) {
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
                    .padding(horizontal = 8.dp, vertical = 8.dp),
            )
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
