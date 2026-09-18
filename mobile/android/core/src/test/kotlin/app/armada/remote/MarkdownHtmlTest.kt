package app.armada.remote

import kotlin.test.Test
import kotlin.test.assertTrue

class MarkdownHtmlTest {
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
        assertTrue(html.contains("zoom: 1.5"))
        assertTrue(html.contains("color: #e4e4e7") || html.contains("color:#e4e4e7"))
    }
}
