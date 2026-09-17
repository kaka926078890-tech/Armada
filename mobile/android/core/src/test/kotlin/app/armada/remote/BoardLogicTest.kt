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
