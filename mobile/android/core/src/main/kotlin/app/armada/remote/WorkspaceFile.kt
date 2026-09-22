package app.armada.remote

import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

object WorkspaceFile {
    const val SCHEME = "armada-file"
    private val PREVIEW_EXTS = setOf(
        "md", "markdown", "txt", "json", "csv", "xml", "yaml", "yml", "html", "htm", "log", "toml",
    )

    fun extOf(name: String): String {
        val base = name.substringAfterLast('/', name).substringAfterLast('\\', name)
        val i = base.lastIndexOf('.')
        if (i <= 0) return ""
        return base.substring(i + 1).lowercase()
    }

    fun decodeHref(href: String): String {
        var s = href.trim()
        if (s.isEmpty()) return ""
        if (s.startsWith("$SCHEME:", ignoreCase = true)) {
            val q = Regex("[?&]p=([^&]*)").find(s)?.groupValues?.getOrNull(1) ?: return ""
            return decode(q)
        }
        if (s.startsWith("file:", ignoreCase = true)) {
            s = s.replace(Regex("^file://", RegexOption.IGNORE_CASE), "")
            s = decode(s)
            if (s.matches(Regex("^/[A-Za-z]:/.*"))) s = s.drop(1)
            return s
        }
        return decode(s)
    }

    fun looksLike(href: String): Boolean {
        val t = href.trim()
        if (t.isEmpty()) return false
        if (Regex("^(https?:|mailto:|tel:|data:|#)", RegexOption.IGNORE_CASE).containsMatchIn(t)) return false
        return extOf(decodeHref(t)) in PREVIEW_EXTS
    }

    fun rewriteHref(href: String): String {
        if (!looksLike(href)) return href
        val path = decodeHref(href)
        return "$SCHEME://preview?p=${encode(path)}"
    }

    fun pathFromHref(href: String): String? {
        if (!looksLike(href)) return null
        return decodeHref(href).trim().takeIf { it.isNotBlank() }
    }

    private fun encode(s: String): String =
        URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20")

    private fun decode(s: String): String = try {
        URLDecoder.decode(s, StandardCharsets.UTF_8)
    } catch (_: Exception) {
        s
    }
}
