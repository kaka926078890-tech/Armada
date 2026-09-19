package app.armada.remote

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ChromeLogicTest {
    private fun run(status: String, unreadAsk: Boolean = false) = RunDto(
        "r1",
        "m",
        "/p",
        "p",
        status,
        pendingAsk = if (unreadAsk) PendingAskDto("q") else null,
    )

    @Test
    fun rowChromeMatchesIos() {
        assertEquals(RowChrome.Red, runRowChrome(run("running", unreadAsk = true), unread = false))
        assertEquals(RowChrome.Green, runRowChrome(run("completed"), unread = true))
        assertEquals(RowChrome.Red, runRowChrome(run("error"), unread = true))
        assertEquals(RowChrome.None, runRowChrome(run("completed"), unread = false))
        assertEquals(RowChrome.None, runRowChrome(run("cancelled"), unread = true))
    }

    @Test
    fun statusTintMatchesIos() {
        assertEquals("green", statusTint("completed"))
        assertEquals("blue", statusTint("running"))
        assertEquals("blue", statusTint("queued"))
        assertEquals("red", statusTint("error"))
        assertEquals("gray", statusTint("cancelled"))
        assertEquals("orange", statusTint("other"))
    }

    @Test
    fun promptHeightCapsAt180AndReplyGrows() {
        assertEquals(24f, detailPromptShownHeight(10f))
        assertEquals(80f, detailPromptShownHeight(80f))
        assertEquals(180f, detailPromptShownHeight(400f))
        assertEquals(80f, detailReplyShownHeight(10f))
        assertEquals(400f, detailReplyShownHeight(400f))
    }

    @Test
    fun columnAlertIsRedChromeOnly() {
        val ask = run("running", unreadAsk = true)
        val done = run("completed")
        assertTrue(columnHasAlert(listOf(ask, done), BoardColumn.Running) { false })
        assertFalse(columnHasAlert(listOf(ask, done), BoardColumn.Completed) { it.runId == "r1" && it.status == "completed" })
    }

    @Test
    fun hideArchiveLabelMatchesIos() {
        assertEquals("查看已隐藏", hideArchiveLabel(0, showingArchived = false))
        assertEquals("查看已隐藏 3", hideArchiveLabel(3, showingArchived = false))
        assertEquals("返回看板", hideArchiveLabel(3, showingArchived = true))
    }

    @Test
    fun unreadBadgeTextMatchesIos() {
        assertEquals(null, unreadBadgeText(0))
        assertEquals("1", unreadBadgeText(1))
        assertEquals("99+", unreadBadgeText(100))
    }

    @Test
    fun paletteMatchesIosSystemColorsNotHubPrimary() {
        val light = iosPaletteArgb(false)
        val dark = iosPaletteArgb(true)
        assertEquals(0xFF007AFFL, light.accent)
        assertEquals(0xFF0A84FFL, dark.accent)
        assertEquals(0xFF34C759L, light.green)
        assertEquals(0xFF30D158L, dark.green)
        assertEquals(0xFFFF3B30L, light.red)
        assertEquals(0xFFFF453AL, dark.red)
        assertEquals(0xFFFF9500L, light.orange)
        assertEquals(0xFFFF9F0AL, dark.orange)
        assertEquals(0xFF8E8E93L, light.gray)
        assertEquals(0xFFFFFFFFL, light.page)
        assertEquals(0xFFF2F2F7L, light.secondary)
        assertEquals(0xFF1C1C1EL, dark.cell)
        assertTrue(light.accent != 0xFF599CE7L)
        assertTrue(light.green != 0xFF22C55EL)
        assertTrue(light.red != 0xFFDC2626L)
    }
}
