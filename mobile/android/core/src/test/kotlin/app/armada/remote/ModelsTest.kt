package app.armada.remote

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ModelsTest {
    private fun run(status: String, archived: Boolean? = false, ask: PendingAskDto? = null, finalText: String? = null) =
        RunDto("r1", "m1", "/proj", "do it", status, finalText, pendingAsk = ask, archived = archived, updatedAt = 10)

    @Test
    fun columnsMatchIos() {
        assertEquals(BoardColumn.Waiting, BoardColumn.column("queued"))
        assertEquals(BoardColumn.Running, BoardColumn.column("running"))
        assertEquals(BoardColumn.Completed, BoardColumn.column("completed"))
        assertEquals(BoardColumn.Cancelled, BoardColumn.column("aborted"))
        assertEquals(BoardColumn.Error, BoardColumn.column("unknown"))
    }

    @Test
    fun followupAndArchiveGates() {
        val live = run("running")
        assertTrue(live.isLive)
        assertTrue(live.canFollowup)
        assertFalse(live.showsArchive)
        val done = run("completed")
        assertTrue(done.showsArchive)
        val asking = run("running", ask = PendingAskDto("q", emptyList()))
        assertFalse(asking.canFollowup)
    }

    @Test
    fun planAskIsSingleBuildOption() {
        val plan = PendingAskDto(
            "rid",
            listOf(PendingAskQuestion("q", "Created Plan", options = listOf(PendingAskOption("build", "Build", "Build")))),
        )
        assertTrue(isPlanAsk(plan))
        val normal = PendingAskDto(
            "rid",
            listOf(
                PendingAskQuestion(
                    "q",
                    "pick",
                    options = listOf(PendingAskOption("a", "A", "one"), PendingAskOption("b", "B", "two")),
                ),
            ),
        )
        assertFalse(isPlanAsk(normal))
    }

    @Test
    fun keepListBodiesRetainsLocalFinalText() {
        val prior = listOf(run("completed", finalText = "FULL"))
        val incoming = listOf(run("completed", finalText = null))
        assertEquals("FULL", keepListBodies(incoming, prior).single().finalText)
    }

    @Test
    fun coalesceFinalTextKeepsPriorWhenIncomingNull() {
        val prior = run("completed", finalText = "上一折")
        val incoming = run("running", finalText = null)
        assertEquals("上一折", coalesceFinalText(incoming, prior).finalText)
        assertEquals("running", coalesceFinalText(incoming, prior).status)
    }

    @Test
    fun coalesceFinalTextPrefersIncomingBody() {
        val prior = run("running", finalText = "上一折")
        val incoming = run("completed", finalText = "新正文")
        assertEquals("新正文", coalesceFinalText(incoming, prior).finalText)
    }

    @Test
    fun detailShouldReloadWhenLiveBecomesTerminal() {
        assertTrue(detailShouldReload(run("running", finalText = "旧"), run("completed", finalText = "新")))
        assertTrue(detailShouldReload(run("running", finalText = "旧"), run("completed", finalText = null)))
        assertFalse(detailShouldReload(run("completed", finalText = "旧"), run("running", finalText = null)))
        assertFalse(detailShouldReload(run("completed", finalText = "旧"), run("completed", finalText = "旧")))
        assertFalse(detailShouldReload(null, run("completed", finalText = "新")))
    }

    @Test
    fun unreadAskAndCompleted() {
        val ask = run("running", ask = PendingAskDto("q"))
        assertTrue(isUnread(ask, emptyMap()))
        assertFalse(isUnread(ask, mapOf("r1" to 20.0)))
        val done = run("completed")
        assertTrue(isUnread(done, emptyMap()))
        assertFalse(isUnread(done, mapOf("r1" to 20.0)))
    }

    @Test
    fun stampReadAtCoversActivityEvenIfClockIsBehind() {
        assertEquals(20.0, stampReadAt(5.0, 20))
        assertEquals(21.0, stampReadAt(21.0, 20))
        assertEquals(9.0, stampReadAt(9.0, null))
    }

    @Test
    fun watchingCompleteWithoutRestampStaysUnread() {
        val done = run("completed").copy(updatedAt = 20)
        assertTrue(isUnread(done, mapOf("r1" to 5.0)))
    }

    @Test
    fun watchingCompleteRestampClearsUnread() {
        val done = run("completed").copy(updatedAt = 20)
        val seen = stampReadAt(5.0, done.activityTs)
        assertFalse(isUnread(done, mapOf("r1" to seen)))
    }

    @Test
    fun canMarkUnreadOnlyWhenReadAndAlertable() {
        val done = run("completed")
        assertFalse(canMarkUnread(done, emptyMap()))
        assertTrue(canMarkUnread(done, mapOf("r1" to 20.0)))
        val live = run("running")
        assertFalse(canMarkUnread(live, mapOf("r1" to 20.0)))
        val cancelled = run("cancelled")
        assertFalse(canMarkUnread(cancelled, mapOf("r1" to 20.0)))
        val ask = run("running", ask = PendingAskDto("q"))
        assertTrue(canMarkUnread(ask, mapOf("r1" to 20.0)))
        assertFalse(canMarkUnread(ask, emptyMap()))
    }

    @Test
    fun markUnreadRemovesStampSoItCountsAgain() {
        val done = run("completed").copy(updatedAt = 10)
        val after = readAtAfterMarkUnread(mapOf("r1" to 20.0, "r2" to 3.0), "r1")
        assertTrue(isUnread(done, after))
        assertEquals(setOf("r2"), after.keys)
        assertFalse(shouldStampOpened(setOf("r1"), "r1"))
        assertTrue(shouldStampOpened(emptySet(), "r1"))
    }

    @Test
    fun missingCdpReadyIsNotInjectable() {
        val omitted = WorkspaceDto("w", "m", "/p", "p")
        assertFalse(omitted.cdpReady)
        assertFalse(omitted.canInject)
        val ready = omitted.copy(cdpReady = true)
        assertTrue(ready.canInject)
        assertFalse(ready.copy(online = false).canInject)
    }

    @Test
    fun runContentEqualsIgnoresUpdatedAtOnly() {
        val a = run("running").copy(updatedAt = 1)
        val b = run("running").copy(updatedAt = 99)
        assertTrue(runContentEquals(a, b))
        assertFalse(runContentEquals(a, b.copy(status = "completed")))
        assertFalse(runContentEquals(a, b.copy(prompt = "other")))
        assertFalse(runContentEquals(a, b.copy(finalText = "x")))
    }

    @Test
    fun optionalChangedAndBadgeSkipNoops() {
        assertFalse(optionalChanged(null, null))
        assertFalse(optionalChanged("e", "e"))
        assertTrue(optionalChanged("e", null))
        assertTrue(optionalChanged(null, "e"))
        assertFalse(shouldUpdateBadge(0, 0))
        assertTrue(shouldUpdateBadge(0, 2))
    }

    @Test
    fun liveWorkspacePrefersSessionSlotOverStaleSnapshot() {
        val stale = WorkspaceDto("w", "m", "/p", "p", online = true, cdpReady = false)
        val live = stale.copy(cdpReady = true)
        assertTrue(liveWorkspace("w", listOf(live), stale)!!.canInject)
        assertFalse(liveWorkspace("w", emptyList(), stale)!!.canInject)
        assertEquals(null, liveWorkspace("missing", listOf(live)))
    }
}
