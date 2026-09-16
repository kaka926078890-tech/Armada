import SwiftUI
import Combine
import UIKit
import UserNotifications

enum PushInbox {
    static var runId: String?
}

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
    @Published var pendingOpenRunId: String?
    @Published var watchingId: String?

    private var poll: Task<Void, Never>?
    private var refreshSeq = 0
    private var pendingArchive = Set<String>()
    private var pendingUnarchive = Set<String>()
    private let readKey = "armada.readAt"
    private let pushTokenKey = "armada.pushToken"

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
            requestPush()
        }
    }

    func unbind() {
        poll?.cancel()
        let push = UserDefaults.standard.string(forKey: pushTokenKey)
        let relayApi = bound ? self.api() : nil
        relay = ""; fleet = ""; token = ""
        UserDefaults.standard.removeObject(forKey: "relay")
        UserDefaults.standard.removeObject(forKey: "fleet")
        UserDefaults.standard.removeObject(forKey: "token")
        workspaces = []; runs = []; hiddenRuns = []
        pendingArchive = []; pendingUnarchive = []
        refreshSeq += 1
        pendingOpenRunId = nil
        watchingId = nil
        PushInbox.runId = nil
        UIApplication.shared.applicationIconBadgeNumber = 0
        UIApplication.shared.unregisterForRemoteNotifications()
        if let push {
            UserDefaults.standard.removeObject(forKey: pushTokenKey)
            if let api = relayApi {
                Task { try? await api.deletePushToken(push) }
            }
        }
    }

    func api() -> RelayAPI { RelayAPI(base: relay, token: token) }

    func adoptPendingOpen() {
        guard bound else {
            PushInbox.runId = nil
            pendingOpenRunId = nil
            return
        }
        if let id = PushInbox.runId {
            pendingOpenRunId = id
            PushInbox.runId = nil
        }
    }

    func requestPushIfBound() {
        if bound { requestPush() }
    }

    func requestPush() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func registerPushToken(_ hex: String) async {
        guard bound, hex.count == 64 else { return }
        UserDefaults.standard.set(hex, forKey: pushTokenKey)
        try? await api().registerPushToken(hex)
    }

    func applyLocalArchive(_ runId: String, archived: Bool, snapshot: RunDTO? = nil) {
        if archived {
            pendingUnarchive.remove(runId)
            pendingArchive.insert(runId)
            let moved = snapshot ?? runs.first { $0.runId == runId } ?? hiddenRuns.first { $0.runId == runId }
            runs.removeAll { $0.runId == runId }
            if var run = moved {
                run.archived = true
                hiddenRuns = [run] + hiddenRuns.filter { $0.runId != runId }
            }
        } else {
            pendingArchive.remove(runId)
            pendingUnarchive.insert(runId)
            let moved = snapshot ?? hiddenRuns.first { $0.runId == runId } ?? runs.first { $0.runId == runId }
            hiddenRuns.removeAll { $0.runId == runId }
            if var run = moved {
                run.archived = false
                runs = [run] + runs.filter { $0.runId != runId }
            }
        }
    }

    func revertLocalArchive(_ runId: String) {
        if pendingArchive.contains(runId) {
            pendingArchive.remove(runId)
            let moved = hiddenRuns.first { $0.runId == runId }
            hiddenRuns.removeAll { $0.runId == runId }
            if var run = moved {
                run.archived = false
                runs = [run] + runs.filter { $0.runId != runId }
            }
            return
        }
        if pendingUnarchive.contains(runId) {
            pendingUnarchive.remove(runId)
            let moved = runs.first { $0.runId == runId }
            runs.removeAll { $0.runId == runId }
            if var run = moved {
                run.archived = true
                hiddenRuns = [run] + hiddenRuns.filter { $0.runId != runId }
            }
        }
    }

    func refresh() async {
        guard bound else { return }
        refreshSeq += 1
        let seq = refreshSeq
        do {
            let api = api()
            async let w = api.workspaces()
            async let r = api.runs()
            async let h = api.runs(archived: true)
            let ws = try await w
            let newRuns = try await r
            let newHidden = try await h
            guard seq == refreshSeq else { return }
            hubOffline = ws.hubOffline
            workspaces = ws.workspaces
            adoptFetchedLists(runs: newRuns, hidden: newHidden)
            lastError = nil
            applyBadge()
        } catch {
            guard seq == refreshSeq else { return }
            lastError = error.localizedDescription
        }
    }

    private func adoptFetchedLists(runs incomingRuns: [RunDTO], hidden incomingHidden: [RunDTO]) {
        var nextRuns = incomingRuns
        var nextHidden = incomingHidden
        var stillArchive = pendingArchive
        var stillUnarchive = pendingUnarchive
        for id in pendingArchive {
            if incomingHidden.contains(where: { $0.runId == id }) {
                stillArchive.remove(id)
            } else {
                nextRuns.removeAll { $0.runId == id }
                if let local = hiddenRuns.first(where: { $0.runId == id }),
                   !nextHidden.contains(where: { $0.runId == id }) {
                    nextHidden.insert(local, at: 0)
                }
            }
        }
        for id in pendingUnarchive {
            if incomingRuns.contains(where: { $0.runId == id }) && !incomingHidden.contains(where: { $0.runId == id }) {
                stillUnarchive.remove(id)
            } else {
                nextHidden.removeAll { $0.runId == id }
                if let local = runs.first(where: { $0.runId == id }),
                   !nextRuns.contains(where: { $0.runId == id }) {
                    nextRuns.insert(local, at: 0)
                }
            }
        }
        runs = nextRuns
        hiddenRuns = nextHidden
        pendingArchive = stillArchive
        pendingUnarchive = stillUnarchive
    }

    func applyBadge() {
        let n = workspaces.reduce(0) { $0 + unreadCount(in: $1) }
        UIApplication.shared.applicationIconBadgeNumber = n
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
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var session = Session()
    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .onOpenURL { session.bind(uri: $0.absoluteString) }
                .onAppear {
                    appDelegate.session = session
                    session.adoptPendingOpen()
                    session.requestPushIfBound()
                }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    weak var session: Session?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        if let info = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
            Self.takeRunId(info)
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in
            await session?.registerPushToken(hex)
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let runId = notification.request.content.userInfo["runId"] as? String
        if let runId, session?.watchingId == runId {
            completionHandler([])
        } else {
            completionHandler([.banner, .sound, .list])
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        Self.takeRunId(response.notification.request.content.userInfo)
        Task { @MainActor in
            session?.adoptPendingOpen()
        }
        completionHandler()
    }

    static func takeRunId(_ userInfo: [AnyHashable: Any]) {
        if let runId = userInfo["runId"] as? String, !runId.isEmpty {
            PushInbox.runId = runId
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
