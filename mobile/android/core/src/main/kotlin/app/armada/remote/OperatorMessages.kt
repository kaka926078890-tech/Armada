package app.armada.remote

fun operatorMessage(code: String): String = when (code) {
    "CONVERSATION_BUSY" -> "该对话仍在排队或绑定，结束后才能续聊"
    "NO_CONVERSATION" -> "还没有绑上 Cursor 对话，不能续聊"
    "INJECT_SLOT_BUSY" -> "这台机器正在注入另一条任务，稍后再试"
    "WORKSPACE_NOT_OPEN" -> "工作区没有打开"
    "CLOSED" -> "这条对话已关闭"
    "PROMPT_COLLISION" -> "同一工作区已有相同内容的任务"
    "HUB_OFFLINE" -> "中台离线"
    "HUB_TIMEOUT" -> "中台处理超时，请再发一次"
    "RATE_LIMIT" -> "点得太快，请稍后再发"
    "EMPTY_PROMPT" -> "提示词是空的"
    "NET_INTERCEPT" -> "当前网络拦截了中转。请关掉 Wi‑Fi 改用蜂窝，或换一个网络后再打开。"
    "OUTBOUND_LIMIT" -> "待消化续发已达上限，等 Cursor 消化后再发"
    "OUTBOUND_TEXT_ONLY" -> "运行中续发暂只支持纯文本"
    "INVALID_STATE" -> "当前状态不能重试"
    "NOT_FOUND" -> "任务不存在"
    "INVALID" -> "推送登记失败"
    "MACHINE_OFFLINE" -> "机器离线"
    "RUN_LIMIT" -> "这台机器任务数已满"
    "WINDOW_BUSY" -> "该窗口正忙"
    else -> code
}

fun hideError(code: String): String =
    if (code == "INVALID_STATE") "运行中不能隐藏" else operatorMessage(code)

fun classifyHttp(status: Int, body: String): String {
    val code = Regex("\"error\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1)
    if (!code.isNullOrEmpty()) {
        if (status == 403 && code == "OPERATOR_REQUIRED") return "PAIR_INVITE"
        return code
    }
    if (status == 403 || body.contains("<html", ignoreCase = true)) return "NET_INTERCEPT"
    return "HTTP $status"
}

fun runsListPath(limit: Int = 50, hidden: Boolean = false): String {
    val q = if (hidden) "&view=hidden" else ""
    return "/mobile/runs?limit=$limit$q"
}
