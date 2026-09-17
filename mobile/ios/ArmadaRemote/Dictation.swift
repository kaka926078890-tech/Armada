import AVFoundation
import Foundation
import Speech
import SwiftUI

struct DictationSession: Equatable {
    var listening = false
    var base = ""
    var spoken = ""
}

func dictationPrompt(_ session: DictationSession) -> String {
    joinDictation(session.base, session.spoken)
}

func startDictation(_ currentPrompt: String) -> DictationSession {
    DictationSession(listening: true, base: currentPrompt, spoken: "")
}

func applySpoken(_ session: DictationSession, _ spoken: String) -> DictationSession {
    guard session.listening else { return session }
    var next = session
    next.spoken = spoken
    return next
}

func commitSpoken(_ session: DictationSession) -> DictationSession {
    var next = session
    next.base = dictationPrompt(session)
    next.spoken = ""
    return next
}

func stopDictation(_ session: DictationSession) -> DictationSession {
    var next = commitSpoken(session)
    next.listening = false
    return next
}

func failDictation(_ session: DictationSession) -> DictationSession {
    stopDictation(session)
}

func joinDictation(_ base: String, _ spoken: String) -> String {
    if spoken.isEmpty { return base }
    if base.isEmpty { return spoken }
    return needsDictationSpace(base, spoken) ? "\(base) \(spoken)" : base + spoken
}

func needsDictationSpace(_ base: String, _ spoken: String) -> Bool {
    guard let left = base.last, let right = spoken.first else { return false }
    if left.isWhitespace || right.isWhitespace { return false }
    let leftCjk = left.isCjk
    let rightCjk = right.isCjk
    if leftCjk && rightCjk { return false }
    let leftWord = left.isLetter || left.isNumber
    let rightWord = right.isLetter || right.isNumber
    if leftWord && (rightWord || rightCjk) { return true }
    if leftCjk && rightWord { return true }
    return false
}

func dictationMessage(_ code: String) -> String {
    switch code {
    case "SPEECH_UNAVAILABLE": return "本机不支持语音识别"
    case "MIC_DENIED": return "需要麦克风权限才能语音输入"
    case "SPEECH_DENIED": return "需要语音识别权限"
    case "SPEECH_NO_MATCH": return "没听清，请再说一次"
    case "SPEECH_NETWORK": return "语音识别需要网络"
    default: return "语音识别失败"
    }
}

private extension Character {
    var isCjk: Bool {
        unicodeScalars.contains { scalar in
            (0x2E80...0x9FFF).contains(scalar.value)
                || (0xF900...0xFAFF).contains(scalar.value)
                || (0xFE30...0xFE4F).contains(scalar.value)
        }
    }
}

@MainActor
final class PromptSpeech: ObservableObject {
    @Published var prompt = ""
    @Published var listening = false
    @Published var error: String?

    private var session = DictationSession()
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var gen = 0

    func toggle() {
        if listening { stop() } else { Task { await start() } }
    }

    func start() async {
        guard let recognizer, recognizer.isAvailable else {
            error = dictationMessage("SPEECH_UNAVAILABLE")
            return
        }
        let speech = await withCheckedContinuation { (cont: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0) }
        }
        guard speech == .authorized else {
            error = dictationMessage("SPEECH_DENIED")
            return
        }
        let mic = await AVAudioApplication.requestRecordPermission()
        guard mic else {
            error = dictationMessage("MIC_DENIED")
            return
        }
        gen += 1
        session = startDictation(prompt)
        listening = true
        error = nil
        beginEngine()
    }

    func stop() {
        gen += 1
        session = stopDictation(session)
        prompt = dictationPrompt(session)
        listening = false
        teardownEngine()
    }

    func release() {
        if listening { stop() } else { teardownEngine() }
    }

    private func beginEngine() {
        teardownEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if #available(iOS 16.0, *) {
            request.addsPunctuation = true
        }
        self.request = request
        let expected = gen
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audio.setActive(true, options: .notifyOthersOnDeactivation)
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            let req = request
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                req.append(buffer)
            }
            engine.prepare()
            try engine.start()
        } catch {
            fail("SPEECH_UNAVAILABLE")
            return
        }
        task = recognizer?.recognitionTask(with: request) { [weak self] result, err in
            Task { @MainActor in
                guard let self, expected == self.gen, self.listening else { return }
                if let result {
                    self.session = applySpoken(self.session, result.bestTranscription.formattedString)
                    self.prompt = dictationPrompt(self.session)
                    if result.isFinal {
                        self.stop()
                        return
                    }
                }
                if let err {
                    switch (err as NSError).code {
                    case 216, 301, 1110, 203:
                        self.stop()
                    default:
                        self.fail("SPEECH_UNAVAILABLE")
                    }
                }
            }
        }
    }

    private func fail(_ code: String) {
        gen += 1
        session = failDictation(session)
        prompt = dictationPrompt(session)
        listening = false
        teardownEngine()
        error = dictationMessage(code)
    }

    private func teardownEngine() {
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
