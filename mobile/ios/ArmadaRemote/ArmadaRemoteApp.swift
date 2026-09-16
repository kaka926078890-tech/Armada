import SwiftUI
import Combine

@MainActor
final class Session: ObservableObject {
    @Published var relay: String
    @Published var fleet: String
    @Published var token: String
    @Published var bindError: String?
    @Published var workspaces: [WorkspaceDTO] = []
    @Published var hubOffline = false
    @Published var runs: [RunDTO] = []
    @Published var hiddenRuns: [RunDTO] = []
    @Published var lastError: String?
    @Published var readAt: [String: Double] = [:]
    @Published var focusColumn: BoardColumn?

    private var poll: Task<Void, Never>?
    private let readKey = "armada.readAt"

    var bound: Bool { !relay.isEmpty && !token.isEmpty }

    init() {
        relay = UserDefaults.standard.string(forKey: "relay") ?? ""
        fleet = UserDefaults.standard.string(forKey: "fleet") ?? ""
        token = UserDefaults.standard.string(forKey: "token") ?? ""
        if let data = UserDefaults.standard.data(forKey: readKey),
           let map = try? JSONDecoder().decode([String: Double].self, from: data) {
            readAt = map
        }
        if bound { startPolling() }
    }

    func bind(uri: String) {
        switch RelayInviteParser.parse(uri) {
        case .failure(let e):
            bindError = e == .insecure ? "中转必须是 https，或模拟器下的 http://127.0.0.1" : "邀请格式无效"
        case .success(let inv) where inv.kind == .pair:
            bindError = "这是中台链接，请粘贴 App 邀请（armada-relay://op）"
        case .success(let inv):
            relay = inv.relay
            fleet = inv.fleet
            token = inv.tokenOrSecret
            UserDefaults.standard.set(relay, forKey: "relay")
            UserDefaults.standard.set(fleet, forKey: "fleet")
            UserDefaults.standard.set(token, forKey: "token")
            bindError = nil
            startPolling()
        }
    }

    func unbind() {
        poll?.cancel()
        relay = ""; fleet = ""; token = ""
        UserDefaults.standard.removeObject(forKey: "relay")
        UserDefaults.standard.removeObject(forKey: "fleet")
        UserDefaults.standard.removeObject(forKey: "token")
        workspaces = []; runs = []; hiddenRuns = []
    }

    func api() -> RelayAPI { RelayAPI(base: relay, token: token) }

    func refresh() async {
        guard bound else { return }
        do {
            let api = api()
            async let w = api.workspaces()
            async let r = api.runs()
            async let h = api.runs(archived: true)
            let ws = try await w
            hubOffline = ws.hubOffline
            workspaces = ws.workspaces
            runs = try await r
            hiddenRuns = try await h
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func startPolling() {
        poll?.cancel()
        poll = Task {
            await refresh()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                await refresh()
            }
        }
    }

    func runs(in workspace: WorkspaceDTO, archived: Bool = false) -> [RunDTO] {
        let src = archived ? hiddenRuns : runs
        return src.filter { $0.machineId == workspace.machineId && $0.workspaceRoot == workspace.workspaceRoot }
    }

    func markOpened(_ runId: String) {
        readAt[runId] = Date().timeIntervalSince1970 * 1000
        persistRead()
    }

    func isUnread(_ run: RunDTO) -> Bool {
        let seen = readAt[run.runId]
        if run.pendingAsk != nil {
            if seen == nil { return true }
            if Double(run.activityTs) > seen! { return true }
        }
        if ["completed", "error", "unknown", "aborted"].contains(run.status) {
            return seen == nil || Double(run.activityTs) > seen!
        }
        return false
    }

    func unreadCount(in workspace: WorkspaceDTO) -> Int {
        runs(in: workspace).filter(isUnread).count
    }

    func hasLive(_ workspace: WorkspaceDTO) -> Bool {
        runs(in: workspace).contains(where: \.isLive)
    }

    var machineGroups: [(id: String, name: String, slots: [WorkspaceDTO])] {
        var order: [String] = []
        var map: [String: (name: String, slots: [WorkspaceDTO])] = [:]
        for w in workspaces {
            if map[w.machineId] == nil {
                order.append(w.machineId)
                map[w.machineId] = (w.machineName.isEmpty ? w.machineId : w.machineName, [])
            }
            map[w.machineId]?.slots.append(w)
            if !w.machineName.isEmpty {
                map[w.machineId]?.name = w.machineName
            }
        }
        return order.map { id in
            let g = map[id]!
            return (id, g.name, g.slots)
        }
    }

    private func persistRead() {
        if let data = try? JSONEncoder().encode(readAt) {
            UserDefaults.standard.set(data, forKey: readKey)
        }
    }
}

@main
struct ArmadaRemoteApp: App {
    @StateObject private var session = Session()
    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .onOpenURL { session.bind(uri: $0.absoluteString) }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var session: Session
    var body: some View {
        if session.bound {
            WorkspaceListView()
        } else {
            BindView()
        }
    }
}
