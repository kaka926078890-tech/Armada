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

/**
 * Hub shadcn tokens from `hub/web/src/index.css`.
 * accent = primary, blue = live sky, ask = Ask stripe, orange = plan.
 */
data class IosPaletteArgb(
    val accent: Long,
    val onAccent: Long,
    val green: Long,
    val red: Long,
    val blue: Long,
    val gray: Long,
    val orange: Long,
    val page: Long,
    val grouped: Long,
    val cell: Long,
    val secondary: Long,
    val foreground: Long,
    val border: Long,
    val ask: Long,
)

fun iosPaletteArgb(dark: Boolean) = IosPaletteArgb(
    accent = if (dark) 0xFFE5E5E5L else 0xFF171717L,
    onAccent = if (dark) 0xFF171717L else 0xFFFAFAFAL,
    green = 0xFF34D399L,
    red = if (dark) 0xFFF87171L else 0xFFDC2626L,
    blue = 0xFF38BDF8L,
    gray = if (dark) 0xFFA3A3A3L else 0xFF737373L,
    orange = if (dark) 0xFFF1B467L else 0xFFD9973AL,
    page = if (dark) 0xFF0A0A0AL else 0xFFFFFFFFL,
    grouped = if (dark) 0xFF0A0A0AL else 0xFFF5F5F5L,
    cell = if (dark) 0xFF171717L else 0xFFFFFFFFL,
    secondary = if (dark) 0xFF262626L else 0xFFF5F5F5L,
    foreground = if (dark) 0xFFFAFAFAL else 0xFF0A0A0AL,
    border = if (dark) 0x1AFFFFFFL else 0xFFE5E5E5L,
    ask = if (dark) 0xFF599CE7L else 0xFF3B82C4L,
)
