import SwiftUI
import UIKit

enum AppRoute: Hashable {
    case workspace(WorkspaceDTO)
    case run(String)
    case settings
}

func hideError(_ error: Error) -> String {
    if let e = error as? RelayAPIError, case .http(_, let code) = e, code == "INVALID_STATE" {
        return "运行中不能隐藏"
    }
    return error.localizedDescription
}

/// CDP Ask 的 label 是 A/B/C，正文在 text；jsonl 可能只有 label。
func askOptionBody(label: String, text: String) -> String {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty ? label : t
}

func runRowChrome(_ run: RunDTO, unread: Bool) -> Color? {
    if run.pendingAsk != nil { return .red }
    if unread && run.status == "completed" { return .green }
    if unread && ["error", "aborted", "unknown"].contains(run.status) { return .red }
    return nil
}

func columnHasAlert(_ runs: [RunDTO], column: BoardColumn, isUnread: (RunDTO) -> Bool) -> Bool {
    runs.contains { run in
        guard run.column == column else { return false }
        if let c = runRowChrome(run, unread: isUnread(run)), c == .red { return true }
        return false
    }
}

func statusLabel(_ status: String) -> String {
    switch status {
    case "queued": return "排队中"
    case "dispatched": return "已派发"
    case "binding": return "绑定中"
    case "running": return "运行中"
    case "completed": return "已完成"
    case "cancelled": return "已取消"
    case "error", "aborted", "unknown": return "异常"
    default: return status
    }
}

func statusColor(_ status: String) -> Color {
    switch status {
    case "completed": return .green
    case "running", "dispatched", "binding", "queued", "created": return .blue
    case "error", "aborted", "unknown": return .red
    case "cancelled": return .gray
    default: return .orange
    }
}

let detailPromptMaxHeight: CGFloat = 180

func detailPromptShownHeight(_ contentHeight: CGFloat, cap: CGFloat = detailPromptMaxHeight) -> CGFloat {
    min(max(contentHeight, 24), cap)
}

struct UnreadBadge: View {
    let count: Int
    var body: some View {
        if count > 0 {
            Text(count > 99 ? "99+" : "\(count)")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 5)
                .frame(minWidth: 18, minHeight: 18)
                .background(Color.red)
                .clipShape(Capsule())
        }
    }
}

/// 页内主操作。导航栏必须用系统 `Button`，塞进 `ToolbarItem` 会被 iOS 26 玻璃胶囊裁成「源发 / 查看已藏」。
struct VolumeButton: View {
    enum Kind { case accent, quiet, danger }
    let title: String
    var kind: Kind = .accent
    var compact: Bool = false
    var expand: Bool = true
    var enabled: Bool = true
    var busy: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if busy { ProgressView().controlSize(.small) }
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
            }
            .frame(maxWidth: expand ? .infinity : nil, minHeight: compact ? 32 : 44)
            .padding(.horizontal, compact ? 12 : 14)
            .foregroundStyle(fg)
            .background(bg, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                if kind == .quiet {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(Color.primary.opacity(0.18), lineWidth: 1)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(!enabled || busy)
        .opacity(enabled ? 1 : 0.4)
    }

    private var fg: Color {
        switch kind {
        case .accent: return .white
        case .quiet: return .primary
        case .danger: return .white
        }
    }

    private var bg: Color {
        switch kind {
        case .accent: return Color.accentColor
        case .quiet: return Color(.secondarySystemFill)
        case .danger: return .red
        }
    }
}

struct RunRow: View {
    let run: RunDTO
    let unread: Bool
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            accent
            Circle().fill(statusColor(run.status)).frame(width: 8, height: 8).padding(.top, 6)
            VStack(alignment: .leading, spacing: 4) {
                Text(run.prompt).lineLimit(2)
                Text(run.pendingAsk != nil && run.status == "running" ? "待处理"
                     : !run.queuedOutbound.isEmpty ? "队列 \(run.queuedOutbound.count)"
                     : statusLabel(run.status))
                    .font(.caption)
                    .foregroundStyle(captionColor)
            }
            Spacer(minLength: 8)
            if unread {
                Circle().fill(run.status == "completed" && run.pendingAsk == nil ? Color.green : Color.red).frame(width: 7, height: 7).padding(.top, 8)
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var accent: some View {
        let c = runRowChrome(run, unread: unread)
        RoundedRectangle(cornerRadius: 1.5)
            .fill(c ?? Color.clear)
            .frame(width: 3)
            .padding(.vertical, 2)
    }

    private var captionColor: Color {
        if run.pendingAsk != nil { return .red }
        if unread && run.status == "completed" { return .green }
        if unread && ["error", "aborted", "unknown"].contains(run.status) { return .red }
        return .secondary
    }
}

struct BindView: View {
    @EnvironmentObject var session: Session
    @State private var paste = ""
    var body: some View {
        NavigationStack {
            Form {
                Section("粘贴 App 邀请") {
                    TextField("armada-relay://op?…", text: $paste, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .lineLimit(4...8)
                    VolumeButton(
                        title: "绑定",
                        enabled: !paste.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ) { session.bind(uri: paste) }
                }
                if let err = session.bindError {
                    Section { Text(err).foregroundStyle(.red) }
                }
                Section {
                    Text("绑定后按「机器 → 工作区」选仓。点进仓看任务，顶部派发。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("绑定")
        }
    }
}

struct WorkspaceListView: View {
    @EnvironmentObject var session: Session
    @State private var path = NavigationPath()
    var body: some View {
        NavigationStack(path: $path) {
            List {
                if session.hubOffline {
                    Text("中台离线或没有打开的仓").foregroundStyle(.secondary)
                }
                ForEach(session.machineGroups, id: \.id) { group in
                    Section {
                        ForEach(group.slots) { w in
                            NavigationLink(value: AppRoute.workspace(w)) {
                                HStack(spacing: 8) {
                                    Text("–").foregroundStyle(.secondary)
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack(spacing: 6) {
                                            Text(w.label)
                                            if session.hasLive(w) {
                                                ProgressView().scaleEffect(0.7)
                                            }
                                        }
                                        Text(w.workspaceRoot)
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                    Spacer(minLength: 8)
                                    UnreadBadge(count: session.unreadCount(in: w))
                                }
                            }
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Circle()
                                .fill(group.slots.contains(where: \.online) ? Color.green : Color.gray)
                                .frame(width: 8, height: 8)
                            Text(group.name)
                        }
                    }
                }
            }
            .navigationTitle("舰队")
            .navigationDestination(for: AppRoute.self) { route in
                switch route {
                case .workspace(let w):
                    WorkspaceHome(workspace: w)
                case .run(let id):
                    RunDetailView(runId: id)
                case .settings:
                    SettingsView()
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 12) {
                        Button("设置") { path.append(AppRoute.settings) }
                        Button("刷新") { Task { await session.refresh() } }
                    }
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button("解绑") { session.unbind() }
                }
            }
            .refreshable { await session.refresh() }
            .onAppear { openPending() }
            .onChange(of: session.pendingOpenRunId) { _, _ in openPending() }
        }
    }

    private func openPending() {
        session.adoptPendingOpen()
        guard let id = session.pendingOpenRunId else { return }
        path = NavigationPath()
        path.append(AppRoute.run(id))
        session.pendingOpenRunId = nil
    }
}

struct WorkspaceHome: View {
    @EnvironmentObject var session: Session
    let workspace: WorkspaceDTO
    @State private var tab: BoardColumn = .completed
    @State private var showDispatch = false
    @State private var showArchived = false

    private var boardRuns: [RunDTO] {
        session.runs(in: live, archived: showArchived)
    }

    private var live: WorkspaceDTO {
        liveWorkspace(id: workspace.workspaceId, slots: session.workspaces, fallback: workspace)
    }

    private var hideLabel: String {
        let n = session.runs(in: live, archived: true).count
        return n > 0 ? "查看已隐藏 \(n)" : "查看已隐藏"
    }

    var filtered: [RunDTO] {
        boardRuns.filter { $0.column == tab }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(BoardColumn.allCases) { col in
                        let n = boardRuns.filter { $0.column == col }.count
                        Button {
                            tab = col
                        } label: {
                            HStack(spacing: 4) {
                                Text(col.title)
                                if n > 0 { Text("\(n)").font(.caption2) }
                                if columnHasAlert(boardRuns, column: col, isUnread: session.isUnread) {
                                    Circle().fill(Color.red).frame(width: 7, height: 7)
                                }
                            }
                            .font(.subheadline.weight(tab == col ? .semibold : .regular))
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(tab == col ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.12))
                            .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
            List {
                if let err = session.lastError {
                    Text(err).foregroundStyle(.red).font(.caption)
                }
                if showArchived {
                    Text("已隐藏的任务仍保留，可取消隐藏。").font(.caption).foregroundStyle(.secondary)
                }
                if filtered.isEmpty {
                    Text("这一列还没有任务").foregroundStyle(.secondary)
                }
                ForEach(filtered, id: \.runId) { run in
                    NavigationLink(value: AppRoute.run(run.runId)) {
                        RunRow(run: run, unread: session.isUnread(run))
                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                        if session.canMarkUnread(run) {
                            Button("标为未读") {
                                session.markUnread(run.runId, hold: false)
                            }
                            .tint(.orange)
                        }
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        if showArchived {
                            Button("取消隐藏") {
                                session.applyLocalArchive(run.runId, archived: false)
                                Task { await unhide(run.runId) }
                            }
                        } else if run.showsArchive {
                            Button("隐藏", role: .destructive) {
                                session.applyLocalArchive(run.runId, archived: true)
                                Task { await hide(run.runId) }
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
        }
        .navigationTitle(live.label)
        .safeAreaInset(edge: .top) {
            if !live.canInject {
                Text(RelayAPIError.operatorMessage("CDP_NOT_READY"))
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(Color.red.opacity(0.08))
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 12) {
                    Button(showArchived ? "返回看板" : hideLabel) { showArchived.toggle() }
                    if !showArchived {
                        Button("派发") { showDispatch = true }
                            .disabled(!live.canInject)
                    }
                }
            }
        }
        .sheet(isPresented: $showDispatch) {
            DispatchSheet(workspace: live) { col in
                showDispatch = false
                tab = col
            }
        }
        .onAppear { applyFocus() }
        .onChange(of: session.focusColumn) { _, _ in applyFocus() }
    }

    private func applyFocus() {
        if let col = session.focusColumn {
            tab = col
            session.focusColumn = nil
        }
    }

    private func hide(_ runId: String) async {
        do {
            let run = try await session.api().archive(runId: runId)
            session.applyLocalArchive(runId, archived: true, snapshot: run)
            session.lastError = nil
            await session.refresh()
        } catch {
            session.revertLocalArchive(runId)
            session.lastError = hideError(error)
        }
    }

    private func unhide(_ runId: String) async {
        do {
            let run = try await session.api().unarchive(runId: runId)
            session.applyLocalArchive(runId, archived: false, snapshot: run)
            session.lastError = nil
            await session.refresh()
        } catch {
            session.revertLocalArchive(runId)
            session.lastError = error.localizedDescription
        }
    }
}

struct DispatchSheet: View {
    @EnvironmentObject var session: Session
    let workspace: WorkspaceDTO
    var followupRunId: String? = nil
    var onDone: (BoardColumn) -> Void
    @StateObject private var speech = PromptSpeech()
    @State private var sending = false
    @State private var err: String?
    @Environment(\.dismiss) private var dismiss

    private var live: WorkspaceDTO {
        liveWorkspace(id: workspace.workspaceId, slots: session.workspaces, fallback: workspace)
    }

    private var trimmed: String {
        speech.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSend: Bool { live.canInject && !sending && !speech.listening && !trimmed.isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                if !live.canInject {
                    Section {
                        Text(RelayAPIError.operatorMessage("CDP_NOT_READY")).foregroundStyle(.red)
                    }
                }
                if let err {
                    Section {
                        Text(err).foregroundStyle(.red)
                    }
                }
                if let speechErr = speech.error {
                    Section {
                        Text(speechErr).foregroundStyle(.red)
                    }
                }
                Section(live.machineName.isEmpty ? live.label : "\(live.machineName) · \(live.label)") {
                    Text(live.workspaceRoot).font(.caption).foregroundStyle(.secondary)
                    if followupRunId != nil {
                        Text("在当前对话里继续，不会新开一条任务").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section {
                    TextEditor(text: $speech.prompt)
                        .frame(minHeight: 220)
                        .font(.body)
                        .disabled(speech.listening)
                    Text(trimmed.isEmpty ? "粘贴或语音后应显示字数" : "\(speech.prompt.count) 字")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if speech.listening {
                        Text("正在听…说完点停止，改完再派发")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    VolumeButton(
                        title: speech.listening ? "停止" : "语音",
                        kind: .quiet,
                        enabled: !sending
                    ) { speech.toggle() }
                    VolumeButton(
                        title: sending ? "发送中…" : (followupRunId == nil ? "派发" : "发送"),
                        enabled: canSend,
                        busy: sending
                    ) { Task { await send() } }
                } header: {
                    Text("Prompt")
                } footer: {
                    Text("语音只写入提示词，不会自动发送。长文请用此处按钮发送；导航栏「派发」在键盘弹起时可能点不到。")
                }
            }
            .navigationTitle(followupRunId == nil ? "派发任务" : "续聊")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") {
                        speech.release()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(sending ? "发送中…" : (followupRunId == nil ? "派发" : "发送")) {
                        Task { await send() }
                    }
                    .disabled(!canSend)
                }
            }
            .onDisappear { speech.release() }
        }
    }

    private func send() async {
        if speech.listening {
            speech.stop()
            return
        }
        let text = trimmed
        guard canSend else { return }
        sending = true
        defer { sending = false }
        do {
            let run: RunDTO
            if let followupRunId {
                run = try await session.api().followup(runId: followupRunId, prompt: text)
            } else {
                run = try await session.api().dispatch(workspaceId: live.workspaceId, prompt: text)
            }
            err = nil
            await session.refresh()
            onDone(run.column)
            dismiss()
        } catch {
            err = error.localizedDescription
        }
    }
}

struct DetailPromptCard: View {
    let text: String
    @Binding var contentHeight: CGFloat
    @State private var expanded = false

    private var overflows: Bool { contentHeight > detailPromptMaxHeight }
    private var shownHeight: CGFloat {
        expanded ? max(contentHeight, 24) : detailPromptShownHeight(contentHeight)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Color.accentColor.frame(width: 3)
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("提示词")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    if overflows {
                        VolumeButton(title: expanded ? "收起" : "展开", kind: .quiet, compact: true, expand: false) {
                            withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
                        }
                    }
                }
                MarkdownWebView(text: text, height: $contentHeight)
                    .frame(height: shownHeight, alignment: .top)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .clipped()
                    .overlay(alignment: .bottom) {
                        if overflows && !expanded {
                            LinearGradient(
                                colors: [
                                    Color(.secondarySystemBackground).opacity(0),
                                    Color(.secondarySystemBackground),
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                            .frame(height: 36)
                            .allowsHitTesting(false)
                        }
                    }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .onChange(of: text) { _, _ in expanded = false }
    }
}

struct DetailReplyBlock: View {
    let text: String?
    let isLive: Bool
    @Binding var height: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("回复")
                    .font(.subheadline.weight(.semibold))
                Rectangle()
                    .fill(Color.primary.opacity(0.12))
                    .frame(height: 1)
            }
            if let text, !text.isEmpty {
                MarkdownWebView(text: text, height: $height)
                    .frame(height: max(height, 80))
            } else if isLive {
                Text("还没有终态正文").foregroundStyle(.secondary)
            } else {
                Text("没有正文").foregroundStyle(.secondary)
            }
        }
        .padding(.top, 8)
    }
}

struct RunDetailView: View {
    @EnvironmentObject var session: Session
    let runId: String
    @State private var run: RunDTO?
    @State private var err: String?
    @State private var mdHeight: CGFloat = 120
    @State private var promptHeight: CGFloat = 40
    @State private var showDispatch = false
    @Environment(\.dismiss) private var dismiss

    private var slot: WorkspaceDTO? {
        guard let run else { return nil }
        return session.workspaces.first { $0.machineId == run.machineId && $0.workspaceRoot == run.workspaceRoot }
    }

    private var streamed: RunDTO? {
        session.runs.first { $0.runId == runId } ?? session.hiddenRuns.first { $0.runId == runId }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let run {
                    if let err { Text(err).foregroundStyle(.red) }
                    HStack {
                        Circle().fill(statusColor(run.status)).frame(width: 10, height: 10)
                        Text(statusLabel(run.status)).font(.headline)
                    }
                    Text("\(run.workspace(from: session.workspaces).machineName) · \(run.workspace(from: session.workspaces).label)")
                        .font(.subheadline)
                    Text(run.workspaceRoot).font(.caption).foregroundStyle(.secondary)
                    if let e = run.displayError { Text(RelayAPIError.operatorMessage(e)).foregroundStyle(.red) }
                    if slot?.canInject == false, run.displayError != "CDP_NOT_READY" {
                        Text(RelayAPIError.operatorMessage("CDP_NOT_READY")).foregroundStyle(.red)
                    }
                    DetailPromptCard(text: run.prompt, contentHeight: $promptHeight)
                    DetailReplyBlock(text: run.finalText, isLive: run.isLive, height: $mdHeight)
                    if let ask = run.pendingAsk {
                        AskView(runId: runId, ask: ask) { await reload() }
                    }
                    if !run.queuedOutbound.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("\(run.queuedOutbound.count) 条排队消息").font(.caption).foregroundStyle(.secondary)
                            ForEach(run.queuedOutbound) { q in
                                Text(q.prompt).font(.subheadline)
                            }
                        }
                    }
                    VolumeButton(title: "复制正文", kind: .quiet) {
                        UIPasteboard.general.string = run.finalText ?? ""
                    }
                    if session.canMarkUnread(run) {
                        VolumeButton(title: "标为未读", kind: .quiet) {
                            session.markUnread(runId, hold: true)
                        }
                    }
                    if run.isLive {
                        VolumeButton(title: "取消任务", kind: .danger) {
                            Task {
                                try? await session.api().cancel(runId: runId)
                                await reload()
                                await session.refresh()
                            }
                        }
                    }
                    if run.showsRetry {
                        VolumeButton(title: "重试", enabled: slot?.canInject ?? false) {
                            Task {
                                do {
                                    _ = try await session.api().retry(runId: runId)
                                    err = nil
                                    await reload()
                                    await session.refresh()
                                } catch {
                                    err = error.localizedDescription
                                }
                            }
                        }
                    }
                    if run.isArchived {
                        VolumeButton(title: "取消隐藏", kind: .quiet) {
                            Task {
                                session.applyLocalArchive(runId, archived: false, snapshot: run)
                                do {
                                    let next = try await session.api().unarchive(runId: runId)
                                    session.applyLocalArchive(runId, archived: false, snapshot: next)
                                    err = nil
                                    await reload()
                                    await session.refresh()
                                } catch {
                                    session.revertLocalArchive(runId)
                                    err = error.localizedDescription
                                }
                            }
                        }
                    } else if run.showsArchive {
                        VolumeButton(title: "隐藏", kind: .quiet) {
                            Task {
                                session.applyLocalArchive(runId, archived: true, snapshot: run)
                                do {
                                    let next = try await session.api().archive(runId: runId)
                                    session.applyLocalArchive(runId, archived: true, snapshot: next)
                                    err = nil
                                    await session.refresh()
                                    dismiss()
                                } catch {
                                    session.revertLocalArchive(runId)
                                    err = hideError(error)
                                }
                            }
                        }
                    }
                } else if let err {
                    Text(err).foregroundStyle(.red)
                } else {
                    ProgressView()
                }
            }
            .padding()
        }
        .navigationTitle("详情")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("续聊") { showDispatch = true }
                    .disabled(!((slot?.canInject ?? false) && (run?.canFollowup ?? false)))
            }
        }
        .sheet(isPresented: $showDispatch) {
            if let slot {
                DispatchSheet(workspace: slot, followupRunId: runId) { _ in
                    showDispatch = false
                    Task {
                        await reload()
                        await session.refresh()
                    }
                }
            }
        }
        .task(id: runId) {
            session.watchingId = runId
            session.markOpened(runId)
            await reload()
            while !Task.isCancelled {
                if session.streamHealthy {
                    do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { break }
                    continue
                }
                do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { break }
                if Task.isCancelled { break }
                await reload()
            }
        }
        .onChange(of: streamed) { _, next in
            guard let next else { return }
            let local = run
            run = coalesceFinalText(next, prior: local)
            if session.watchingId == runId { session.markOpened(runId) }
            if detailShouldReload(local: local, streamed: next) {
                Task { await reload() }
            }
        }
        .onDisappear {
            if session.watchingId == runId { session.watchingId = nil }
            session.clearUnreadHold(runId)
        }
        .refreshable { await reload() }
    }

    private func reload() async {
        do {
            let fetched = try await session.api().run(id: runId)
            run = coalesceFinalText(fetched, prior: run)
            session.markOpened(runId)
            err = nil
        } catch {
            err = error.localizedDescription
        }
    }
}

struct AskView: View {
    let runId: String
    let ask: PendingAskDTO
    var onDone: () async -> Void
    @EnvironmentObject var session: Session
    @State private var optionId: String?
    @State private var err: String?
    @State private var busyAction: String?
    @State private var planHeight: CGFloat = 80

    private static let planYellow = Color(red: 241 / 255, green: 180 / 255, blue: 103 / 255)
    private static let accentBlue = Color(red: 89 / 255, green: 156 / 255, blue: 231 / 255)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if isPlan {
                Text("Created Plan").font(.headline)
                Text(ask.questions.first?.prompt ?? "")
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                if let overview = ask.questions.first?.options.first?.text,
                   !overview.isEmpty, overview != "Build" {
                    MarkdownWebView(text: overview, height: $planHeight)
                        .frame(height: max(planHeight, 80))
                }
                if let err { Text(err).foregroundStyle(.red) }
                Button {
                    Task { await submitBuild() }
                } label: {
                    HStack(spacing: 8) {
                        if busyAction == "continue" { ProgressView().tint(.black) }
                        Text(busyAction == "continue" ? "Building..." : "Build")
                            .font(.body.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(Self.planYellow)
                .foregroundStyle(.black)
                .disabled(busyAction != nil)
            } else {
                Text("需要选择").font(.headline)
                ForEach(ask.questions) { q in
                    Text(q.prompt)
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    ForEach(q.options) { o in
                        Button {
                            optionId = o.id
                        } label: {
                            HStack(alignment: .top, spacing: 8) {
                                Text(o.label.isEmpty ? o.id.uppercased() : o.label)
                                    .font(.body.monospaced())
                                    .foregroundStyle(.secondary)
                                Text(askOptionBody(label: o.label, text: o.text))
                                    .font(.body)
                                    .multilineTextAlignment(.leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(.vertical, 12)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(busyAction != nil)
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .background(
                            RoundedRectangle(cornerRadius: 10)
                                .fill(optionId == o.id ? Self.accentBlue.opacity(0.12) : Color.clear)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(optionId == o.id ? Self.accentBlue : Color.secondary.opacity(0.35), lineWidth: optionId == o.id ? 2 : 1)
                        )
                    }
                }
                if let err { Text(err).foregroundStyle(.red) }
                HStack(spacing: 10) {
                    Button {
                        Task { await submit(action: "skip") }
                    } label: {
                        HStack(spacing: 8) {
                            if busyAction == "skip" { ProgressView() }
                            Text(busyAction == "skip" ? "Skipping..." : "跳过")
                                .font(.body.weight(.medium))
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .disabled(busyAction != nil)
                    Button {
                        Task { await submit(action: "continue") }
                    } label: {
                        HStack(spacing: 8) {
                            if busyAction == "continue" { ProgressView().tint(.white) }
                            Text(busyAction == "continue" ? "Continuing..." : "继续")
                                .font(.body.weight(.semibold))
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .tint(Self.accentBlue)
                    .disabled(optionId == nil || busyAction != nil)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(isPlan ? Self.planYellow : Self.accentBlue)
                .frame(width: 4)
                .padding(.vertical, 10)
                .padding(.leading, 4)
        }
    }

    private var isPlan: Bool {
        let opts = ask.questions.first?.options ?? []
        return opts.count == 1 && opts.first?.id == "build"
    }

    private func submitBuild() async {
        guard busyAction == nil, let q = ask.questions.first, let opt = q.options.first else { return }
        optionId = opt.id
        busyAction = "continue"
        var body: [String: Any] = [
            "request_id": ask.request_id,
            "action": "continue",
            "answers": [["question_id": q.id, "option_ids": [opt.id]]],
        ]
        do {
            try await session.api().answer(runId: runId, body: body)
            await onDone()
        } catch {
            err = error.localizedDescription
            busyAction = nil
        }
    }

    private func submit(action: String) async {
        guard busyAction == nil else { return }
        if action == "continue", optionId == nil { return }
        busyAction = action
        var body: [String: Any] = ["request_id": ask.request_id, "action": action]
        if action == "continue", let q = ask.questions.first, let optionId {
            body["answers"] = [["question_id": q.id, "option_ids": [optionId]]]
        }
        do {
            try await session.api().answer(runId: runId, body: body)
            await onDone()
        } catch {
            err = error.localizedDescription
            busyAction = nil
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var appearance: Appearance
    var body: some View {
        List {
            Section("外观") {
                HStack(spacing: 8) {
                    VolumeButton(title: "黑夜", kind: appearance.theme == "dark" ? .accent : .quiet, compact: true) {
                        appearance.theme = "dark"
                    }
                    VolumeButton(title: "明亮", kind: appearance.theme == "light" ? .accent : .quiet, compact: true) {
                        appearance.theme = "light"
                    }
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            }
            Section("字号") {
                HStack(spacing: 8) {
                    VolumeButton(title: "正常", kind: appearance.fontScale == "normal" ? .accent : .quiet, compact: true) {
                        appearance.fontScale = "normal"
                    }
                    VolumeButton(title: "大", kind: appearance.fontScale == "large" ? .accent : .quiet, compact: true) {
                        appearance.fontScale = "large"
                    }
                    VolumeButton(title: "超大", kind: appearance.fontScale == "xlarge" ? .accent : .quiet, compact: true) {
                        appearance.fontScale = "xlarge"
                    }
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            }
        }
        .navigationTitle("设置")
    }
}
