package app.armada.remote

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class WorkspaceFileTest {
    @Test
    fun mdRelativeAndArmadaFileDecode() {
        assertEquals("docs/foo.md", WorkspaceFile.pathFromHref("docs/foo.md"))
        assertEquals("docs/foo.md", WorkspaceFile.pathFromHref("armada-file://preview?p=docs%2Ffoo.md"))
        assertEquals("/Users/me/ws/docs/foo.md", WorkspaceFile.pathFromHref("file:///Users/me/ws/docs/foo.md"))
        assertNull(WorkspaceFile.pathFromHref("https://example.com/foo.md"))
        assertFalse(WorkspaceFile.looksLike("just-a-word"))
        assertTrue(WorkspaceFile.rewriteHref("docs/foo.md").startsWith("armada-file://preview?p="))
    }
}
