package app.armada.remote

enum class RowChrome { None, Red, Green }

fun runRowChrome(run: RunDto, unread: Boolean): RowChrome {
    if (run.pendingAsk != null) return RowChrome.Red
    if (unread && run.status == "completed") return RowChrome.Green
    if (unread && run.status in setOf("error", "aborted", "unknown")) return RowChrome.Red
    return RowChrome.None
}

fun statusTint(status: String): String = when (status) {
    "completed" -> "green"
    "running", "dispatched", "binding", "queued", "created" -> "blue"
    "error", "aborted", "unknown" -> "red"
    "cancelled" -> "gray"
    else -> "orange"
}

fun columnHasAlert(runs: List<RunDto>, column: BoardColumn, isUnread: (RunDto) -> Boolean): Boolean {
    return runs.any { run ->
        run.column == column && runRowChrome(run, isUnread(run)) == RowChrome.Red
    }
}

const val DETAIL_PROMPT_MAX_HEIGHT = 180f

fun detailPromptShownHeight(contentHeight: Float, cap: Float = DETAIL_PROMPT_MAX_HEIGHT): Float {
    return minOf(maxOf(contentHeight, 24f), cap)
}

fun detailReplyShownHeight(contentHeight: Float): Float = maxOf(contentHeight, 80f)

fun hideArchiveLabel(hiddenCount: Int, showingArchived: Boolean): String {
    if (showingArchived) return "返回看板"
    return if (hiddenCount > 0) "查看已隐藏 $hiddenCount" else "查看已隐藏"
}

fun unreadBadgeText(count: Int): String? {
    if (count <= 0) return null
    return if (count > 99) "99+" else "$count"
}
