package app.armada.remote

/** Public uuWAF 500s HTML above ~10KiB. Keep JSON bodies under that. */
const val WAF_JSON_CHUNK_BYTES = 6 * 1024

fun shouldChunkJsonBody(jsonUtf8Bytes: Int): Boolean = jsonUtf8Bytes > WAF_JSON_CHUNK_BYTES
