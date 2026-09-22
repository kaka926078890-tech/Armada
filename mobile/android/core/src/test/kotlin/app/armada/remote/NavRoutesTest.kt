package app.armada.remote

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NavRoutesTest {
    @Test
    fun macWorkspaceIdStaysOneQueryArg() {
        val id = "m-a713c1d0-cf15-4e93-874c-7498b3187448|/Users/apple/Desktop/desk"
        val route = workspaceNavRoute(id)
        assertTrue(route.startsWith("ws?id="), route)
        val payload = route.removePrefix("ws?id=")
        assertFalse(payload.contains("/"), payload)
        assertFalse(payload.contains("|"), payload)
        assertEquals(id, decodeNavArg(payload))
    }

    @Test
    fun windowsWorkspaceIdRoundTrips() {
        val id = "m-44ff077a-eb79-4b54-aa16-112d1749b5b1|c:\\Users\\PC\\Desktop\\work"
        val route = workspaceNavRoute(id)
        assertTrue(route.startsWith("ws?id="), route)
        assertFalse(route.contains("\\"), route)
        assertEquals(id, decodeNavArg(route.removePrefix("ws?id=")))
    }

    @Test
    fun filePathUsesQueryNotPathSlash() {
        val path = "docs/superpowers/specs/foo.md"
        val route = fileNavRoute("r-1", path)
        assertTrue(route.startsWith("file?runId="), route)
        assertFalse(route.contains("/docs"), route)
        val q = route.removePrefix("file?").split("&")
        val runId = decodeNavArg(q.first { it.startsWith("runId=") }.removePrefix("runId="))
        val got = decodeNavArg(q.first { it.startsWith("path=") }.removePrefix("path="))
        assertEquals("r-1", runId)
        assertEquals(path, got)
    }
}
