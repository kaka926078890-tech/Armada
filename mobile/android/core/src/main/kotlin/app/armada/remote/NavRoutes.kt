package app.armada.remote

fun encodeNavArg(value: String): String {
    val sb = StringBuilder()
    for (byte in value.toByteArray(Charsets.UTF_8)) {
        val c = byte.toInt() and 0xFF
        val ch = c.toChar()
        if (ch.isLetterOrDigit() || ch == '-' || ch == '.' || ch == '_' || ch == '~') {
            sb.append(ch)
        } else {
            sb.append('%')
            sb.append(c.toString(16).uppercase().padStart(2, '0'))
        }
    }
    return sb.toString()
}

fun decodeNavArg(value: String): String = java.net.URLDecoder.decode(value, Charsets.UTF_8)

fun workspaceNavRoute(id: String): String = "ws?id=${encodeNavArg(id)}"

fun runNavRoute(id: String): String = "run?id=${encodeNavArg(id)}"

fun fileNavRoute(runId: String, path: String): String =
    "file?runId=${encodeNavArg(runId)}&path=${encodeNavArg(path)}"
