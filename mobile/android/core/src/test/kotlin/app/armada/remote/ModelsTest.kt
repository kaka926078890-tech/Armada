package app.armada.remote

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ModelsTest {
    private fun run(
        status: String,
        archived: Boolean? = false,
        ask: PendingAskDto? = null,
        finalText: String? = null,
        conversationId: String? = null,
        title: String? = null,
    ) = RunDto(
        "r1", "m1", "/proj", "do it", status, finalText,
        pendingAsk = ask, archived = archived, updatedAt = 10,
        title = title, conversationId = conversationId,
    )

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
        val live = run("running", conversationId = "cid-1")
        assertTrue(live.isLive)
        assertTrue(live.canFollowup)
        assertFalse(live.showsArchive)
        assertFalse(run("running").canFollowup)
        assertFalse(run("completed").canFollowup)
        val done = run("completed")
        assertTrue(done.showsArchive)
        val asking = run("running", ask = PendingAskDto("q", emptyList()), conversationId = "cid-1")
        assertFalse(asking.canFollowup)
        assertEquals("短标题", run("running", title = "短标题").displayTitle)
        assertEquals("do it", run("running").displayTitle)
        assertEquals("[2 张图片]", run("dispatched").copy(prompt = "", attachments = listOf(
            RunAttachmentDto("a"),
            RunAttachmentDto("b"),
        )).displayTitle)
        assertTrue(canAcceptMoreAttachments(3, 1))
        assertFalse(canAcceptMoreAttachments(4, 1))
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47)
        val jpeg = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte())
        assertEquals("image/png", imageMagicMime(png))
        assertEquals("image/jpeg", imageMagicMime(jpeg))
        assertEquals(null, imageMagicMime(byteArrayOf(0x00, 0x01)))
    }

    @Test
    fun askOptionBodyDropsDuplicatedLetter() {
        assertEquals("芯片只显示 A/B/C", askOptionBody("A", "A：芯片只显示 A/B/C"))
        assertEquals("甲", askOptionBody("A", "A 甲"))
        assertEquals("甲", askOptionBody("A", "甲"))
        assertEquals("", askOptionBody("A", "A"))
        assertEquals("Other...", askOptionBody("D", "Other..."))
    }

    @Test
    fun visibleAskOptionsSynthesizesDWhenCdpOmittedOther() {
        val abc = listOf(
            PendingAskOption("a", "A", "甲"),
            PendingAskOption("b", "B", "乙"),
            PendingAskOption("c", "C", "丙"),
        )
        val rows = visibleAskOptions(abc)
        assertEquals("__freeform__", rows.last().id)
        assertEquals("D", rows.last().label)
        assertEquals(true, rows.last().freeform)
        val withD = visibleAskOptions(abc + PendingAskOption("d", "D", "Other...", true))
        assertEquals("d", withD.last().id)
        assertTrue(isFreeformAskOption(withD, "d"))
        assertFalse(isFreeformAskOption(withD, "a"))
    }

    @Test
    fun planAskIsKindPlanOnly() {
        val buildWithoutKind = PendingAskDto(
            "rid",
            listOf(PendingAskQuestion("q", "Created Plan", options = listOf(PendingAskOption("build", "Build", "Build")))),
        )
        assertFalse(isPlanAsk(buildWithoutKind))
        val planOtherId = PendingAskDto(
            "rid",
            listOf(PendingAskQuestion("q", "Created Plan", options = listOf(PendingAskOption("go", "Go", "Go")))),
            kind = "plan",
        )
        assertTrue(isPlanAsk(planOtherId))
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
    fun continueAllowedMatchesHubShape() {
        val one = PendingAskDto(
            "rid",
            listOf(PendingAskQuestion("q", "pick", options = listOf(PendingAskOption("a", "A", "one")))),
        )
        assertTrue(continueAllowed(one))
        val two = PendingAskDto(
            "rid",
            listOf(
                PendingAskQuestion("q1", "one", options = listOf(PendingAskOption("a", "A", "a"))),
                PendingAskQuestion("q2", "two", options = listOf(PendingAskOption("b", "B", "b"))),
            ),
        )
        assertFalse(continueAllowed(two))
        val multi = PendingAskDto(
            "rid",
            listOf(
                PendingAskQuestion(
                    "q",
                    "pick",
                    allowMultiple = true,
                    options = listOf(PendingAskOption("a", "A", "one"), PendingAskOption("b", "B", "two")),
                ),
            ),
        )
        assertFalse(continueAllowed(multi))
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
    fun shouldStampReadAtOnlyWhenActivityAdvancesPastSeen() {
        assertTrue(shouldStampReadAt(null, 10))
        assertTrue(shouldStampReadAt(null, null))
        assertFalse(shouldStampReadAt(20.0, 10))
        assertFalse(shouldStampReadAt(20.0, 20))
        assertFalse(shouldStampReadAt(20.0, null))
        assertTrue(shouldStampReadAt(20.0, 21))
    }

    @Test
    fun shouldStampReadAtSkipsUpdatedAtOnlyAfterWallClockStamp() {
        val seen = stampReadAt(1000.0, 20)
        assertFalse(shouldStampReadAt(seen, 20))
        assertFalse(shouldStampReadAt(seen, 99))
        assertTrue(shouldStampReadAt(seen, 1001))
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
        assertFalse(runContentEquals(a, b.copy(attachments = listOf(RunAttachmentDto("a")))))
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
    fun followupAckReadsExplicitOutcomeNotHttpStatus() {
        assertEquals("queued", followupOutcomeOrNull("queued"))
        assertEquals("injected", followupOutcomeOrNull("injected"))
        assertEquals(null, followupOutcomeOrNull("201"))
        assertEquals(null, followupOutcomeOrNull(""))
        assertEquals(null, followupOutcomeOrNull(null))
        val queued = parseFollowupAck(
            run("running", conversationId = "cid-1"),
            "queued",
        )
        assertEquals("queued", queued.outcome)
        assertEquals("r1", queued.run.runId)
        val injected = parseFollowupAck(run("dispatched", conversationId = "cid-1"), "injected")
        assertEquals("injected", injected.outcome)
        val unknown = parseFollowupAck(run("dispatched"), "201")
        assertEquals(null, unknown.outcome)
    }

    @Test
    fun markAllReadScopesMachineWorkspaceAndColumn() {
        fun task(
            id: String,
            status: String,
            machineId: String = "m1",
            root: String = "/a",
            ask: PendingAskDto? = null,
            updatedAt: Long = 10,
        ) = RunDto(id, machineId, root, "p", status, pendingAsk = ask, updatedAt = updatedAt)

        val doneA = task("done-a", "completed")
        val doneB = task("done-b", "completed", root = "/b")
        val errA = task("err-a", "error")
        val otherMachine = task("done-m2", "completed", machineId = "m2")
        val askA = task("ask-a", "running", ask = PendingAskDto("q"))
        val liveA = task("live-a", "running")
        val abortedA = task("aborted-a", "aborted")
        val already = task("seen-a", "completed")
        val rows = listOf(doneA, doneB, errA, otherMachine, askA, liveA, abortedA, already)
        val seen = mapOf("seen-a" to 20.0)

        val none = applyMarkAllRead(seen, emptyList(), 50.0, MarkReadScope.Machine("m1"))
        assertTrue(none.readAt === seen)
        assertTrue(none.stampedIds.isEmpty())
        assertEquals(0, unreadMatchingCount(emptyList(), seen, MarkReadScope.Machine("m1")))

        val machine = applyMarkAllRead(seen, rows, 50.0, MarkReadScope.Machine("m1"))
        assertEquals(setOf("done-a", "done-b", "err-a", "ask-a", "aborted-a"), machine.stampedIds)
        assertEquals(50.0, machine.readAt["done-a"])
        assertEquals(20.0, machine.readAt["seen-a"])
        assertEquals(null, machine.readAt["done-m2"])
        assertEquals(null, machine.readAt["live-a"])
        assertFalse(isUnread(doneA, machine.readAt))
        assertTrue(isUnread(otherMachine, machine.readAt))
        assertEquals(0, unreadMatchingCount(rows, machine.readAt, MarkReadScope.Machine("m1")))
        assertEquals(1, unreadMatchingCount(rows, machine.readAt, MarkReadScope.Machine("m2")))

        val workspace = applyMarkAllRead(seen, rows, 50.0, MarkReadScope.Workspace("m1", "/a"))
        assertEquals(setOf("done-a", "err-a", "ask-a", "aborted-a"), workspace.stampedIds)
        assertTrue(isUnread(doneB, workspace.readAt))

        val completed = applyMarkAllRead(seen, rows, 50.0, MarkReadScope.Column("m1", "/a", BoardColumn.Completed))
        assertEquals(setOf("done-a"), completed.stampedIds)
        assertTrue(isUnread(errA, completed.readAt))
        assertTrue(isUnread(askA, completed.readAt))

        val errorCol = applyMarkAllRead(seen, rows, 50.0, MarkReadScope.Column("m1", "/a", BoardColumn.Error))
        assertEquals(setOf("err-a"), errorCol.stampedIds)
        assertTrue(isUnread(doneA, errorCol.readAt))

        val runningCol = applyMarkAllRead(seen, rows, 50.0, MarkReadScope.Column("m1", "/a", BoardColumn.Running))
        assertEquals(setOf("ask-a"), runningCol.stampedIds)

        val cancelledCol = applyMarkAllRead(seen, rows, 9.0, MarkReadScope.Column("m1", "/a", BoardColumn.Cancelled))
        assertEquals(setOf("aborted-a"), cancelledCol.stampedIds)
        assertEquals(10.0, cancelledCol.readAt["aborted-a"])
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
