package app.armada.remote

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BoardLogicTest {
    private fun run(id: String, archived: Boolean) =
        RunDto(id, "m", "/p", "p", "completed", archived = archived)

    @Test
    fun hideIsOptimisticThenStreamCannotUnhide() {
        val start = BoardLists(listOf(run("r1", false)), emptyList(), emptySet(), emptySet())
        val hidden = applyLocalArchive(start, "r1", archived = true)
        assertEquals(0, hidden.runs.size)
        assertEquals(true, hidden.hidden.single().archived)
        val ignored = applyStreamRun(hidden, run("r1", archived = false))
        assertEquals(0, ignored.runs.size)
        assertTrue("r1" in ignored.pendingArchive)
    }

    @Test
    fun revertPutsRunBackOnFailure() {
        val start = BoardLists(listOf(run("r1", false)), emptyList(), emptySet(), emptySet())
        val hidden = applyLocalArchive(start, "r1", archived = true)
        val back = revertLocalArchive(hidden, "r1")
        assertEquals(1, back.runs.size)
        assertEquals(false, back.runs.single().archived)
        assertTrue(back.pendingArchive.isEmpty())
    }

    @Test
    fun applyStreamRunUpdatesExistingInPlace() {
        val a = run("a", false).copy(status = "running")
        val b = run("b", false).copy(status = "queued")
        val start = BoardLists(listOf(a, b), emptyList(), emptySet(), emptySet())
        val next = applyStreamRun(start, b.copy(status = "dispatched"))
        assertEquals(listOf("a", "b"), next.runs.map { it.runId })
        assertEquals("dispatched", next.runs[1].status)
    }

    @Test
    fun applyStreamRunInsertsUnknownAtFront() {
        val a = run("a", false)
        val start = BoardLists(listOf(a), emptyList(), emptySet(), emptySet())
        val next = applyStreamRun(start, run("b", false))
        assertEquals(listOf("b", "a"), next.runs.map { it.runId })
    }

    @Test
    fun applyStreamRunSkipsUpdatedAtOnly() {
        val first = run("r1", false).copy(status = "running", updatedAt = 1)
        val start = BoardLists(listOf(first), emptyList(), emptySet(), emptySet())
        val next = applyStreamRun(start, first.copy(updatedAt = 99))
        assertTrue(next === start)
        assertEquals(1, next.runs.single().updatedAt)
    }

    @Test
    fun applyStreamRunFollowupKeepsBodyUntilNewFinalText() {
        val start = BoardLists(
            listOf(run("r1", false).copy(status = "completed", finalText = "上一折")),
            emptyList(),
            emptySet(),
            emptySet(),
        )
        val live = applyStreamRun(start, run("r1", false).copy(status = "running", finalText = null, prompt = "续聊"))
        assertEquals("上一折", live.runs.single().finalText)
        assertEquals("running", live.runs.single().status)
        assertEquals("续聊", live.runs.single().prompt)
        val done = applyStreamRun(live, run("r1", false).copy(status = "completed", finalText = "新正文"))
        assertEquals("新正文", done.runs.single().finalText)
    }
}
