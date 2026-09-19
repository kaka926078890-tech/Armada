package app.armada.remote

data class WorkspaceDto(
    val workspaceId: String,
    val machineId: String,
    val workspaceRoot: String,
    val label: String,
    val machineName: String = "",
    val os: String = "",
    val online: Boolean = true,
    val cdpReady: Boolean = false,
) {
    val canInject: Boolean get() = online && cdpReady
}

data class CursorReloadDto(
    val needed: Boolean,
    val vsix: String? = null,
    val action: String? = null,
)

data class PromptSnippet(
    val id: String,
    val title: String,
    val body: String,
)

data class PendingAskOption(val id: String, val label: String, val text: String, val freeform: Boolean? = null)

data class PendingAskQuestion(
    val id: String,
    val prompt: String,
    val allowMultiple: Boolean? = null,
    val options: List<PendingAskOption> = emptyList(),
)

data class PendingAskDto(
    val requestId: String,
    val questions: List<PendingAskQuestion> = emptyList(),
    val kind: String? = null,
)

data class OutboundDto(
    val id: String,
    val prompt: String,
    val expectedMode: String,
    val state: String,
    val createdAt: Long,
)

enum class BoardColumn(val title: String) {
    Waiting("待回车"),
    Running("运行中"),
    Completed("已完成"),
    Cancelled("已取消"),
    Error("异常");

    companion object {
        fun column(status: String): BoardColumn = when (status) {
            "created", "queued", "dispatched", "binding" -> Waiting
            "running" -> Running
            "completed" -> Completed
            "cancelled", "aborted" -> Cancelled
            else -> Error
        }
    }
}

data class RunDto(
    val runId: String,
    val machineId: String,
    val workspaceRoot: String,
    val prompt: String,
    val status: String,
    val finalText: String? = null,
    val error: String? = null,
    val pendingAsk: PendingAskDto? = null,
    val outbound: List<OutboundDto>? = null,
    val queueMessageDefaultBehavior: String? = null,
    val canRetry: Boolean? = null,
    val archived: Boolean? = null,
    val updatedAt: Long? = null,
    val title: String? = null,
    val conversationId: String? = null,
) {
    val isLive: Boolean
        get() = status in setOf("created", "queued", "dispatched", "binding", "running")
    val isArchived: Boolean get() = archived == true
    val showsArchive: Boolean get() = !isLive && !isArchived
    val queuedOutbound: List<OutboundDto>
        get() = (outbound ?: emptyList()).filter { it.state == "queued" || (it.state == "injecting" && it.expectedMode == "queue") }
    val canFollowup: Boolean get() = pendingAsk == null && !conversationId.isNullOrBlank()
    val displayTitle: String get() = title?.trim()?.takeIf { it.isNotEmpty() } ?: prompt
    val showsRetry: Boolean
        get() = canRetry ?: (status in setOf("error", "unknown", "aborted"))
    val displayError: String?
        get() {
            val e = error ?: return null
            if (e.isEmpty() || e == status || e == "completed") return null
            return e
        }
    val activityTs: Long get() = updatedAt ?: 0
    val column: BoardColumn get() = BoardColumn.column(status)
}

data class FollowupAck(val run: RunDto, val outcome: String?)

fun followupOutcomeOrNull(raw: String?): String? =
    if (raw == "queued" || raw == "injected") raw else null

fun parseFollowupAck(run: RunDto, outcome: String?): FollowupAck =
    FollowupAck(run, followupOutcomeOrNull(outcome))

fun isPlanAsk(ask: PendingAskDto): Boolean = ask.kind == "plan"

fun continueAllowed(ask: PendingAskDto): Boolean {
    return ask.questions.size == 1 && ask.questions.first().allowMultiple != true
}

fun askOptionBody(label: String, text: String): String {
    val t = text.trim()
    return t.ifEmpty { label }
}

fun coalesceFinalText(incoming: RunDto, prior: RunDto?): RunDto {
    val prev = prior?.finalText
    return if (incoming.finalText == null && !prev.isNullOrEmpty()) incoming.copy(finalText = prev) else incoming
}

/** 中转每次 upsert 都刷新 updatedAt；内容没变时不得当新快照，否则 App 整树重绘、输入法组合态被拆。 */
fun runContentEquals(a: RunDto, b: RunDto): Boolean = a.copy(updatedAt = null) == b.copy(updatedAt = null)

fun optionalChanged(current: String?, incoming: String?): Boolean = current != incoming

fun shouldUpdateBadge(current: Int, next: Int): Boolean = current != next

fun keepListBodies(incoming: List<RunDto>, prior: List<RunDto>): List<RunDto> {
    val old = prior.associateBy { it.runId }
    return incoming.map { r -> coalesceFinalText(r, old[r.runId]) }
}

/** 详情在「由忙入闲」时强制 GET /:id；SSE 空正文不能当终态全文。 */
fun detailShouldReload(local: RunDto?, streamed: RunDto): Boolean {
    if (local == null || local.runId != streamed.runId) return false
    return local.isLive && !streamed.isLive
}

fun stampReadAt(nowMs: Double, activityTs: Long?): Double {
    return maxOf(nowMs, (activityTs ?: 0L).toDouble())
}

fun shouldStampReadAt(seen: Double?, activityTs: Long?): Boolean {
    if (seen == null) return true
    return (activityTs ?: 0L).toDouble() > seen
}

fun isUnread(run: RunDto, readAt: Map<String, Double>): Boolean {
    val seen = readAt[run.runId]
    if (run.pendingAsk != null) {
        if (seen == null) return true
        if (run.activityTs.toDouble() > seen) return true
    }
    if (run.status in setOf("completed", "error", "unknown", "aborted")) {
        return seen == null || run.activityTs.toDouble() > seen
    }
    return false
}

fun canMarkUnread(run: RunDto, readAt: Map<String, Double>): Boolean {
    if (isUnread(run, readAt)) return false
    if (run.pendingAsk != null) return true
    return run.status in setOf("completed", "error", "unknown", "aborted")
}

fun readAtAfterMarkUnread(readAt: Map<String, Double>, runId: String): Map<String, Double> {
    return readAt - runId
}

fun shouldStampOpened(unreadHold: Set<String>, runId: String): Boolean {
    return runId !in unreadHold
}

/** 仓页必须跟 SSE 列表走；导航快照的 cdpReady 会过期。 */
fun liveWorkspace(id: String, slots: List<WorkspaceDto>, fallback: WorkspaceDto? = null): WorkspaceDto? {
    return slots.firstOrNull { it.workspaceId == id } ?: fallback
}
