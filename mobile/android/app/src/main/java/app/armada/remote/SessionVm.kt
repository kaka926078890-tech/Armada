package app.armada.remote

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.sse.EventSource
import org.json.JSONObject

data class UiState(
    val bound: Boolean = false,
    val bindError: String? = null,
    val lastError: String? = null,
    val hubOffline: Boolean = false,
    val workspaces: List<WorkspaceDto> = emptyList(),
    val snippets: List<PromptSnippet> = emptyList(),
    val board: BoardLists = BoardLists(emptyList(), emptyList(), emptySet(), emptySet()),
    val streamHealthy: Boolean = false,
    val pendingOpenRunId: String? = null,
    val watchingId: String? = null,
    val readRev: Int = 0,
)

class SessionVm(app: Application) : AndroidViewModel(app) {
    private val store = TokenStore(app)
    private val _state = MutableStateFlow(UiState(bound = store.relay.isNotEmpty() && store.token.isNotEmpty()))
    val state: StateFlow<UiState> = _state
    private val _theme = MutableStateFlow(store.appearanceTheme)
    val theme: StateFlow<String> = _theme
    private val _fontScale = MutableStateFlow(store.appearanceFontScale)
    val fontScale: StateFlow<String> = _fontScale
    private var live: Job? = null
    private var source: EventSource? = null
    private var refreshSeq = 0
    private var snippetsSeq = 0
    private var readAt = store.readAt().toMutableMap()
    private var unreadHold = mutableSetOf<String>()
    private var foreground = true

    init {
        if (_state.value.bound) startLive()
    }

    fun setAppearanceTheme(v: String) {
        val n = if (v == "light") "light" else "dark"
        store.appearanceTheme = n
        _theme.value = n
    }

    fun setAppearanceFontScale(v: String) {
        val n = if (v == "large" || v == "xlarge") v else "normal"
        store.appearanceFontScale = n
        _fontScale.value = n
    }

    fun api(): RelayClient = RelayClient(store.relay, store.token)

    fun bind(uri: String) {
        when (val parsed = Invite.parse(uri)) {
            is InviteParse.Err -> {
                val msg = if (parsed.code == "insecure") "中转必须是 https，或模拟器下的 http://127.0.0.1" else "邀请格式无效"
                _state.value = _state.value.copy(bindError = msg)
            }
            is InviteParse.Ok -> {
                if (parsed.invite.kind == "pair") {
                    _state.value = _state.value.copy(bindError = "这是中台链接，请粘贴 App 邀请（armada-relay://op）")
                    return
                }
                snippetsSeq++
                store.relay = parsed.invite.relay
                store.fleet = parsed.invite.fleet
                store.token = parsed.invite.cred
                _state.value = _state.value.copy(bound = true, bindError = null)
                startLive()
                PushBridge.requestAndRegister(getApplication()) { tok ->
                    viewModelScope.launch { registerPush(tok) }
                }
            }
        }
    }

    fun unbind() {
        stopLive()
        val push = store.fcmToken
        val client = if (_state.value.bound) api() else null
        store.clear()
        refreshSeq++
        snippetsSeq++
        unreadHold.clear()
        _state.value = UiState()
        PushInbox.runId = null
        if (push.isNotEmpty() && client != null) {
            viewModelScope.launch(Dispatchers.IO) { runCatching { client.deletePushToken(push) } }
        }
    }

    fun setForeground(active: Boolean) {
        if (foreground == active) return
        foreground = active
        if (!_state.value.bound) return
        if (active) startLive() else stopLive()
    }

    fun adoptPendingOpen() {
        if (!_state.value.bound) {
            PushInbox.runId = null
            _state.value = _state.value.copy(pendingOpenRunId = null)
            return
        }
        PushInbox.runId?.let {
            _state.value = _state.value.copy(pendingOpenRunId = it)
            PushInbox.runId = null
        }
    }

    fun consumePendingOpen() {
        _state.value = _state.value.copy(pendingOpenRunId = null)
    }

    fun setWatching(id: String?) {
        PushInbox.watchingId = id
        _state.value = _state.value.copy(watchingId = id)
        if (id != null) markOpened(id)
    }

    fun markOpened(runId: String) {
        if (!shouldStampOpened(unreadHold, runId)) return
        val activity = _state.value.board.runs.find { it.runId == runId }?.activityTs
            ?: _state.value.board.hidden.find { it.runId == runId }?.activityTs
        readAt[runId] = stampReadAt(System.currentTimeMillis().toDouble(), activity)
        store.saveReadAt(readAt)
        _state.value = _state.value.copy(readRev = _state.value.readRev + 1)
    }

    fun markUnread(runId: String, hold: Boolean) {
        readAt.remove(runId)
        if (hold) unreadHold.add(runId) else unreadHold.remove(runId)
        store.saveReadAt(readAt)
        _state.value = _state.value.copy(readRev = _state.value.readRev + 1)
    }

    fun clearUnreadHold(runId: String) {
        unreadHold.remove(runId)
    }

    fun canMarkUnread(run: RunDto) = app.armada.remote.canMarkUnread(run, readAt)

    fun isUnread(run: RunDto) = app.armada.remote.isUnread(run, readAt)

    fun startLive() {
        live?.cancel()
        live = viewModelScope.launch { runLive() }
    }

    private fun stopLive() {
        live?.cancel()
        live = null
        source?.cancel()
        source = null
        _state.value = _state.value.copy(streamHealthy = false)
    }

    private suspend fun runLive() {
        refresh()
        var backoff = 2_000L
        while (foreground && _state.value.bound) {
            try {
                consumeStream()
                _state.value = _state.value.copy(streamHealthy = false)
                backoff = 2_000L
            } catch (_: kotlinx.coroutines.CancellationException) {
                _state.value = _state.value.copy(streamHealthy = false)
                return
            } catch (_: Exception) {
                _state.value = _state.value.copy(streamHealthy = false)
                if (!foreground || !_state.value.bound) return
                refresh()
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(60_000L)
            }
        }
        _state.value = _state.value.copy(streamHealthy = false)
    }

    private suspend fun consumeStream() {
        var first = true
        kotlinx.coroutines.suspendCancellableCoroutine { cont ->
            val src = api().stream(
                onFrame = { frame ->
                    viewModelScope.launch { applyStreamFrame(frame) }
                    if (first) {
                        first = false
                        _state.value = _state.value.copy(streamHealthy = true, lastError = null)
                    }
                },
                onDone = { err ->
                    if (cont.isActive) {
                        if (err != null) cont.resumeWith(Result.failure(err))
                        else cont.resumeWith(Result.success(Unit))
                    }
                },
            )
            source = src
            cont.invokeOnCancellation { src.cancel() }
        }
    }

    private fun applyStreamFrame(frame: JSONObject) {
        when (frame.optString("type")) {
            "workspaces" -> {
                val arr = frame.optJSONArray("workspaces") ?: return
                val list = buildList { for (i in 0 until arr.length()) add(parseWorkspace(arr.getJSONObject(i))) }
                _state.value = _state.value.copy(hubOffline = frame.optBoolean("hubOffline"), workspaces = list, lastError = null)
            }
            "run" -> {
                val run = frame.optJSONObject("run")?.let(::parseRun) ?: return
                val next = applyStreamRun(_state.value.board, run)
                _state.value = _state.value.copy(board = next, lastError = null)
                if (_state.value.watchingId == run.runId) markOpened(run.runId)
            }
        }
    }

    suspend fun refresh() {
        if (!_state.value.bound) return
        refreshSeq++
        val seq = refreshSeq
        try {
            val client = api()
            val (offline, ws) = withContext(Dispatchers.IO) { client.workspaces() }
            val runs = withContext(Dispatchers.IO) { client.runs() }
            val hidden = withContext(Dispatchers.IO) {
                runCatching { client.runs(hidden = true) }.getOrDefault(_state.value.board.hidden)
            }
            if (seq != refreshSeq) return
            _state.value = _state.value.copy(
                hubOffline = offline,
                workspaces = ws,
                board = adoptFetchedLists(_state.value.board, runs, hidden),
                lastError = null,
            )
            _state.value.watchingId?.let { markOpened(it) }
        } catch (e: Exception) {
            if (seq != refreshSeq) return
            _state.value = _state.value.copy(lastError = e.message)
        }
    }

    suspend fun loadSnippets() {
        if (!_state.value.bound) {
            _state.value = _state.value.copy(snippets = emptyList())
            return
        }
        val seq = snippetsSeq
        val client = api()
        try {
            val snippets = withContext(Dispatchers.IO) { client.promptSnippets() }
            if (!_state.value.bound || seq != snippetsSeq) return
            _state.value = _state.value.copy(snippets = snippets, lastError = null)
        } catch (_: Exception) {
            if (!_state.value.bound || seq != snippetsSeq) return
            _state.value = _state.value.copy(snippets = emptyList(), lastError = operatorMessage("READ_FAIL"))
        }
    }

    suspend fun saveSnippets(next: List<PromptSnippet>) {
        if (!_state.value.bound) return
        val seq = snippetsSeq
        val client = api()
        val previous = _state.value.snippets
        _state.value = _state.value.copy(snippets = next)
        try {
            val saved = withContext(Dispatchers.IO) { client.putPromptSnippets(next) }
            if (!_state.value.bound || seq != snippetsSeq) return
            _state.value = _state.value.copy(snippets = saved, lastError = null)
        } catch (e: Exception) {
            if (!_state.value.bound || seq != snippetsSeq) return
            _state.value = _state.value.copy(snippets = previous, lastError = e.message ?: operatorMessage("WRITE_FAIL"))
            throw e
        }
    }

    fun hideLocal(runId: String, archived: Boolean, snapshot: RunDto? = null) {
        _state.value = _state.value.copy(board = applyLocalArchive(_state.value.board, runId, archived, snapshot))
    }

    fun revertHide(runId: String) {
        _state.value = _state.value.copy(board = revertLocalArchive(_state.value.board, runId))
    }

    private suspend fun registerPush(tok: String) {
        if (!_state.value.bound || tok.length < 32) return
        store.fcmToken = tok
        withContext(Dispatchers.IO) { runCatching { api().registerPushToken(tok) } }
    }
}

object PushInbox {
    @Volatile var runId: String? = null
    @Volatile var pendingFcm: String? = null
    @Volatile var watchingId: String? = null
}
