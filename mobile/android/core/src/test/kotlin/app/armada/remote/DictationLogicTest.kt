package app.armada.remote

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DictationLogicTest {
    @Test
    fun startSnapshotsPromptAndListensWithoutSending() {
        val session = startDictation("已有草稿")
        assertTrue(session.listening)
        assertEquals("已有草稿", dictationPrompt(session))
        assertEquals("", session.spoken)
    }

    @Test
    fun partialSpokenReplacesHypothesisNotBase() {
        var session = startDictation("修")
        session = applySpoken(session, "登录")
        assertEquals("修登录", dictationPrompt(session))
        session = applySpoken(session, "登录页")
        assertEquals("修登录页", dictationPrompt(session))
        assertEquals("修", session.base)
    }

    @Test
    fun englishGetsASpaceChineseDoesNot() {
        assertEquals("fix login", joinDictation("fix", "login"))
        assertEquals("修登录", joinDictation("修", "登录"))
        assertEquals("fix 登录", joinDictation("fix ", "登录"))
        assertEquals("草稿 login", joinDictation("草稿", "login"))
    }

    @Test
    fun stopCommitsTextAndLeavesIdleForEdit() {
        var session = applySpoken(startDictation("请"), "修登录")
        session = stopDictation(session)
        assertFalse(session.listening)
        assertEquals("请修登录", dictationPrompt(session))
        session = startDictation(dictationPrompt(session))
        session = applySpoken(session, "并加测试")
        assertEquals("请修登录并加测试", dictationPrompt(session))
    }

    @Test
    fun emptySpokenKeepsBase() {
        val session = stopDictation(startDictation("原文"))
        assertEquals("原文", dictationPrompt(session))
    }

    @Test
    fun ignoreSpokenWhenNotListening() {
        val idle = applySpoken(DictationSession(), "不该写入")
        assertEquals("", dictationPrompt(idle))
        assertFalse(idle.listening)
    }

    @Test
    fun finalUtteranceCommitsButCanKeepListening() {
        var session = applySpoken(startDictation(""), "第一句")
        session = commitSpoken(session)
        assertTrue(session.listening)
        assertEquals("第一句", dictationPrompt(session))
        session = applySpoken(session, "第二句")
        assertEquals("第一句第二句", dictationPrompt(session))
    }

    @Test
    fun failKeepsComposedTextAndStops() {
        val session = failDictation(applySpoken(startDictation("甲"), "乙"))
        assertFalse(session.listening)
        assertEquals("甲乙", dictationPrompt(session))
    }

    @Test
    fun dictationMessagesAreOperatorFacingChinese() {
        assertEquals("本机不支持语音识别", dictationMessage("SPEECH_UNAVAILABLE"))
        assertEquals("需要麦克风权限才能语音输入", dictationMessage("MIC_DENIED"))
        assertEquals("需要语音识别权限", dictationMessage("SPEECH_DENIED"))
        assertEquals("没听清，请再说一次", dictationMessage("SPEECH_NO_MATCH"))
        assertEquals("语音识别需要网络", dictationMessage("SPEECH_NETWORK"))
    }
}
