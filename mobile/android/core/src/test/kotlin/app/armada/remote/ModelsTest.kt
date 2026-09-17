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
}
