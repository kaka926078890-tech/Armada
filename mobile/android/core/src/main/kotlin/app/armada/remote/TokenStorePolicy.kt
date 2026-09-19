package app.armada.remote

class SecretStoreUnavailable(cause: Throwable? = null) : RuntimeException("TOKEN_STORE_UNAVAILABLE", cause)

/**
 * Keystore / EncryptedSharedPreferences must fail closed: never return a plaintext fallback.
 */
fun <T> openSecretStore(create: () -> T): T {
    return try {
        create()
    } catch (t: Throwable) {
        throw if (t is SecretStoreUnavailable) t else SecretStoreUnavailable(t)
    }
}
