package app.armada.remote

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class RelayException(val code: String) : Exception(
    when (code) {
        "PAIR_INVITE" -> "这是中台链接，请粘贴 App 邀请（armada-relay://op）"
        else -> operatorMessage(code)
    },
)

class RelayClient(base: String, private val token: String) {
    val base: String = base.trimEnd('/')
    private val jsonType = "application/json; charset=utf-8".toMediaType()
    private val http = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()
    private val sseHttp = http.newBuilder().readTimeout(90, TimeUnit.SECONDS).build()

    suspend fun workspaces(): Pair<Boolean, List<WorkspaceDto>> {
        val o = JSONObject(get("/mobile/workspaces"))
        val list = o.optJSONArray("workspaces") ?: JSONArray()
        val ws = buildList {
            for (i in 0 until list.length()) add(parseWorkspace(list.getJSONObject(i)))
        }
        return o.optBoolean("hubOffline") to ws
    }

    suspend fun cursorReload(): CursorReloadDto {
        val o = JSONObject(get("/mobile/cursor-reload"))
        val pending = o.optJSONObject("pending")
        return CursorReloadDto(
            needed = o.optBoolean("needed"),
            vsix = pending?.optString("vsix")?.ifBlank { null },
            action = pending?.optString("action")?.ifBlank { null },
        )
    }

    suspend fun setCursorReload(action: String, machineId: String? = null): CursorReloadDto {
        val body = JSONObject().put("action", action)
        if (machineId != null) body.put("machineId", machineId)
        val o = JSONObject(send("/mobile/cursor-reload", "POST", body.toString(), listOf(200)))
        val pending = o.optJSONObject("pending")
        return CursorReloadDto(
            needed = o.optBoolean("needed"),
            vsix = pending?.optString("vsix")?.ifBlank { null },
            action = pending?.optString("action")?.ifBlank { null },
        )
    }

    suspend fun runs(hidden: Boolean = false): List<RunDto> {
        val o = JSONObject(get(runsListPath(50, hidden)))
        val arr = o.optJSONArray("runs") ?: JSONArray()
        val all = buildList {
            for (i in 0 until arr.length()) add(parseRun(arr.getJSONObject(i)))
        }
        return if (hidden) all.filter { it.isArchived } else all.filter { !it.isArchived }
    }

    suspend fun run(id: String): RunDto = parseRun(JSONObject(get("/mobile/runs/$id")))

    suspend fun dispatch(workspaceId: String, prompt: String): RunDto {
        val body = JSONObject().put("workspaceId", workspaceId).put("prompt", prompt)
        return parseRun(JSONObject(send("/mobile/runs", "POST", body.toString(), listOf(201))).getJSONObject("run"))
    }

    suspend fun followup(runId: String, prompt: String): RunDto {
        val body = JSONObject().put("prompt", prompt)
        return parseRun(JSONObject(send("/mobile/runs/$runId/followup", "POST", body.toString(), listOf(200, 201))).getJSONObject("run"))
    }

    suspend fun retry(runId: String): RunDto =
        parseRun(JSONObject(send("/mobile/runs/$runId/retry", "POST", "{}", listOf(200))).getJSONObject("run"))

    suspend fun archive(runId: String): RunDto =
        parseRun(JSONObject(send("/mobile/runs/$runId/archive", "POST", "{}", listOf(200))).getJSONObject("run"))

    suspend fun unarchive(runId: String): RunDto =
        parseRun(JSONObject(send("/mobile/runs/$runId/unarchive", "POST", "{}", listOf(200))).getJSONObject("run"))

    suspend fun answer(runId: String, body: JSONObject) {
        send("/mobile/runs/$runId/answer", "POST", body.toString(), listOf(202, 200), allowEmpty = true)
    }

    suspend fun cancel(runId: String) {
        send("/mobile/runs/$runId/cancel", "POST", "{}", listOf(200), allowEmpty = true)
    }

    suspend fun registerPushToken(fcm: String) {
        val body = JSONObject().put("token", fcm).put("environment", "production").put("platform", "fcm")
        send("/mobile/push-token", "POST", body.toString(), listOf(204), allowEmpty = true)
    }

    suspend fun deletePushToken(fcm: String) {
        val body = JSONObject().put("token", fcm)
        send("/mobile/push-token", "DELETE", body.toString(), listOf(204), allowEmpty = true)
    }

    suspend fun promptSnippets(): List<PromptSnippet> =
        parsePromptSnippets(JSONObject(get("/mobile/prompt-snippets")))

    suspend fun putPromptSnippets(snippets: List<PromptSnippet>): List<PromptSnippet> {
        val items = JSONArray()
        snippets.forEach { snippet ->
            items.put(
                JSONObject()
                    .put("id", snippet.id)
                    .put("title", snippet.title)
                    .put("body", snippet.body),
            )
        }
        val body = JSONObject().put("snippets", items)
        return parsePromptSnippets(JSONObject(send("/mobile/prompt-snippets", "PUT", body.toString(), listOf(200))))
    }

    fun stream(onFrame: (JSONObject) -> Unit, onDone: (Throwable?) -> Unit): EventSource {
        val req = Request.Builder()
            .url("$base/mobile/stream")
            .header("Authorization", "Bearer $token")
            .header("Accept", "text/event-stream")
            .get()
            .build()
        return EventSources.createFactory(sseHttp).newEventSource(req, object : EventSourceListener() {
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                if (data.isBlank()) return
                runCatching { onFrame(JSONObject(data)) }
            }
            override fun onClosed(eventSource: EventSource) { onDone(null) }
            override fun onFailure(eventSource: EventSource, t: Throwable?, response: okhttp3.Response?) {
                onDone(t ?: Exception("sse ${response?.code ?: 0}"))
            }
        })
    }

    private suspend fun get(path: String): String = send(path, "GET", null, listOf(200))

    private suspend fun send(path: String, method: String, body: String?, ok: List<Int>, allowEmpty: Boolean = false): String =
        withContext(Dispatchers.IO) {
            val b = Request.Builder().url(base + path).header("Authorization", "Bearer $token")
            if (body != null) {
                b.method(method, body.toRequestBody(jsonType)).header("Content-Type", "application/json")
            } else {
                b.method(method, null)
            }
            http.newCall(b.build()).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (resp.code !in ok) throw RelayException(classifyHttp(resp.code, text))
                if (text.isBlank() && allowEmpty) "{}" else text
            }
        }
}

private fun parsePromptSnippets(o: JSONObject): List<PromptSnippet> {
    val snippets = o.optJSONArray("snippets") ?: JSONArray()
    return buildList {
        for (i in 0 until snippets.length()) {
            val snippet = snippets.getJSONObject(i)
            add(PromptSnippet(snippet.getString("id"), snippet.getString("title"), snippet.getString("body")))
        }
    }
}

fun parseWorkspace(o: JSONObject) = WorkspaceDto(
    workspaceId = o.getString("workspaceId"),
    machineId = o.getString("machineId"),
    workspaceRoot = o.getString("workspaceRoot"),
    label = o.getString("label"),
    machineName = o.optString("machineName"),
    os = o.optString("os"),
    online = if (o.has("online")) o.optBoolean("online") else true,
    cdpReady = o.optBoolean("cdpReady"),
)

fun parseRun(o: JSONObject) = RunDto(
    runId = o.getString("runId"),
    machineId = o.getString("machineId"),
    workspaceRoot = o.getString("workspaceRoot"),
    prompt = o.getString("prompt"),
    status = o.getString("status"),
    finalText = o.optNullableString("finalText"),
    error = o.optNullableString("error"),
    pendingAsk = o.optJSONObject("pendingAsk")?.let(::parseAsk),
    outbound = o.optJSONArray("outbound")?.let { arr ->
        buildList { for (i in 0 until arr.length()) add(parseOutbound(arr.getJSONObject(i))) }
    },
    queueMessageDefaultBehavior = o.optNullableString("queueMessageDefaultBehavior"),
    canRetry = if (o.has("canRetry")) o.optBoolean("canRetry") else null,
    archived = if (o.has("archived")) o.optBoolean("archived") else null,
    updatedAt = if (o.has("updatedAt")) o.optLong("updatedAt") else null,
    title = o.optNullableString("title"),
    conversationId = o.optNullableString("conversationId"),
)

private fun parseAsk(o: JSONObject): PendingAskDto {
    val qs = o.optJSONArray("questions") ?: JSONArray()
    return PendingAskDto(
        requestId = o.getString("request_id"),
        questions = buildList {
            for (i in 0 until qs.length()) {
                val q = qs.getJSONObject(i)
                val opts = q.optJSONArray("options") ?: JSONArray()
                add(
                    PendingAskQuestion(
                        id = q.getString("id"),
                        prompt = q.getString("prompt"),
                        allowMultiple = if (q.has("allow_multiple")) q.optBoolean("allow_multiple") else null,
                        options = buildList {
                            for (j in 0 until opts.length()) {
                                val op = opts.getJSONObject(j)
                                add(PendingAskOption(op.getString("id"), op.optString("label"), op.optString("text")))
                            }
                        },
                    ),
                )
            }
        },
        kind = o.optString("kind").takeIf { it == "plan" },
    )
}

private fun parseOutbound(o: JSONObject) = OutboundDto(
    id = o.getString("id"),
    prompt = o.getString("prompt"),
    expectedMode = o.optString("expectedMode"),
    state = o.optString("state"),
    createdAt = o.optLong("createdAt"),
)

private fun JSONObject.optNullableString(key: String): String? {
    if (!has(key) || isNull(key)) return null
    val v = optString(key)
    return v.ifEmpty { null }
}
