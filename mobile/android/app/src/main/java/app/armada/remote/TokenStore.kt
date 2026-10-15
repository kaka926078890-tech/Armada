package app.armada.remote

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class TokenStore(ctx: Context) {
    private val plain: SharedPreferences = ctx.getSharedPreferences("armada", Context.MODE_PRIVATE)
    private val secret: SharedPreferences = openSecretStore {
        val master = MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            ctx,
            "armada.secret",
            master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

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

    var appearanceTheme: String
        get() = if (plain.getString("armada.theme.v1", "dark") == "light") "light" else "dark"
        set(v) { plain.edit().putString("armada.theme.v1", if (v == "light") "light" else "dark").apply() }

    var appearanceFontScale: String
        get() {
            val raw = plain.getString("armada.fontScale.v1", "normal")
            return if (raw == "large" || raw == "xlarge") raw else "normal"
        }
        set(v) {
            val n = if (v == "large" || v == "xlarge") v else "normal"
            plain.edit().putString("armada.fontScale.v1", n).apply()
        }

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

    fun readBootstrapped(): Boolean = plain.getBoolean("readBootstrapped", false)

    fun setReadBootstrapped() {
        plain.edit().putBoolean("readBootstrapped", true).apply()
    }

    fun readOps(): List<ReadOp> {
        val raw = plain.getString("readOps", "") ?: return emptyList()
        return runCatching {
            val arr = org.json.JSONArray(raw)
            buildList {
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    add(ReadOp(
                        o.getString("op"),
                        o.getString("runId"),
                        if (o.has("at") && !o.isNull("at")) o.getDouble("at") else null,
                        o.optLong("baseSeq"),
                    ))
                }
            }
        }.getOrDefault(emptyList())
    }

    fun saveReadOps(ops: List<ReadOp>) {
        val arr = org.json.JSONArray()
        ops.forEach { op ->
            val o = org.json.JSONObject().put("op", op.op).put("runId", op.runId).put("baseSeq", op.baseSeq)
            if (op.at != null) o.put("at", op.at)
            arr.put(o)
        }
        plain.edit().putString("readOps", arr.toString()).apply()
    }

    fun clear() {
        relay = ""; fleet = ""; token = ""; fcmToken = ""
        plain.edit().remove("readAt").remove("readOps").remove("readBootstrapped").apply()
    }
}
