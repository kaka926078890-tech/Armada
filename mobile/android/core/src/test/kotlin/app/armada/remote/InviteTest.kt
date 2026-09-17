package app.armada.remote

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class InviteTest {
    private val fleet = "fleet-abc12"
    private val token = "b".repeat(64)
    private val relay = "https://relay.example.com"

    @Test
    fun parsesOpInvite() {
        val uri = "armada-relay://op?relay=${java.net.URLEncoder.encode(relay, "UTF-8")}&fleet=$fleet&token=$token"
        val got = Invite.parse(uri)
        val ok = assertIs<InviteParse.Ok>(got)
        assertEquals("op", ok.invite.kind)
        assertEquals(relay, ok.invite.relay)
        assertEquals(fleet, ok.invite.fleet)
        assertEquals(token, ok.invite.cred)
    }

    @Test
    fun rejectsPairAsOpKindStillParsesPair() {
        val uri = "armada-relay://pair?relay=${java.net.URLEncoder.encode(relay, "UTF-8")}&fleet=$fleet&code=$token"
        val ok = assertIs<InviteParse.Ok>(Invite.parse(uri))
        assertEquals("pair", ok.invite.kind)
    }

    @Test
    fun rejectsPublicHttp() {
        val uri = "armada-relay://op?relay=http://relay.example.com&fleet=$fleet&token=$token"
        assertEquals(InviteParse.Err("insecure"), Invite.parse(uri))
    }

    @Test
    fun allowsEmulatorHttp() {
        val uri = "armada-relay://op?relay=http://10.0.2.2:8780&fleet=$fleet&token=$token"
        val ok = assertIs<InviteParse.Ok>(Invite.parse(uri))
        assertEquals("http://10.0.2.2:8780", ok.invite.relay)
    }

    @Test
    fun rejectsWrongScheme() {
        assertEquals(InviteParse.Err("invalid"), Invite.parse("armada://join?hub=1.2.3.4:7380&token=ab"))
    }
}
