import SwiftUI
import UIKit

enum AppRoute: Hashable {
    case workspace(WorkspaceDTO)
    case run(String)
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

struct RunRow: View {
    let run: RunDTO
    let unread: Bool
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(statusColor(run.status)).frame(width: 10, height: 10).padding(.top, 6)
            VStack(alignment: .leading, spacing: 4) {
                Text(run.prompt).lineLimit(2)
                Text(run.pendingAsk != nil && run.status == "running" ? "待处理"
                     : !run.queuedOutbound.isEmpty ? "队列 \(run.queuedOutbound.count)"
                     : statusLabel(run.status))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if unread {
                Circle().fill(Color.red).frame(width: 7, height: 7).padding(.top, 8)
            }
        }
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
                    Button("绑定") { session.bind(uri: paste) }
                    .disabled(paste.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("刷新") { Task { await session.refresh() } }
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button("解绑") { session.unbind() }
                }
            }
            .refreshable { await session.refresh() }
        }
    }
}

struct WorkspaceHome: View {
    @EnvironmentObject var session: Session
    let workspace: WorkspaceDTO
    @State private var tab: BoardColumn = .completed
    @State private var showDispatch = false

    var filtered: [RunDTO] {
        session.runs(in: workspace).filter { $0.column == tab }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(BoardColumn.allCases) { col in
                        let n = session.runs(in: workspace).filter { $0.column == col }.count
                        Button {
                            tab = col
                        } label: {
                            HStack(spacing: 4) {
                                Text(col.title)
                                if n > 0 { Text("\(n)").font(.caption2) }
                            }
                            .font(.subheadline.weight(tab == col ? .semibold : .regular))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(tab == col ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.08))
                            .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
            List {
                if filtered.isEmpty {
                    Text("这一列还没有任务").foregroundStyle(.secondary)
                }
                ForEach(filtered) { run in
                    NavigationLink(value: AppRoute.run(run.runId)) {
                        RunRow(run: run, unread: session.isUnread(run))
                    }
                }
            }
            .listStyle(.insetGrouped)
        }
        .navigationTitle(workspace.label)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("派发") { showDispatch = true }
            }
        }
        .sheet(isPresented: $showDispatch) {
            DispatchSheet(workspace: workspace) { col in
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
}

struct DispatchSheet: View {
    @EnvironmentObject var session: Session
    let workspace: WorkspaceDTO
    var followupRunId: String? = nil
    var onDone: (BoardColumn) -> Void
    @State private var prompt = ""
    @State private var sending = false
    @State private var err: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section(workspace.machineName.isEmpty ? workspace.label : "\(workspace.machineName) · \(workspace.label)") {
                    Text(workspace.workspaceRoot).font(.caption).foregroundStyle(.secondary)
                    if followupRunId != nil {
                        Text("在当前对话里继续，不会新开一条任务").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section("Prompt") {
                    TextField("不限字数", text: $prompt, axis: .vertical)
                        .lineLimit(8...20)
                }
                if let err { Text(err).foregroundStyle(.red) }
            }
            .navigationTitle(followupRunId == nil ? "派发任务" : "续聊")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(sending ? "发送中…" : (followupRunId == nil ? "派发" : "发送")) {
                        Task { await send() }
                    }
                    .disabled(sending || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func send() async {
        sending = true
        defer { sending = false }
        do {
            let run: RunDTO
            if let followupRunId {
                run = try await session.api().followup(runId: followupRunId, prompt: prompt)
            } else {
                run = try await session.api().dispatch(workspaceId: workspace.workspaceId, prompt: prompt)
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

struct RunDetailView: View {
    @EnvironmentObject var session: Session
    let runId: String
    @State private var run: RunDTO?
    @State private var err: String?
    @State private var mdHeight: CGFloat = 120
    @State private var showDispatch = false

    private var slot: WorkspaceDTO? {
        guard let run else { return nil }
        return session.workspaces.first { $0.machineId == run.machineId && $0.workspaceRoot == run.workspaceRoot }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let run {
                    HStack {
                        Circle().fill(statusColor(run.status)).frame(width: 10, height: 10)
                        Text(statusLabel(run.status)).font(.headline)
                    }
                    Text("\(run.workspace(from: session.workspaces).machineName) · \(run.workspace(from: session.workspaces).label)")
                        .font(.subheadline)
                    Text(run.workspaceRoot).font(.caption).foregroundStyle(.secondary)
                    if let e = run.displayError { Text(e).foregroundStyle(.red) }
                    Text(run.prompt).font(.footnote).foregroundStyle(.secondary)
                    Divider()
                    if let text = run.finalText, !text.isEmpty {
                        MarkdownWebView(text: text, height: $mdHeight)
                            .frame(height: max(mdHeight, 80))
                    } else if run.isLive {
                        Text("还没有终态正文").foregroundStyle(.secondary)
                    } else {
                        Text("没有正文").foregroundStyle(.secondary)
                    }
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
                    Button("复制正文") {
                        UIPasteboard.general.string = run.finalText ?? ""
                    }
                    if run.isLive {
                        Button("取消任务", role: .destructive) {
                            Task {
                                try? await session.api().cancel(runId: runId)
                                await reload()
                                await session.refresh()
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
                    .disabled(slot == nil || !(run?.canFollowup ?? false))
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
        .task {
            session.markOpened(runId)
            await reload()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                await reload()
            }
        }
        .refreshable { await reload() }
    }

    private func reload() async {
        do {
            run = try await session.api().run(id: runId)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if isPlan {
                Text("Created Plan").font(.headline)
                Text(ask.questions.first?.prompt ?? "").font(.subheadline)
                if let err { Text(err).foregroundStyle(.red) }
                Button("Build") { Task { await submitBuild() } }
            } else {
                Text("需要选择").font(.headline)
                ForEach(ask.questions) { q in
                    Text(q.prompt).font(.subheadline)
                    ForEach(q.options) { o in
                        Button(o.label.isEmpty ? o.text : o.label) { optionId = o.id }
                            .buttonStyle(.bordered)
                            .tint(optionId == o.id ? .accentColor : .secondary)
                    }
                }
                if let err { Text(err).foregroundStyle(.red) }
                HStack {
                    Button("继续") { Task { await submit(action: "continue") } }
                        .disabled(optionId == nil)
                    Button("跳过") { Task { await submit(action: "skip") } }
                }
            }
        }
        .padding(.vertical)
    }

    private var isPlan: Bool {
        let opts = ask.questions.first?.options ?? []
        return opts.count == 1 && opts.first?.id == "build"
    }

    private func submitBuild() async {
        guard let q = ask.questions.first, let opt = q.options.first else { return }
        optionId = opt.id
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
        }
    }

    private func submit(action: String) async {
        var body: [String: Any] = ["request_id": ask.request_id, "action": action]
        if action == "continue", let q = ask.questions.first, let optionId {
            body["answers"] = [["question_id": q.id, "option_ids": [optionId]]]
        }
        do {
            try await session.api().answer(runId: runId, body: body)
            await onDone()
        } catch {
            err = error.localizedDescription
        }
    }
}
