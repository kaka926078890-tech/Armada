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
