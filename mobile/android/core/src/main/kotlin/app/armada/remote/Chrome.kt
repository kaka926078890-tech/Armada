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

fun archiveChipSelected(showingArchived: Boolean, columnSelected: Boolean): Boolean {
    return showingArchived.not() && columnSelected
}

/** Compact activity age for kanban cards. Null if the snap has no clock. */
fun boardCardElapsed(updatedAt: Long?, nowMs: Long): String? {
    if (updatedAt == null || updatedAt <= 0L) return null
    val secs = maxOf(0L, (nowMs - updatedAt) / 1000L)
    return when {
        secs < 60L -> "${secs}s"
        secs < 3600L -> "${secs / 60L}m"
        secs < 86400L -> "${secs / 3600L}h"
        else -> "${secs / 86400L}d"
    }
}

fun unreadBadgeText(count: Int): String? {
    if (count <= 0) return null
    return if (count > 99) "99+" else "$count"
}

/** iOS system colors (light / dark). App accent is systemBlue, not hub primary. */
data class IosPaletteArgb(
    val accent: Long,
    val green: Long,
    val red: Long,
    val blue: Long,
    val gray: Long,
    val orange: Long,
    val page: Long,
    val grouped: Long,
    val cell: Long,
    val secondary: Long,
)

fun iosPaletteArgb(dark: Boolean) = IosPaletteArgb(
    accent = if (dark) 0xFF0A84FFL else 0xFF007AFFL,
    green = if (dark) 0xFF30D158L else 0xFF34C759L,
    red = if (dark) 0xFFFF453AL else 0xFFFF3B30L,
    blue = if (dark) 0xFF0A84FFL else 0xFF007AFFL,
    gray = 0xFF8E8E93L,
    orange = if (dark) 0xFFFF9F0AL else 0xFFFF9500L,
    page = if (dark) 0xFF000000L else 0xFFFFFFFFL,
    grouped = if (dark) 0xFF000000L else 0xFFF2F2F7L,
    cell = if (dark) 0xFF1C1C1EL else 0xFFFFFFFFL,
    secondary = if (dark) 0xFF1C1C1EL else 0xFFF2F2F7L,
)
