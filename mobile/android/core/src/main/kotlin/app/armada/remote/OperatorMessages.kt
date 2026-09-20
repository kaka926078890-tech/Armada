package app.armada.remote

fun operatorMessage(code: String): String = when (code) {
    "CONVERSATION_BUSY" -> "该对话仍在排队或绑定，结束后才能续聊"
    "NO_CONVERSATION" -> "还没有绑上 Cursor 对话，不能续聊"
    "INJECT_SLOT_BUSY" -> "这台机器正在注入另一条任务，稍后再试"
    "CDP_NOT_READY" -> "Cursor 在线但无法注入。请确认已安装最新 Armada 扩展，并用 Armada 打开工作区。若窗口已开、调试口不通：请完全退出 Cursor（Mac Cmd+Q / Windows 托盘 Exit），不要点 Cursor 图标。"
    "WORKSPACE_NOT_OPEN" -> "工作区没有打开"
    "CLOSED" -> "这条对话已关闭"
    "PROMPT_COLLISION" -> "同一工作区已有相同内容的任务"
    "HUB_OFFLINE" -> "中台离线"
    "HUB_TIMEOUT" -> "中台处理超时，请再发一次"
    "RATE_LIMIT" -> "点得太快，请稍后再发"
    "EMPTY_PROMPT" -> "写点字或加一张图"
    "NET_INTERCEPT" -> "当前网络拦截了中转。请关掉 Wi‑Fi 改用蜂窝，或换一个网络后再打开。"
    "OUTBOUND_LIMIT" -> "待消化续发已达上限，等 Cursor 消化后再发"
    "OUTBOUND_TEXT_ONLY" -> "运行中只能发文字"
    "INVALID_STATE" -> "当前状态不能重试"
    "NOT_FOUND" -> "任务不存在"
    "INVALID" -> "推送登记失败"
    "ATTACHMENT_TOO_LARGE" -> "单张不能超过 8 MB"
    "ATTACHMENT_INVALID_MIME" -> "只支持 PNG / JPEG"
    "ATTACHMENT_COUNT" -> "最多 4 张图"
    "ATTACHMENT_NOT_FOUND" -> "图片还没传到中台，请重试"
    "IMAGE_PASTE_DISABLED" -> "被控机关了贴图"
    "IMAGE_PASTE_FAILED" -> "图片没贴进 Cursor，请重试"
    "NO_ROUTE" -> "当前中转还不支持发图"
    "SNIPPET_INVALID" -> "标题和提示词都不能为空，且不要超长"
    "SNIPPET_LIMIT" -> "最多 30 条快捷提示词"
    "READ_FAIL" -> "读取快捷提示词失败"
    "WRITE_FAIL" -> "保存失败，请重试"
    "MACHINE_OFFLINE" -> "机器离线"
    "RUN_LIMIT" -> "这台机器任务数已满"
    "WINDOW_BUSY" -> "该窗口正忙"
    "ASK_INVALID_OPTION" -> "选项无效，请改选或 Skip"
    "ASK_TEXT_EMPTY" -> "先写回复，或不选选项去点上面的答案"
    "ASK_TEXT_TOO_LONG" -> "回复太长，请缩短后再发"
    "ASK_IN_FLIGHT" -> "正在提交，请稍候"
    "NO_PENDING_ASK" -> "当前没有待回答的问题"
    "ASK_MISMATCH" -> "问题已更新，请刷新后再答"
    "NO_ASSISTANT_BODY" -> "任务已完成，正文尚未生成"
    else -> code
}

fun appendSnippetBody(current: String, body: String): String {
    val trimmedEnd = body.trimEnd()
    if (current.isEmpty()) return trimmedEnd
    return if (current.endsWith("\n")) current + trimmedEnd else "$current\n$trimmedEnd"
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
