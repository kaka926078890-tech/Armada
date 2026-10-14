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
    fun archiveChipDoesNotStaySelectedWithHiddenView() {
        assertTrue(archiveChipSelected(showingArchived = false, columnSelected = true))
        assertFalse(archiveChipSelected(showingArchived = true, columnSelected = true))
        assertFalse(archiveChipSelected(showingArchived = false, columnSelected = false))
    }

    @Test
    fun boardCardElapsedIsCompact() {
        assertEquals("12s", boardCardElapsed(1_000L, 13_000L))
        assertEquals("3m", boardCardElapsed(1_000L, 181_000L))
        assertEquals("2h", boardCardElapsed(1_000L, 7_201_000L))
        assertEquals(null, boardCardElapsed(null, 10_000L))
        assertEquals(null, boardCardElapsed(0L, 10_000L))
    }

    @Test
    fun unreadBadgeTextMatchesIos() {
        assertEquals(null, unreadBadgeText(0))
        assertEquals("1", unreadBadgeText(1))
        assertEquals("99+", unreadBadgeText(100))
    }

    @Test
    fun paletteMatchesHubTokens() {
        val light = iosPaletteArgb(false)
        val dark = iosPaletteArgb(true)
        assertEquals(0xFF171717L, light.accent)
        assertEquals(0xFFE5E5E5L, dark.accent)
        assertEquals(0xFFFAFAFAL, light.onAccent)
        assertEquals(0xFF171717L, dark.onAccent)
        assertEquals(0xFF34D399L, light.green)
        assertEquals(0xFF34D399L, dark.green)
        assertEquals(0xFFDC2626L, light.red)
        assertEquals(0xFFF87171L, dark.red)
        assertEquals(0xFF38BDF8L, dark.blue)
        assertEquals(0xFFD9973AL, light.orange)
        assertEquals(0xFFF1B467L, dark.orange)
        assertEquals(0xFF737373L, light.gray)
        assertEquals(0xFFA3A3A3L, dark.gray)
        assertEquals(0xFFFFFFFFL, light.page)
        assertEquals(0xFF0A0A0AL, dark.page)
        assertEquals(0xFFF5F5F5L, light.secondary)
        assertEquals(0xFF262626L, dark.secondary)
        assertEquals(0xFFFFFFFFL, light.cell)
        assertEquals(0xFF171717L, dark.cell)
        assertEquals(0xFF599CE7L, dark.ask)
        assertEquals(0xFF3B82C4L, light.ask)
        assertEquals(0x1AFFFFFFL, dark.border)
        assertEquals(0xFFE5E5E5L, light.border)
    }
}
