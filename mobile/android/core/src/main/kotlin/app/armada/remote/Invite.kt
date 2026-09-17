package app.armada.remote

private val FLEET_RE = Regex("^[a-z0-9-]{8,64}$")
private val HEX64 = Regex("^[a-f0-9]{64}$")

data class RelayInvite(
    val kind: String,
    val relay: String,
    val fleet: String,
    val cred: String,
)

sealed class InviteParse {
    data class Ok(val invite: RelayInvite) : InviteParse()
    data class Err(val code: String) : InviteParse()
}

object Invite {
    fun originOf(relay: String): String? {
        val u = runCatching { java.net.URI(relay) }.getOrNull() ?: return null
        val host = u.host ?: return null
        val scheme = u.scheme ?: return null
        val loopback = host == "127.0.0.1" || host == "localhost" || host == "10.0.2.2"
        val hostPort = if (u.port > 0) "$host:${u.port}" else host
        if (scheme == "https") return "$scheme://$hostPort"
        if (scheme == "http" && loopback) return "$scheme://$hostPort"
        return null
    }

    fun parse(input: String): InviteParse {
        val raw = input.trim()
        val url = runCatching { java.net.URI(raw) }.getOrNull() ?: return InviteParse.Err("invalid")
        if (url.scheme != "armada-relay") return InviteParse.Err("invalid")
        val kindRaw = ((url.host ?: "") + (url.path ?: "")).replace("/", "")
        val kind = when (kindRaw) {
            "pair" -> "pair"
            "op" -> "op"
            else -> return InviteParse.Err("invalid")
        }
        val q = query(url)
        val relayRaw = q["relay"]?.trim().orEmpty()
        val fleet = q["fleet"]?.trim().orEmpty()
        if (relayRaw.isEmpty() || fleet.isEmpty()) return InviteParse.Err("incomplete")
        val origin = originOf(relayRaw) ?: return InviteParse.Err("insecure")
        if (!FLEET_RE.matches(fleet)) return InviteParse.Err("incomplete")
        val cred = if (kind == "pair") {
            listOf(q["code"], q["secret"]).map { it?.trim().orEmpty() }.firstOrNull { HEX64.matches(it) }.orEmpty()
        } else {
            q["token"]?.trim().orEmpty()
        }
        if (!HEX64.matches(cred)) return InviteParse.Err("incomplete")
        return InviteParse.Ok(RelayInvite(kind, origin, fleet, cred))
    }

    private fun query(uri: java.net.URI): Map<String, String> {
        val raw = uri.rawQuery ?: return emptyMap()
        return raw.split("&").mapNotNull { part ->
            val i = part.indexOf("=")
            if (i <= 0) null
            else java.net.URLDecoder.decode(part.substring(0, i), Charsets.UTF_8) to
                java.net.URLDecoder.decode(part.substring(i + 1), Charsets.UTF_8)
        }.toMap()
    }
}
