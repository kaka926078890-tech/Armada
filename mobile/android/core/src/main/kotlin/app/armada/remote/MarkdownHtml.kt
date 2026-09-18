package app.armada.remote

object MarkdownHtml {
    fun from(source: String, fontScale: String = "normal", theme: String = "dark"): String {
        val inner = splitFences(source.replace("\r\n", "\n")).joinToString("") { renderBlock(it) }
        val zoom = when (fontScale) {
            "large" -> "1.5"
            "xlarge" -> "2"
            else -> "1"
        }
        val dark = theme == "dark"
        val fg = if (dark) "#e4e4e7" else "#27272a"
        val codeBg = if (dark) "#18181b" else "#f4f4f5"
        val codeFg = if (dark) "#e4e4e7" else "#27272a"
        return """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>
:root { color-scheme: ${if (dark) "dark" else "light"}; }
html { zoom: $zoom; }
html, body { margin: 0; padding: 0; }
body { font: 13px/1.65 sans-serif; color: $fg; word-wrap: break-word; overflow-wrap: anywhere; }
pre, code { font-family: ui-monospace, monospace; font-size: 12px; background: $codeBg; color: $codeFg; }
pre { padding: 10px; border-radius: 6px; overflow-x: auto; }
code { padding: 1px 4px; border-radius: 4px; }
</style></head><body>$inner</body></html>"""
    }

    private sealed class Block {
        data class Html(val html: String) : Block()
        data class Fence(val code: String) : Block()
    }

    private fun splitFences(source: String): List<Block> {
        val out = mutableListOf<Block>()
        var rest = source
        while (true) {
            val start = rest.indexOf("```")
            if (start < 0) {
                if (rest.trim().isNotEmpty()) out += parseFlow(rest).map { Block.Html(it) }
                break
            }
            val before = rest.substring(0, start)
            if (before.trim().isNotEmpty()) out += parseFlow(before).map { Block.Html(it) }
            rest = rest.substring(start + 3)
            val nl = rest.indexOf('\n')
            rest = if (nl < 0) "" else rest.substring(nl + 1)
            val end = rest.indexOf("```")
            if (end >= 0) {
                out += Block.Fence(rest.substring(0, end).trim('\n'))
                rest = rest.substring(end + 3).removePrefix("\n")
            } else {
                out += Block.Fence(rest)
                rest = ""
            }
        }
        return out
    }

    private fun renderBlock(b: Block): String = when (b) {
        is Block.Fence -> "<pre><code>${escape(b.code)}</code></pre>"
        is Block.Html -> b.html
    }

    private fun parseFlow(text: String): List<String> {
        val lines = text.split("\n")
        var i = 0
        val out = mutableListOf<String>()
        while (i < lines.size) {
            val t = lines[i].trim()
            if (t.isEmpty()) { i++; continue }
            if (t.startsWith("# ")) { out += "<h1>${inline(t.removePrefix("# "))}</h1>"; i++; continue }
            if (t.startsWith("## ")) { out += "<h2>${inline(t.removePrefix("## "))}</h2>"; i++; continue }
            if (t.startsWith("### ")) { out += "<h3>${inline(t.removePrefix("### "))}</h3>"; i++; continue }
            if (t.startsWith("- ") || t.startsWith("* ")) {
                val items = mutableListOf<String>()
                while (i < lines.size) {
                    val r = lines[i].trim()
                    when {
                        r.startsWith("- ") -> items += r.removePrefix("- ")
                        r.startsWith("* ") -> items += r.removePrefix("* ")
                        else -> break
                    }
                    i++
                }
                out += "<ul>" + items.joinToString("") { "<li>${inline(it)}</li>" } + "</ul>"
                continue
            }
            out += "<p>${inline(t)}</p>"
            i++
        }
        return out
    }

    private fun inline(raw: String): String {
        var s = escape(raw)
        s = s.replace(Regex("`([^`]+)`"), "<code>$1</code>")
        s = s.replace(Regex("""\*\*([^*]+)\*\*"""), "<strong>$1</strong>")
        s = s.replace(Regex("""\*([^*]+)\*"""), "<em>$1</em>")
        return s
    }

    private fun escape(s: String): String =
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
}
