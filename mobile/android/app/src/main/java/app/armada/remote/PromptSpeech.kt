package app.armada.remote

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

class PromptSpeech(
    private val context: Context,
    private val emit: (DictationSession) -> Unit,
    private val onError: (String) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private var session = DictationSession()
    private var recognizer: SpeechRecognizer? = null
    private var gen = 0

    val listening: Boolean get() = session.listening

    fun start(currentPrompt: String) {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            onError(dictationMessage("SPEECH_UNAVAILABLE"))
            return
        }
        gen += 1
        session = startDictation(currentPrompt)
        emit(session)
        beginListen()
    }

    fun stop() {
        gen += 1
        session = stopDictation(session)
        emit(session)
        destroyRecognizer()
    }

    fun release() {
        gen += 1
        if (session.listening) {
            session = stopDictation(session)
            emit(session)
        }
        destroyRecognizer()
    }

    private fun beginListen() {
        gen += 1
        val expected = gen
        destroyRecognizer()
        if (!session.listening) return
        val r = SpeechRecognizer.createSpeechRecognizer(context)
        recognizer = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}

            override fun onError(error: Int) {
                if (expected != gen || !session.listening) return
                when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH,
                    SpeechRecognizer.ERROR_SPEECH_TIMEOUT,
                    SpeechRecognizer.ERROR_CLIENT,
                    -> restart(expected)
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> fail("MIC_DENIED")
                    SpeechRecognizer.ERROR_NETWORK,
                    SpeechRecognizer.ERROR_NETWORK_TIMEOUT,
                    -> fail("SPEECH_NETWORK")
                    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> restart(expected)
                    else -> fail("SPEECH_UNAVAILABLE")
                }
            }

            override fun onResults(results: Bundle?) {
                if (expected != gen || !session.listening) return
                val text = best(results)
                if (text.isNotEmpty()) {
                    session = commitSpoken(applySpoken(session, text))
                    emit(session)
                }
                restart(expected)
            }

            override fun onPartialResults(partialResults: Bundle?) {
                if (expected != gen || !session.listening) return
                val text = best(partialResults)
                if (text.isEmpty()) return
                session = applySpoken(session, text)
                emit(session)
            }
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        }
        r.startListening(intent)
    }

    private fun restart(expected: Int) {
        if (expected != gen || !session.listening) return
        main.postDelayed({
            if (expected == gen && session.listening) beginListen()
        }, 250)
    }

    private fun fail(code: String) {
        gen += 1
        session = failDictation(session)
        emit(session)
        destroyRecognizer()
        onError(dictationMessage(code))
    }

    private fun destroyRecognizer() {
        val r = recognizer ?: return
        recognizer = null
        try {
            r.cancel()
        } catch (_: Exception) {
        }
        r.destroy()
    }

    private fun best(bundle: Bundle?): String =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
}
