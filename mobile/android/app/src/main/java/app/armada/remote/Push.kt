package app.armada.remote

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

const val ALERT_CHANNEL = "armada.alerts"

class ArmadaApp : Application() {
    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(ALERT_CHANNEL, "Armada", NotificationManager.IMPORTANCE_HIGH),
            )
        }
        runCatching { FirebaseApp.initializeApp(this) }
    }
}

object PushBridge {
    fun requestAndRegister(app: Application, onToken: (String) -> Unit) {
        if (FirebaseApp.getApps(app).isEmpty()) return
        FirebaseMessaging.getInstance().token.addOnSuccessListener { tok ->
            if (!tok.isNullOrBlank()) onToken(tok)
        }
    }
}

class ArmadaMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        PushInbox.pendingFcm = token
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val runId = message.data["runId"] ?: return
        val watching = PushInbox.watchingId
        if (watching == runId) return
        // System displays notification payload when app is backgrounded.
        // Foreground: drop if watching this run (iOS willPresent).
    }
}

fun takeRunIdFromIntent(runId: String?) {
    if (!runId.isNullOrBlank()) PushInbox.runId = runId
}
