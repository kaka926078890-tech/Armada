package app.armada.remote

data class DictationSession(
    val listening: Boolean = false,
    val base: String = "",
    val spoken: String = "",
)

fun dictationPrompt(session: DictationSession): String = joinDictation(session.base, session.spoken)

fun startDictation(currentPrompt: String) = DictationSession(listening = true, base = currentPrompt, spoken = "")

fun applySpoken(session: DictationSession, spoken: String): DictationSession {
    if (!session.listening) return session
    return session.copy(spoken = spoken)
}

fun commitSpoken(session: DictationSession): DictationSession =
    session.copy(base = dictationPrompt(session), spoken = "")

fun stopDictation(session: DictationSession): DictationSession = commitSpoken(session).copy(listening = false)

fun failDictation(session: DictationSession): DictationSession = stopDictation(session)

fun joinDictation(base: String, spoken: String): String {
    if (spoken.isEmpty()) return base
    if (base.isEmpty()) return spoken
    return if (needsDictationSpace(base, spoken)) "$base $spoken" else base + spoken
}

fun needsDictationSpace(base: String, spoken: String): Boolean {
    val left = base.last()
    val right = spoken.first()
    if (left.isWhitespace() || right.isWhitespace()) return false
    val leftCjk = left.isCjk()
    val rightCjk = right.isCjk()
    if (leftCjk && rightCjk) return false
    val leftWord = left.isLetterOrDigit()
    val rightWord = right.isLetterOrDigit()
    if (leftWord && (rightWord || rightCjk)) return true
    if (leftCjk && rightWord) return true
    return false
}

private fun Char.isCjk(): Boolean {
    val v = code
    return v in 0x2E80..0x9FFF || v in 0xF900..0xFAFF || v in 0xFE30..0xFE4F
}

fun dictationMessage(code: String): String = when (code) {
    "SPEECH_UNAVAILABLE" -> "本机不支持语音识别"
    "MIC_DENIED" -> "需要麦克风权限才能语音输入"
    "SPEECH_DENIED" -> "需要语音识别权限"
    "SPEECH_NO_MATCH" -> "没听清，请再说一次"
    "SPEECH_NETWORK" -> "语音识别需要网络"
    else -> "语音识别失败"
}
