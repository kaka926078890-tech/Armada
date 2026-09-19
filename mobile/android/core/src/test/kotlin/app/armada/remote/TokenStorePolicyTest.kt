package app.armada.remote

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class TokenStorePolicyTest {
    @Test
    fun keystoreFailureDoesNotReturnPlaintextFallback() {
        val plaintext = "PLAINTEXT_STORE"
        val err = assertFailsWith<SecretStoreUnavailable> {
            openSecretStore { error("keystore down"); plaintext }
        }
        assertEquals("TOKEN_STORE_UNAVAILABLE", err.message)
        assertTrue(err.cause?.message?.contains("keystore down") == true)
    }

    @Test
    fun keystoreSuccessReturnsTheSecretStore() {
        assertEquals("secret", openSecretStore { "secret" })
    }
}
