import Foundation

struct WorkspaceDTO: Decodable, Identifiable, Hashable {
    var workspaceId: String
    var machineId: String
    var workspaceRoot: String
    var label: String
    var machineName: String
    var os: String
    var online: Bool
    var cdpReady: Bool
    var id: String { workspaceId }
    var canInject: Bool { online && cdpReady }

    init(workspaceId: String, machineId: String, workspaceRoot: String, label: String, machineName: String = "", os: String = "", online: Bool = true, cdpReady: Bool = false) {
        self.workspaceId = workspaceId
        self.machineId = machineId
        self.workspaceRoot = workspaceRoot
        self.label = label
        self.machineName = machineName
        self.os = os
        self.online = online
        self.cdpReady = cdpReady
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workspaceId = try c.decode(String.self, forKey: .workspaceId)
        machineId = try c.decode(String.self, forKey: .machineId)
        workspaceRoot = try c.decode(String.self, forKey: .workspaceRoot)
        label = try c.decode(String.self, forKey: .label)
        machineName = try c.decodeIfPresent(String.self, forKey: .machineName) ?? ""
        os = try c.decodeIfPresent(String.self, forKey: .os) ?? ""
        online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? true
        cdpReady = try c.decodeIfPresent(Bool.self, forKey: .cdpReady) ?? false
    }

    enum CodingKeys: String, CodingKey {
        case workspaceId, machineId, workspaceRoot, label, machineName, os, online, cdpReady
    }
}

struct WorkspacesResponse: Decodable {
    var hubOffline: Bool
    var workspaces: [WorkspaceDTO]
}

struct CursorReloadPending: Decodable, Equatable {
    var action: String
    var vsix: String
}

struct CursorReloadDTO: Decodable, Equatable {
    var needed: Bool
    var pending: CursorReloadPending?
}

struct PendingAskOption: Decodable, Identifiable, Hashable {
    var id: String
    var label: String
    var text: String
}

struct PendingAskQuestion: Decodable, Identifiable, Hashable {
    var id: String
    var prompt: String
    var allow_multiple: Bool?
    var options: [PendingAskOption]
}

struct PendingAskDTO: Decodable, Hashable {
    var request_id: String
    var questions: [PendingAskQuestion]
    var kind: String?
}

struct OutboundDTO: Decodable, Hashable, Identifiable {
    var id: String
    var prompt: String
    var expectedMode: String
    var state: String
    var createdAt: Int
}

struct RunDTO: Decodable, Identifiable, Hashable {
    var runId: String
    var machineId: String
    var workspaceRoot: String
    var prompt: String
    var status: String
    var finalText: String?
    var error: String?
    var pendingAsk: PendingAskDTO?
    var outbound: [OutboundDTO]?
    var queueMessageDefaultBehavior: String?
    var canRetry: Bool?
    var archived: Bool?
    var updatedAt: Int?
    var id: String { runId }

    var isLive: Bool {
        ["created", "queued", "dispatched", "binding", "running"].contains(status)
    }

    var isArchived: Bool { archived ?? false }

    var showsArchive: Bool {
        !isLive && !isArchived
    }

    var queuedOutbound: [OutboundDTO] {
        (outbound ?? []).filter { $0.state == "queued" || ($0.state == "injecting" && $0.expectedMode == "queue") }
    }

    var canFollowup: Bool {
        pendingAsk == nil
    }

    var showsRetry: Bool {
        canRetry ?? ["error", "unknown", "aborted"].contains(status)
    }

    var displayError: String? {
        guard let error, !error.isEmpty, error != status, error != "completed" else { return nil }
        return error
    }

    var activityTs: Int { updatedAt ?? 0 }

    var column: BoardColumn {
        BoardColumn.column(for: status)
    }

    func workspace(from slots: [WorkspaceDTO]) -> WorkspaceDTO {
        slots.first { $0.machineId == machineId && $0.workspaceRoot == workspaceRoot }
            ?? WorkspaceDTO(
                workspaceId: "\(machineId)|\(workspaceRoot)",
                machineId: machineId,
                workspaceRoot: workspaceRoot,
                label: workspaceRoot.split { $0 == "/" || $0 == "\\" }.map(String.init).last ?? workspaceRoot
            )
    }
}

/// Plan 只认 hub `kind == "plan"`，不用 option id==build 猜形状。
func isPlanAsk(_ ask: PendingAskDTO) -> Bool {
    ask.kind == "plan"
}

/// 与 hub `pendingAsk.continueAllowed` 对齐：恰好一问且非 `allow_multiple`。
func continueAllowed(_ ask: PendingAskDTO) -> Bool {
    ask.questions.count == 1 && ask.questions.first?.allow_multiple != true
}

/// 仓页必须跟 SSE 列表走；导航快照的 `cdpReady` 会过期。与 Android `liveWorkspace` 对齐。
func liveWorkspace(id: String, slots: [WorkspaceDTO], fallback: WorkspaceDTO) -> WorkspaceDTO {
    slots.first { $0.workspaceId == id } ?? fallback
}

func stampReadAt(nowMs: Double, activityTs: Int?) -> Double {
    max(nowMs, Double(activityTs ?? 0))
}

func runAllowsMarkUnread(_ run: RunDTO, readAt: [String: Double], isUnread: (RunDTO) -> Bool) -> Bool {
    if isUnread(run) { return false }
    if run.pendingAsk != nil { return true }
    return ["completed", "error", "unknown", "aborted"].contains(run.status)
}

func shouldStampOpened(unreadHold: Set<String>, runId: String) -> Bool {
    !unreadHold.contains(runId)
}

func shouldStampReadAt(seen: Double?, activityTs: Int?) -> Bool {
    guard let seen else { return true }
    return Double(activityTs ?? 0) > seen
}

/// SSE / 列表会省略 `finalText`；本地已有正文时不得冲掉。与 Android `coalesceFinalText` 对齐。
func coalesceFinalText(_ incoming: RunDTO, prior: RunDTO?) -> RunDTO {
    guard incoming.finalText == nil, let prev = prior?.finalText, !prev.isEmpty else { return incoming }
    var next = incoming
    next.finalText = prev
    return next
}

/// 中转每次 upsert 都刷新 `updatedAt`；内容没变时不得触发 `@Published`。与 Android `runContentEquals` 对齐。
func runContentEquals(_ a: RunDTO, _ b: RunDTO) -> Bool {
    var x = a
    var y = b
    x.updatedAt = nil
    y.updatedAt = nil
    return x == y
}

func optionalChanged(_ current: String?, _ incoming: String?) -> Bool {
    current != incoming
}

func shouldUpdateBadge(current: Int, next: Int) -> Bool {
    current != next
}

/// 由忙入闲时详情强制 GET /:id。与 Android `detailShouldReload` 对齐。
func detailShouldReload(local: RunDTO?, streamed: RunDTO) -> Bool {
    guard let local, local.runId == streamed.runId else { return false }
    return local.isLive && !streamed.isLive
}

enum BoardColumn: String, CaseIterable, Identifiable {
    case waiting, running, completed, cancelled, error
    var id: String { rawValue }
    var title: String {
        switch self {
        case .waiting: return "待回车"
        case .running: return "运行中"
        case .completed: return "已完成"
        case .cancelled: return "已取消"
        case .error: return "异常"
        }
    }
    static func column(for status: String) -> BoardColumn {
        switch status {
        case "created", "queued", "dispatched", "binding": return .waiting
        case "running": return .running
        case "completed": return .completed
        case "cancelled", "aborted": return .cancelled
        default: return .error
        }
    }
}

struct DispatchResponse: Decodable {
    var run: RunDTO
}

struct StreamFrame: Decodable {
    var type: String
    var hubOffline: Bool?
    var workspaces: [WorkspaceDTO]?
    var run: RunDTO?
}

struct EmptyJSON: Decodable {}

struct PromptSnippet: Codable, Equatable, Identifiable {
    var id: String
    var title: String
    var body: String
}

private struct PromptSnippetsResponse: Codable {
    var snippets: [PromptSnippet]
}

struct ErrorBody: Decodable {
    var error: String?
}

enum RelayAPIError: LocalizedError {
    case http(Int, String)
    case pairInvite
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .http(_, let msg): return Self.operatorMessage(msg)
        case .pairInvite: return "这是中台链接，请粘贴 App 邀请（armada-relay://op）"
        case .transport(let msg): return msg
        }
    }

    static func operatorMessage(_ code: String) -> String {
        switch code {
        case "CONVERSATION_BUSY": return "该对话仍在排队或绑定，结束后才能续聊"
        case "NO_CONVERSATION": return "还没有绑上 Cursor 对话，不能续聊"
        case "INJECT_SLOT_BUSY": return "这台机器正在注入另一条任务，稍后再试"
        case "CDP_NOT_READY": return "Cursor 在线但无法注入。请确认已安装最新 Armada 扩展，并用 Armada 打开工作区。若窗口已开、调试口不通：请完全退出 Cursor（Mac Cmd+Q / Windows 托盘 Exit），不要点 Cursor 图标。"
        case "WORKSPACE_NOT_OPEN": return "工作区没有打开"
        case "CLOSED": return "这条对话已关闭"
        case "PROMPT_COLLISION": return "同一工作区已有相同内容的任务"
        case "HUB_OFFLINE": return "中台离线"
        case "HUB_TIMEOUT": return "中台处理超时，请再发一次"
        case "RATE_LIMIT": return "点得太快，请稍后再发"
        case "EMPTY_PROMPT": return "提示词是空的"
        case "NET_INTERCEPT": return "当前网络拦截了中转。请关掉 Wi‑Fi 改用蜂窝，或换一个网络后再打开。"
        case "OUTBOUND_LIMIT": return "待消化续发已达上限，等 Cursor 消化后再发"
        case "OUTBOUND_TEXT_ONLY": return "运行中续发暂只支持纯文本"
        case "INVALID_STATE": return "当前状态不能重试"
        case "NOT_FOUND": return "任务不存在"
        case "INVALID": return "推送登记失败"
        case "SNIPPET_INVALID": return "标题和提示词都不能为空，且不要超长"
        case "SNIPPET_LIMIT": return "最多 30 条快捷提示词"
        case "READ_FAIL": return "读取快捷提示词失败"
        case "WRITE_FAIL": return "保存失败，请重试"
        case "MACHINE_OFFLINE": return "机器离线"
        case "RUN_LIMIT": return "这台机器任务数已满"
        case "WINDOW_BUSY": return "该窗口正忙"
        case "ASK_INVALID_OPTION": return "选项无效，请改选或 Skip"
        case "ASK_IN_FLIGHT": return "正在提交，请稍候"
        case "NO_PENDING_ASK": return "当前没有待回答的问题"
        case "ASK_MISMATCH": return "问题已更新，请刷新后再答"
        case "NO_ASSISTANT_BODY": return "任务已完成，正文尚未生成"
        default: return code
        }
    }

    /// Keep in sync with desktop-core/src/relayHttpError.ts
    static func classify(status: Int, data: Data) -> RelayAPIError {
        if let err = try? JSONDecoder().decode(ErrorBody.self, from: data), let code = err.error, !code.isEmpty {
            if status == 403 && code == "OPERATOR_REQUIRED" { return .pairInvite }
            return .http(status, code)
        }
        let text = String(data: data, encoding: .utf8) ?? ""
        if status == 403 || text.range(of: "<html", options: .caseInsensitive) != nil {
            return .http(status, "NET_INTERCEPT")
        }
        return .http(status, "HTTP \(status)")
    }
}

actor RelayAPI {
    var base: String
    var token: String

    init(base: String, token: String) {
        self.base = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        self.token = token
    }

    func workspaces() async throws -> WorkspacesResponse {
        try await get("/mobile/workspaces")
    }

    func cursorReload() async throws -> CursorReloadDTO {
        try await get("/mobile/cursor-reload")
    }

    func setCursorReload(action: String, machineId: String? = nil) async throws -> CursorReloadDTO {
        var body: [String: String] = ["action": action]
        if let machineId { body["machineId"] = machineId }
        return try await send("/mobile/cursor-reload", method: "POST", body: encode(body), ok: [200])
    }

    func runs(limit: Int = 50, archived: Bool = false) async throws -> [RunDTO] {
        struct Wrap: Decodable { var runs: [RunDTO] }
        let q = archived ? "&view=hidden" : ""
        let w: Wrap = try await get("/mobile/runs?limit=\(limit)\(q)")
        return archived ? w.runs.filter(\.isArchived) : w.runs.filter { !$0.isArchived }
    }

    func run(id: String) async throws -> RunDTO {
        try await get("/mobile/runs/\(id)")
    }

    func dispatch(workspaceId: String, prompt: String) async throws -> RunDTO {
        let wrap: DispatchResponse = try await send("/mobile/runs", method: "POST", body: encode(["workspaceId": workspaceId, "prompt": prompt]), ok: [201])
        return wrap.run
    }

    func followup(runId: String, prompt: String) async throws -> RunDTO {
        let wrap: DispatchResponse = try await send("/mobile/runs/\(runId)/followup", method: "POST", body: encode(["prompt": prompt]), ok: [200, 201])
        return wrap.run
    }

    func retry(runId: String) async throws -> RunDTO {
        let wrap: DispatchResponse = try await send("/mobile/runs/\(runId)/retry", method: "POST", body: Data("{}".utf8), ok: [200])
        return wrap.run
    }

    func archive(runId: String) async throws -> RunDTO {
        let wrap: DispatchResponse = try await send("/mobile/runs/\(runId)/archive", method: "POST", body: Data("{}".utf8), ok: [200])
        return wrap.run
    }

    func unarchive(runId: String) async throws -> RunDTO {
        let wrap: DispatchResponse = try await send("/mobile/runs/\(runId)/unarchive", method: "POST", body: Data("{}".utf8), ok: [200])
        return wrap.run
    }

    func answer(runId: String, body: [String: Any]) async throws {
        let data = try JSONSerialization.data(withJSONObject: body)
        let _: EmptyJSON = try await send("/mobile/runs/\(runId)/answer", method: "POST", body: data, ok: [202, 200], allowEmpty: true)
    }

    func cancel(runId: String) async throws {
        let _: EmptyJSON = try await send("/mobile/runs/\(runId)/cancel", method: "POST", body: Data("{}".utf8), ok: [200], allowEmpty: true)
    }

    func registerPushToken(_ token: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["token": token, "environment": "production"])
        let _: EmptyJSON = try await send("/mobile/push-token", method: "POST", body: body, ok: [204], allowEmpty: true)
    }

    func deletePushToken(_ token: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["token": token])
        let _: EmptyJSON = try await send("/mobile/push-token", method: "DELETE", body: body, ok: [204], allowEmpty: true)
    }

    func promptSnippets() async throws -> [PromptSnippet] {
        let wrap: PromptSnippetsResponse = try await get("/mobile/prompt-snippets")
        return wrap.snippets
    }

    func putPromptSnippets(_ snippets: [PromptSnippet]) async throws -> [PromptSnippet] {
        let body = try JSONEncoder().encode(PromptSnippetsResponse(snippets: snippets))
        let wrap: PromptSnippetsResponse = try await send("/mobile/prompt-snippets", method: "PUT", body: body, ok: [200])
        return wrap.snippets
    }

    func streamEvents() -> AsyncThrowingStream<StreamFrame, Error> {
        let base = self.base
        let token = self.token
        return AsyncThrowingStream { continuation in
            let work = Task {
                do {
                    guard let url = URL(string: base + "/mobile/stream") else {
                        throw RelayAPIError.transport("bad url")
                    }
                    var req = URLRequest(url: url)
                    req.httpMethod = "GET"
                    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    req.timeoutInterval = 90
                    let (bytes, resp) = try await URLSession.shared.bytes(for: req)
                    let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                    if code != 200 {
                        throw RelayAPIError.http(code, code == 404 ? "NO_STREAM" : "HTTP \(code)")
                    }
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        if line.hasPrefix(":") { continue }
                        guard line.hasPrefix("data:") else { continue }
                        let raw = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                        guard let data = raw.data(using: .utf8) else { continue }
                        continuation.yield(try JSONDecoder().decode(StreamFrame.self, from: data))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in work.cancel() }
        }
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await send(path, method: "GET", body: nil, ok: [200])
    }

    private func send<T: Decodable>(_ path: String, method: String, body: Data?, ok: [Int], allowEmpty: Bool = false) async throws -> T {
        guard let url = URL(string: base + path) else { throw RelayAPIError.transport("bad url") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 30
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if !ok.contains(code) {
            throw RelayAPIError.classify(status: code, data: data)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            if allowEmpty { return try JSONDecoder().decode(T.self, from: Data("{}".utf8)) }
            throw error
        }
    }

    private func encode(_ body: [String: String]) throws -> Data {
        try JSONEncoder().encode(body)
    }
}
