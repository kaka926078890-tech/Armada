import SwiftUI
import Combine
import UIKit
import UserNotifications

enum PushInbox {
    static var runId: String?
}

@MainActor
final class Appearance: ObservableObject {
    static let themeKey = "armada.theme.v1"
    static let scaleKey = "armada.fontScale.v1"

    @Published var theme: String {
        didSet { UserDefaults.standard.set(theme, forKey: Self.themeKey) }
    }
    @Published var fontScale: String {
        didSet { UserDefaults.standard.set(fontScale, forKey: Self.scaleKey) }
    }

    var textScale: CGFloat {
        switch fontScale {
        case "large": return 1.25
        case "xlarge": return 1.5
        default: return 1
        }
    }

    var dynamicTypeSize: DynamicTypeSize {
        switch fontScale {
        case "large": return .xxLarge
        case "xlarge": return .accessibility1
        default: return .large
        }
    }

    init() {
        theme = UserDefaults.standard.string(forKey: Self.themeKey) == "light" ? "light" : "dark"
        let scale = UserDefaults.standard.string(forKey: Self.scaleKey)
        fontScale = (scale == "large" || scale == "xlarge") ? scale! : "normal"
    }
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
    @Published var streamHealthy = false
    @Published var snippets: [PromptSnippet] = []
    @Published var cursorReload: CursorReloadDTO?

    private var live: Task<Void, Never>?
    private var foreground = true
    private var refreshSeq = 0
    private var snippetsSeq = 0
    private var pendingArchive = Set<String>()
    private var pendingUnarchive = Set<String>()
    private var unreadHold = Set<String>()
    private var lastBadge = -1
    private let readKey = "armada.readAt"
    private let pushTokenKey = "armada.pushToken"

    var bound: Bool { !relay.isEmpty && !token.isEmpty }

    init() {
        relay = UserDefaults.standard.string(forKey: "relay") ?? ""
        fleet = UserDefaults.standard.string(forKey: "fleet") ?? ""
        if let stored = OperatorKeychain.load(), !stored.isEmpty {
            token = stored
        } else {
            let legacy = UserDefaults.standard.string(forKey: "token") ?? ""
            token = legacy
            if !legacy.isEmpty {
                OperatorKeychain.save(legacy)
                UserDefaults.standard.removeObject(forKey: "token")
            }
        }
        if let data = UserDefaults.standard.data(forKey: readKey),
           let map = try? JSONDecoder().decode([String: Double].self, from: data) {
            readAt = map
        }
        if bound { startLive() }
    }

    func bind(uri: String) {
        switch RelayInviteParser.parse(uri) {
        case .failure(let e):
            bindError = e == .insecure ? "中转必须是 https，或模拟器下的 http://127.0.0.1" : "邀请格式无效"
        case .success(let inv) where inv.kind == .pair:
            bindError = "这是中台链接，请粘贴 App 邀请（armada-relay://op）"
        case .success(let inv):
            snippetsSeq += 1
            relay = inv.relay
            fleet = inv.fleet
            token = inv.tokenOrSecret
            UserDefaults.standard.set(relay, forKey: "relay")
            UserDefaults.standard.set(fleet, forKey: "fleet")
            OperatorKeychain.save(token)
            bindError = nil
            startLive()
            requestPush()
        }
    }

    func unbind() {
        stopLive()
        let push = UserDefaults.standard.string(forKey: pushTokenKey)
        let relayApi = bound ? self.api() : nil
        relay = ""; fleet = ""; token = ""
        UserDefaults.standard.removeObject(forKey: "relay")
        UserDefaults.standard.removeObject(forKey: "fleet")
        UserDefaults.standard.removeObject(forKey: "token")
        OperatorKeychain.delete()
        workspaces = []; runs = []; hiddenRuns = []; snippets = []
        pendingArchive = []; pendingUnarchive = []
        lastBadge = -1
        refreshSeq += 1
        snippetsSeq += 1
        pendingOpenRunId = nil
        watchingId = nil
        unreadHold.removeAll()
        PushInbox.runId = nil
        UNUserNotificationCenter.current().setBadgeCount(0)
        UIApplication.shared.unregisterForRemoteNotifications()
        if let push {
            UserDefaults.standard.removeObject(forKey: pushTokenKey)
            if let api = relayApi {
                Task { try? await api.deletePushToken(push) }
            }
        }
    }

    func api() -> RelayAPI { RelayAPI(base: relay, token: token) }

    func loadSnippets() async {
        guard bound else {
            snippets = []
            return
        }
        let seq = snippetsSeq
        let api = api()
        do {
            let next = try await api.promptSnippets()
            guard bound, seq == snippetsSeq else { return }
            snippets = next
            lastError = nil
        } catch {
            guard bound, seq == snippetsSeq else { return }
            snippets = []
            lastError = RelayAPIError.operatorMessage("READ_FAIL")
        }
    }

    func saveSnippets(_ next: [PromptSnippet]) async throws {
        guard bound else { return }
        let seq = snippetsSeq
        let api = api()
        let previous = snippets
        snippets = next
        do {
            let saved = try await api.putPromptSnippets(next)
            guard bound, seq == snippetsSeq else { return }
            snippets = saved
            lastError = nil
        } catch {
            guard bound, seq == snippetsSeq else { return }
            snippets = previous
            lastError = error.localizedDescription
            throw error
        }
    }

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
            async let reload = api.cursorReload()
            let ws = try await w
            let newRuns = try await r
            let newHidden: [RunDTO]
            do {
                newHidden = try await h
            } catch {
                newHidden = hiddenRuns
            }
            let fetchedReload: CursorReloadDTO?
            do {
                fetchedReload = try await reload
            } catch {
                fetchedReload = nil
            }
            let reloadState = ws.cursorReload ?? fetchedReload
            guard seq == refreshSeq else { return }
            if hubOffline != ws.hubOffline { hubOffline = ws.hubOffline }
            if workspaces != ws.workspaces { workspaces = ws.workspaces }
            if cursorReload != reloadState { cursorReload = reloadState }
            adoptFetchedLists(runs: newRuns, hidden: newHidden)
            if optionalChanged(lastError, nil) { lastError = nil }
            if let id = watchingId {
                markOpened(id)
            } else {
                applyBadge()
            }
        } catch {
            guard seq == refreshSeq else { return }
            lastError = error.localizedDescription
        }
    }

    private func keepListBodies(_ incoming: [RunDTO], prior: [RunDTO]) -> [RunDTO] {
        let old = Dictionary(uniqueKeysWithValues: prior.map { ($0.runId, $0) })
        return incoming.map { coalesceFinalText($0, prior: old[$0.runId]) }
    }

    private func adoptFetchedLists(runs incomingRuns: [RunDTO], hidden incomingHidden: [RunDTO]) {
        var nextRuns = keepListBodies(incomingRuns, prior: runs)
        var nextHidden = keepListBodies(incomingHidden, prior: hiddenRuns)
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
        pendingArchive = stillArchive
        pendingUnarchive = stillUnarchive
        if runs.count != nextRuns.count || !zip(runs, nextRuns).allSatisfy(runContentEquals) {
            runs = nextRuns
        }
        if hiddenRuns.count != nextHidden.count || !zip(hiddenRuns, nextHidden).allSatisfy(runContentEquals) {
            hiddenRuns = nextHidden
        }
    }

    func applyBadge() {
        let n = workspaces.reduce(0) { $0 + unreadCount(in: $1) }
        guard shouldUpdateBadge(current: lastBadge, next: n) else { return }
        lastBadge = n
        // APNs writes badge:1 on the icon without going through App state; always reconcile.
        UNUserNotificationCenter.current().setBadgeCount(n)
    }

    func setForeground(_ active: Bool) {
        if foreground == active { return }
        foreground = active
        guard bound else { return }
        if active {
            applyBadge()
            startLive()
        } else {
            stopLive()
        }
    }

    func startLive() {
        live?.cancel()
        live = Task { await runLive() }
    }

    func stopLive() {
        live?.cancel()
        live = nil
        streamHealthy = false
    }

    private func runLive() async {
        await refresh()
        var backoff: UInt64 = 2_000_000_000
        while !Task.isCancelled && bound && foreground {
            do {
                try await consumeStream()
                streamHealthy = false
                backoff = 2_000_000_000
            } catch is CancellationError {
                streamHealthy = false
                return
            } catch let urlErr as URLError where urlErr.code == .cancelled {
                streamHealthy = false
                return
            } catch {
                streamHealthy = false
                if Task.isCancelled || !bound || !foreground { return }
                await refresh()
                do {
                    try await Task.sleep(nanoseconds: backoff)
                } catch {
                    return
                }
                backoff = min(backoff * 2, 60_000_000_000)
            }
        }
        streamHealthy = false
    }

    private func consumeStream() async throws {
        var first = true
        let stream = await api().streamEvents()
        for try await frame in stream {
            if Task.isCancelled { throw CancellationError() }
            applyStreamFrame(frame)
            if first {
                first = false
                streamHealthy = true
            }
        }
    }

    private func applyStreamFrame(_ frame: StreamFrame) {
        if frame.type == "workspaces", let list = frame.workspaces, let offline = frame.hubOffline {
            if hubOffline != offline { hubOffline = offline }
            if workspaces != list { workspaces = list }
            if let reload = frame.cursorReload, cursorReload != reload { cursorReload = reload }
            if optionalChanged(lastError, nil) { lastError = nil }
            applyBadge()
            return
        }
        if frame.type == "run", let run = frame.run {
            applyStreamRun(run)
            if optionalChanged(lastError, nil) { lastError = nil }
            applyBadge()
        }
    }

    private func applyStreamRun(_ run: RunDTO) {
        if pendingArchive.contains(run.runId) && !run.isArchived { return }
        if pendingUnarchive.contains(run.runId) && run.isArchived { return }
        if pendingArchive.contains(run.runId) && run.isArchived { pendingArchive.remove(run.runId) }
        if pendingUnarchive.contains(run.runId) && !run.isArchived { pendingUnarchive.remove(run.runId) }
        let prior = runs.first { $0.runId == run.runId } ?? hiddenRuns.first { $0.runId == run.runId }
        let adopted = coalesceFinalText(run, prior: prior)
        if let prior, runContentEquals(prior, adopted), prior.isArchived == adopted.isArchived {
            return
        }
        if adopted.isArchived {
            if let i = runs.firstIndex(where: { $0.runId == adopted.runId }) { runs.remove(at: i) }
            if let i = hiddenRuns.firstIndex(where: { $0.runId == adopted.runId }) {
                if !runContentEquals(hiddenRuns[i], adopted) { hiddenRuns[i] = adopted }
            } else {
                hiddenRuns.insert(adopted, at: 0)
            }
        } else {
            if let i = hiddenRuns.firstIndex(where: { $0.runId == adopted.runId }) { hiddenRuns.remove(at: i) }
            if let i = runs.firstIndex(where: { $0.runId == adopted.runId }) {
                if !runContentEquals(runs[i], adopted) { runs[i] = adopted }
            } else {
                runs.insert(adopted, at: 0)
            }
        }
        if watchingId == adopted.runId { markOpened(adopted.runId) }
    }

    func runs(in workspace: WorkspaceDTO, archived: Bool = false) -> [RunDTO] {
        let src = archived ? hiddenRuns : runs
        return src.filter { $0.machineId == workspace.machineId && $0.workspaceRoot == workspace.workspaceRoot }
    }

    func markOpened(_ runId: String) {
        guard shouldStampOpened(unreadHold: unreadHold, runId: runId) else {
            applyBadge()
            return
        }
        let activity = runs.first { $0.runId == runId }?.activityTs
            ?? hiddenRuns.first { $0.runId == runId }?.activityTs
        guard shouldStampReadAt(seen: readAt[runId], activityTs: activity) else {
            applyBadge()
            return
        }
        readAt[runId] = stampReadAt(nowMs: Date().timeIntervalSince1970 * 1000, activityTs: activity)
        persistRead()
        applyBadge()
    }

    func markUnread(_ runId: String, hold: Bool) {
        readAt.removeValue(forKey: runId)
        if hold { unreadHold.insert(runId) } else { unreadHold.remove(runId) }
        persistRead()
        applyBadge()
    }

    func clearUnreadHold(_ runId: String) {
        unreadHold.remove(runId)
    }

    func canMarkUnread(_ run: RunDTO) -> Bool {
        runAllowsMarkUnread(run, readAt: readAt, isUnread: { isUnread($0) })
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

    func machineNeedsReload(_ machineId: String) -> Bool {
        guard let reload = cursorReload else { return false }
        if let ids = reload.neededMachineIds {
            return ids.contains(machineId)
        }
        return reload.needed
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
    @StateObject private var appearance = Appearance()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(appearance)
                .preferredColorScheme(appearance.theme == "light" ? .light : .dark)
                .environment(\.dynamicTypeSize, appearance.dynamicTypeSize)
                .onOpenURL { session.bind(uri: $0.absoluteString) }
                .onAppear {
                    appDelegate.session = session
                    session.adoptPendingOpen()
                    session.requestPushIfBound()
                }
                .onChange(of: scenePhase) { _, phase in
                    session.setForeground(phase == .active)
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
