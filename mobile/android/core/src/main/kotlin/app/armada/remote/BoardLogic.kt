package app.armada.remote

data class BoardLists(
    val runs: List<RunDto>,
    val hidden: List<RunDto>,
    val pendingArchive: Set<String>,
    val pendingUnarchive: Set<String>,
)

fun applyLocalArchive(state: BoardLists, runId: String, archived: Boolean, snapshot: RunDto? = null): BoardLists {
    if (archived) {
        val moved = snapshot
            ?: state.runs.firstOrNull { it.runId == runId }
            ?: state.hidden.firstOrNull { it.runId == runId }
        val nextHidden = if (moved != null) {
            listOf(moved.copy(archived = true)) + state.hidden.filter { it.runId != runId }
        } else state.hidden.filter { it.runId != runId }
        return state.copy(
            runs = state.runs.filter { it.runId != runId },
            hidden = nextHidden,
            pendingArchive = state.pendingArchive + runId,
            pendingUnarchive = state.pendingUnarchive - runId,
        )
    }
    val moved = snapshot
        ?: state.hidden.firstOrNull { it.runId == runId }
        ?: state.runs.firstOrNull { it.runId == runId }
    val nextRuns = if (moved != null) {
        listOf(moved.copy(archived = false)) + state.runs.filter { it.runId != runId }
    } else state.runs.filter { it.runId != runId }
    return state.copy(
        hidden = state.hidden.filter { it.runId != runId },
        runs = nextRuns,
        pendingArchive = state.pendingArchive - runId,
        pendingUnarchive = state.pendingUnarchive + runId,
    )
}

fun revertLocalArchive(state: BoardLists, runId: String): BoardLists {
    if (runId in state.pendingArchive) {
        val moved = state.hidden.firstOrNull { it.runId == runId }
        val nextRuns = if (moved != null) {
            listOf(moved.copy(archived = false)) + state.runs.filter { it.runId != runId }
        } else state.runs
        return state.copy(
            pendingArchive = state.pendingArchive - runId,
            hidden = state.hidden.filter { it.runId != runId },
            runs = nextRuns,
        )
    }
    if (runId in state.pendingUnarchive) {
        val moved = state.runs.firstOrNull { it.runId == runId }
        val nextHidden = if (moved != null) {
            listOf(moved.copy(archived = true)) + state.hidden.filter { it.runId != runId }
        } else state.hidden
        return state.copy(
            pendingUnarchive = state.pendingUnarchive - runId,
            runs = state.runs.filter { it.runId != runId },
            hidden = nextHidden,
        )
    }
    return state
}

fun upsertRun(list: List<RunDto>, run: RunDto): List<RunDto> {
    val i = list.indexOfFirst { it.runId == run.runId }
    if (i < 0) return listOf(run) + list
    return list.mapIndexed { idx, item -> if (idx == i) run else item }
}

fun applyStreamRun(state: BoardLists, run: RunDto): BoardLists {
    if (run.runId in state.pendingArchive && !run.isArchived) return state
    if (run.runId in state.pendingUnarchive && run.isArchived) return state
    var pendingA = state.pendingArchive
    var pendingU = state.pendingUnarchive
    if (run.runId in pendingA && run.isArchived) pendingA = pendingA - run.runId
    if (run.runId in pendingU && !run.isArchived) pendingU = pendingU - run.runId
    val prior = state.runs.firstOrNull { it.runId == run.runId }
        ?: state.hidden.firstOrNull { it.runId == run.runId }
    val adopted = coalesceFinalText(run, prior)
    if (
        prior != null &&
        runContentEquals(prior, adopted) &&
        prior.isArchived == adopted.isArchived
    ) {
        if (pendingA == state.pendingArchive && pendingU == state.pendingUnarchive) return state
        return state.copy(pendingArchive = pendingA, pendingUnarchive = pendingU)
    }
    return if (adopted.isArchived) {
        state.copy(
            runs = state.runs.filter { it.runId != adopted.runId },
            hidden = upsertRun(state.hidden, adopted),
            pendingArchive = pendingA,
            pendingUnarchive = pendingU,
        )
    } else {
        state.copy(
            hidden = state.hidden.filter { it.runId != adopted.runId },
            runs = upsertRun(state.runs, adopted),
            pendingArchive = pendingA,
            pendingUnarchive = pendingU,
        )
    }
}

fun adoptFetchedLists(
    current: BoardLists,
    incomingRuns: List<RunDto>,
    incomingHidden: List<RunDto>,
): BoardLists {
    var nextRuns = keepListBodies(incomingRuns, current.runs).toMutableList()
    var nextHidden = keepListBodies(incomingHidden, current.hidden).toMutableList()
    var stillA = current.pendingArchive.toMutableSet()
    var stillU = current.pendingUnarchive.toMutableSet()
    for (id in current.pendingArchive) {
        if (incomingHidden.any { it.runId == id }) stillA.remove(id)
        else {
            nextRuns.removeAll { it.runId == id }
            val local = current.hidden.firstOrNull { it.runId == id }
            if (local != null && nextHidden.none { it.runId == id }) nextHidden.add(0, local)
        }
    }
    for (id in current.pendingUnarchive) {
        if (incomingRuns.any { it.runId == id } && incomingHidden.none { it.runId == id }) stillU.remove(id)
        else {
            nextHidden.removeAll { it.runId == id }
            val local = current.runs.firstOrNull { it.runId == id }
            if (local != null && nextRuns.none { it.runId == id }) nextRuns.add(0, local)
        }
    }
    return BoardLists(nextRuns, nextHidden, stillA, stillU)
}
