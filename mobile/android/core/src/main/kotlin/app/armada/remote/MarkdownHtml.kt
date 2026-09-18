package app.armada.remote

object MarkdownHtml {
    const val MEASURE_JS = "document.body ? document.body.offsetHeight : 0"

    fun from(source: String, fontScale: String = "normal", theme: String = "dark"): String {
        val inner = splitFences(source.replace("\r\n", "\n")).joinToString("") { renderBlock(it) }
        val scale = when (fontScale) {
            "large" -> "1.25"
            "xlarge" -> "1.5"
            else -> "1"
        }
        val dark = theme == "dark"
        val fg = if (dark) "#e4e4e7" else "#27272a"
        val heading = if (dark) "#f4f4f5" else "#27272a"
        val muted = if (dark) "#a1a1aa" else "#71717a"
        val codeBg = if (dark) "#18181b" else "#f4f4f5"
        val codeFg = if (dark) "#e4e4e7" else "#27272a"
        val border = if (dark) "#3f3f46" else "#d4d4d8"
        val link = if (dark) "#38bdf8" else "#0284c7"
        val quote = if (dark) "#52525b" else "#d4d4d8"
        return """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>
:root { color-scheme: ${if (dark) "dark" else "light"}; --md-scale: $scale; }
html, body { margin: 0; padding: 0; height: auto; min-height: 0; }
body {
  font: calc(13px * var(--md-scale))/1.65 sans-serif;
  color: $fg;
  word-wrap: break-word;
  overflow-wrap: anywhere;
}
h1 { font-size: calc(16px * var(--md-scale)); font-weight: 600; margin: 12px 0 4px; color: $heading; }
h2 { font-size: calc(15px * var(--md-scale)); font-weight: 600; margin: 12px 0 4px; color: $heading; }
h3 { font-size: calc(14px * var(--md-scale)); font-weight: 500; margin: 12px 0 4px; color: $heading; }
p { margin: 0 0 8px; }
ul, ol { margin: 0 0 8px; padding-left: 20px; }
li { margin: 2px 0; }
strong { font-weight: 600; }
em { font-style: italic; }
hr { border: none; border-top: 1px solid $border; margin: 12px 0; }
blockquote { border-left: 2px solid $quote; padding-left: 12px; color: $muted; margin: 0 0 8px; }
a { color: $link; text-decoration: none; }
pre {
  margin: 0 0 8px; padding: 10px; border-radius: 6px;
  background: $codeBg; color: $codeFg; overflow-x: auto; font-size: calc(12px * var(--md-scale));
  font-family: ui-monospace, monospace;
}
pre code { background: none; padding: 0; font-size: calc(12px * var(--md-scale)); }
code {
  font-family: ui-monospace, monospace;
  font-size: calc(12px * var(--md-scale)); background: $codeBg; color: $codeFg; padding: 1px 4px; border-radius: 4px;
}
table { border-collapse: collapse; font-size: calc(12px * var(--md-scale)); margin: 0 0 8px; width: 100%; }
th, td { border: 1px solid $border; padding: 4px 8px; text-align: left; vertical-align: top; }
th { font-weight: 600; }
.wrap { overflow-x: auto; margin: 0 0 8px; }
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
            if (t.startsWith("|") && t.contains("|")) {
                val rows = mutableListOf<String>()
                while (i < lines.size) {
                    val r = lines[i].trim()
                    if (r.startsWith("|")) { rows += r; i++ } else break
                }
                out += renderTable(rows)
                continue
            }
            if (t == "---" || t == "***" || t == "___") {
                out += "<hr>"
                i++
                continue
            }
            if (t.startsWith("> ") || t == ">") {
                val buf = mutableListOf<String>()
                while (i < lines.size) {
                    val r = lines[i].trim()
                    when {
                        r.startsWith("> ") -> { buf += r.removePrefix("> "); i++ }
                        r == ">" -> { buf += ""; i++ }
                        else -> break
                    }
                }
                out += "<blockquote>${inline(buf.joinToString(" "))}</blockquote>"
                continue
            }
            val headingParts = heading(t)
            if (headingParts != null) {
                out += "<h${headingParts.first}>${inline(headingParts.second)}</h${headingParts.first}>"
                i++
                continue
            }
            if (isUl(t) || isOl(t)) {
                val ordered = isOl(t)
                val items = mutableListOf<String>()
                while (i < lines.size) {
                    val r = lines[i].trim()
                    val item = if (ordered) olItem(r) else ulItem(r)
                    if (item != null) { items += item; i++ } else break
                }
                val tag = if (ordered) "ol" else "ul"
                out += "<$tag>" + items.joinToString("") { "<li>${inline(it)}</li>" } + "</$tag>"
                continue
            }
            val para = mutableListOf(t)
            i++
            while (i < lines.size) {
                val r = lines[i].trim()
                if (r.isEmpty() || r.startsWith("|") || r.startsWith("#") || r.startsWith("> ") || isUl(r) || isOl(r) || r == "---") break
                para += r
                i++
            }
            out += "<p>${inline(para.joinToString(" "))}</p>"
        }
        return out
    }

    private fun heading(t: String): Pair<Int, String>? = when {
        t.startsWith("### ") -> 3 to t.removePrefix("### ")
        t.startsWith("## ") -> 2 to t.removePrefix("## ")
        t.startsWith("# ") -> 1 to t.removePrefix("# ")
        else -> null
    }

    private fun isUl(t: String) = t.startsWith("- ") || t.startsWith("* ")
    private fun ulItem(t: String): String? = when {
        t.startsWith("- ") -> t.removePrefix("- ")
        t.startsWith("* ") -> t.removePrefix("* ")
        else -> null
    }
    private fun isOl(t: String) = olItem(t) != null
    private fun olItem(t: String): String? {
        val dot = t.indexOf('.')
        if (dot <= 0) return null
        val n = t.substring(0, dot)
        if (n.any { !it.isDigit() }) return null
        if (!t.substring(dot).startsWith(". ")) return null
        return t.substring(dot + 2)
    }

    private fun renderTable(rows: List<String>): String {
        val parsed = rows.map { row ->
            val parts = row.split("|").map { it.trim() }.toMutableList()
            if (parts.firstOrNull() == "") parts.removeFirst()
            if (parts.lastOrNull() == "") parts.removeLast()
            parts
        }.filter { row -> !row.all { cell -> cell.all { it == '-' || it == ':' || it.isWhitespace() } } }
        val head = parsed.firstOrNull() ?: return ""
        val body = parsed.drop(1)
        val sb = StringBuilder("<div class=\"wrap\"><table><thead><tr>")
        head.forEach { sb.append("<th>${inline(it)}</th>") }
        sb.append("</tr></thead><tbody>")
        body.forEach { r ->
            sb.append("<tr>")
            r.forEach { sb.append("<td>${inline(it)}</td>") }
            sb.append("</tr>")
        }
        sb.append("</tbody></table></div>")
        return sb.toString()
    }

    private fun inline(raw: String): String {
        var s = escape(raw)
        s = s.replace(Regex("`([^`]+)`"), "<code>$1</code>")
        s = s.replace(Regex("""\*\*([^*]+)\*\*"""), "<strong>$1</strong>")
        s = s.replace(Regex("""\*([^*]+)\*"""), "<em>$1</em>")
        s = s.replace(Regex("""\[([^\]]+)\]\(([^)]+)\)"""), "<a href=\"$2\">$1</a>")
        return s
    }

    private fun escape(s: String): String =
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
}
