import Foundation

struct WorkspaceDTO: Decodable, Identifiable, Hashable {
    var workspaceId: String
    var machineId: String
    var workspaceRoot: String
    var label: String
    var id: String { workspaceId }
}

struct WorkspacesResponse: Decodable {
    var hubOffline: Bool
    var workspaces: [WorkspaceDTO]
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
    var updatedAt: Int?
    var id: String { runId }
}

struct DispatchResponse: Decodable {
    var run: RunDTO
}

struct EmptyJSON: Decodable {}

struct ErrorBody: Decodable {
    var error: String?
}

enum RelayAPIError: LocalizedError {
    case http(Int, String)
    case pairInvite
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .http(_, let msg): return msg
        case .pairInvite: return "这是中台链接，请粘贴 App 邀请（armada-relay://op）"
        case .transport(let msg): return msg
        }
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

    func runs(limit: Int = 50) async throws -> [RunDTO] {
        struct Wrap: Decodable { var runs: [RunDTO] }
        let w: Wrap = try await get("/mobile/runs?limit=\(limit)")
        return w.runs
    }

    func run(id: String) async throws -> RunDTO {
        try await get("/mobile/runs/\(id)")
    }

    func dispatch(workspaceId: String, prompt: String) async throws -> RunDTO {
        let body = try JSONSerialization.data(withJSONObject: ["workspaceId": workspaceId, "prompt": prompt])
        let wrap: DispatchResponse = try await send("/mobile/runs", method: "POST", body: body, ok: [201])
        return wrap.run
    }

    func answer(runId: String, body: [String: Any]) async throws {
        let data = try JSONSerialization.data(withJSONObject: body)
        let _: EmptyJSON = try await send("/mobile/runs/\(runId)/answer", method: "POST", body: data, ok: [202, 200], allowEmpty: true)
    }

    func cancel(runId: String) async throws {
        let _: EmptyJSON = try await send("/mobile/runs/\(runId)/cancel", method: "POST", body: Data("{}".utf8), ok: [200], allowEmpty: true)
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await send(path, method: "GET", body: nil, ok: [200])
    }

    private func send<T: Decodable>(_ path: String, method: String, body: Data?, ok: [Int], allowEmpty: Bool = false) async throws -> T {
        guard let url = URL(string: base + path) else { throw RelayAPIError.transport("bad url") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 403 {
            if let err = try? JSONDecoder().decode(ErrorBody.self, from: data), err.error == "OPERATOR_REQUIRED" {
                throw RelayAPIError.pairInvite
            }
        }
        if !ok.contains(code) {
            let msg = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "HTTP \(code)"
            throw RelayAPIError.http(code, msg)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            if allowEmpty { return try JSONDecoder().decode(T.self, from: Data("{}".utf8)) }
            throw error
        }
    }
}
