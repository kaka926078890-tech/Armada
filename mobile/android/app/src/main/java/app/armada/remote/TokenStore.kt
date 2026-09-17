package app.armada.remote

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class TokenStore(ctx: Context) {
    private val plain: SharedPreferences = ctx.getSharedPreferences("armada", Context.MODE_PRIVATE)
    private val secret: SharedPreferences = runCatching {
        val master = MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            ctx,
            "armada.secret",
            master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }.getOrElse { plain }

    var relay: String
        get() = plain.getString("relay", "").orEmpty()
        set(v) { plain.edit().putString("relay", v).apply() }
    var fleet: String
        get() = plain.getString("fleet", "").orEmpty()
        set(v) { plain.edit().putString("fleet", v).apply() }
    var token: String
        get() = secret.getString("token", "").orEmpty()
        set(v) { secret.edit().putString("token", v).apply() }
    var fcmToken: String
        get() = plain.getString("fcm", "").orEmpty()
        set(v) { plain.edit().putString("fcm", v).apply() }

    fun readAt(): Map<String, Double> {
        val raw = plain.getString("readAt", "") ?: return emptyMap()
        return runCatching {
            val o = org.json.JSONObject(raw)
            o.keys().asSequence().associateWith { o.getDouble(it) }
        }.getOrDefault(emptyMap())
    }

    fun saveReadAt(map: Map<String, Double>) {
        val o = org.json.JSONObject()
        map.forEach { (k, v) -> o.put(k, v) }
        plain.edit().putString("readAt", o.toString()).apply()
    }

    fun clear() {
        relay = ""; fleet = ""; token = ""; fcmToken = ""
        plain.edit().remove("readAt").apply()
    }
}
