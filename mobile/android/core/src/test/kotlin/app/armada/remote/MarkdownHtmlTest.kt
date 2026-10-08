package app.armada.remote

import kotlin.test.Test
import kotlin.test.assertTrue

class MarkdownHtmlTest {
    @Test
    fun mermaidFenceIsDiagramNotCode() {
        val html = MarkdownHtml.from("见下图\n\n```Mermaid\nflowchart TD\n  A[\"<b>\"] --> B\n```\n")
        assertTrue(html.contains("class=\"mermaid\""), html)
        assertTrue(html.contains("flowchart TD"), html)
        assertTrue(html.contains("&lt;b&gt;"), html)
        assertTrue(!html.contains("<pre><code>flowchart"), html)
        assertTrue(html.contains("mermaid-boot.js"), html)
        assertTrue(html.contains("data-theme=\"dark\""), html)
        val light = MarkdownHtml.from("```mermaid\nflowchart TD\nA-->B\n```", theme = "light")
        assertTrue(light.contains("data-theme=\"light\""), light)
        val plain = MarkdownHtml.from("```\nconst a = 1\n```\n")
        assertTrue(plain.contains("<pre><code>const a = 1</code></pre>"), plain)
        assertTrue(!plain.contains("mermaid-boot.js"), plain)
    }

    @Test
    fun fenceIsEscapedPre() {
        val html = MarkdownHtml.from("hello\n```\n<script>x</script>\n```\n")
        assertTrue(html.contains("<pre><code>"))
        assertTrue(html.contains("&lt;script&gt;"))
        assertTrue(!html.contains("<script>x</script>"))
    }

    @Test
    fun headingAndBold() {
        val html = MarkdownHtml.from("# Title\n\n**bold**")
        assertTrue(html.contains("<h1>Title</h1>"))
        assertTrue(html.contains("<strong>bold</strong>"))
    }

    @Test
    fun largeDarkAppliesZoomAndDarkColor() {
        val html = MarkdownHtml.from("# Title", fontScale = "large", theme = "dark")
        assertTrue(!html.contains("zoom:"))
        assertTrue(html.contains("--md-scale: 1.25") || html.contains("--md-scale:1.25"))
        assertTrue(html.contains("calc(13px * var(--md-scale))") || html.contains("calc(13px*var(--md-scale))"))
        assertTrue(html.contains("color: #e4e4e7") || html.contains("color:#e4e4e7"))
    }

    @Test
    fun measureJsUsesLastBlockNotViewport() {
        assertTrue(!MarkdownHtml.MEASURE_JS.contains("documentElement.scrollHeight"), MarkdownHtml.MEASURE_JS)
        assertTrue(MarkdownHtml.MEASURE_JS.contains("lastElementChild"), MarkdownHtml.MEASURE_JS)
        assertTrue(MarkdownHtml.MEASURE_JS.contains("Math.ceil"), MarkdownHtml.MEASURE_JS)
    }

    @Test
    fun tableBlockquoteLinkAndHrMatchIos() {
        val src = """
            | 项 | 内容 |
            | --- | --- |
            | 根因 | 路由 |

            > quote

            ---

            1. one
            2. two

            [docs](https://example.com)
        """.trimIndent()
        val html = MarkdownHtml.from(src, theme = "dark")
        assertTrue(html.contains("<table>"), html)
        assertTrue(html.contains("<th>项</th>"), html)
        assertTrue(html.contains("<td>根因</td>"), html)
        assertTrue(html.contains("<blockquote>quote</blockquote>"), html)
        assertTrue(html.contains("<hr>"), html)
        assertTrue(html.contains("<ol>"), html)
        assertTrue(html.contains("<a href=\"https://example.com\">docs</a>"), html)
        assertTrue(html.contains("armada-file://preview?p="), MarkdownHtml.from("[spec](docs/foo.md)"))
        assertTrue(html.contains("blockquote {"), html)
        assertTrue(html.contains("table {"), html)
    }
}
