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
    @Published var lastError: String?

    private var poll: Task<Void, Never>?

    var bound: Bool { !relay.isEmpty && !token.isEmpty }

    init() {
        relay = UserDefaults.standard.string(forKey: "relay") ?? ""
        fleet = UserDefaults.standard.string(forKey: "fleet") ?? ""
        token = UserDefaults.standard.string(forKey: "token") ?? ""
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
        workspaces = []; runs = []
    }

    func api() -> RelayAPI { RelayAPI(base: relay, token: token) }

    func refresh() async {
        guard bound else { return }
        do {
            let api = api()
            async let w = api.workspaces()
            async let r = api.runs()
            let ws = try await w
            hubOffline = ws.hubOffline
            workspaces = ws.workspaces
            runs = try await r
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
            TabView {
                WorkspaceListView()
                    .tabItem { Label("工作区", systemImage: "folder") }
                RunListView()
                    .tabItem { Label("任务", systemImage: "list.bullet") }
            }
        } else {
            BindView()
        }
    }
}
