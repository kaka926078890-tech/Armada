package app.armada.remote

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class OperatorMessagesTest {
    @Test
    fun copiesIosSentences() {
        assertEquals("工作区没有打开", operatorMessage("WORKSPACE_NOT_OPEN"))
        assertEquals("Cursor 在线但无法注入。请确认已安装最新 Armada 扩展，并用 Armada 打开工作区。若窗口已开、调试口不通：请完全退出 Cursor（Mac Cmd+Q / Windows 托盘 Exit），不要点 Cursor 图标。", operatorMessage("CDP_NOT_READY"))
        assertEquals("当前网络拦截了中转。请关掉 Wi‑Fi 改用蜂窝，或换一个网络后再打开。", operatorMessage("NET_INTERCEPT"))
        assertEquals("运行中不能隐藏", hideError("INVALID_STATE"))
    }

    @Test
    fun snippetErrorsMatchIos() {
        assertEquals("标题和提示词都不能为空，且不要超长", operatorMessage("SNIPPET_INVALID"))
        assertEquals("最多 30 条快捷提示词", operatorMessage("SNIPPET_LIMIT"))
        assertEquals("读取快捷提示词失败", operatorMessage("READ_FAIL"))
        assertEquals("保存失败，请重试", operatorMessage("WRITE_FAIL"))
        assertEquals("推送登记失败", operatorMessage("INVALID"))
    }

    @Test
    fun askAndEmptyBodyMatchDesktop() {
        assertEquals("选项无效，请改选或 Skip", operatorMessage("ASK_INVALID_OPTION"))
        assertEquals("正在提交，请稍候", operatorMessage("ASK_IN_FLIGHT"))
        assertEquals("当前没有待回答的问题", operatorMessage("NO_PENDING_ASK"))
        assertEquals("问题已更新，请刷新后再答", operatorMessage("ASK_MISMATCH"))
        assertEquals("任务已完成，正文尚未生成", operatorMessage("NO_ASSISTANT_BODY"))
    }

    @Test
    fun appendsSnippetBodyLikeIos() {
        assertEquals("提示", appendSnippetBody("", "提示 \n"))
        assertEquals("已有\n提示", appendSnippetBody("已有", "提示 \n"))
        assertEquals("已有\n提示", appendSnippetBody("已有\n", "提示 \n"))
    }

    @Test
    fun html403IsNetIntercept() {
        assertEquals("NET_INTERCEPT", classifyHttp(403, "<html>blocked</html>"))
        assertEquals("PAIR_INVITE", classifyHttp(403, """{"error":"OPERATOR_REQUIRED"}"""))
        assertEquals("HUB_OFFLINE", classifyHttp(503, """{"error":"HUB_OFFLINE"}"""))
    }

    @Test
    fun hiddenListUsesViewHiddenNotArchived() {
        val path = runsListPath(50, hidden = true)
        assertTrue(path.contains("view=hidden"))
        assertFalse(path.contains("archived=1"))
        assertFalse(runsListPath(50, hidden = false).contains("archived"))
    }
}
