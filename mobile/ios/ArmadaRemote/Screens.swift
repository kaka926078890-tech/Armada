import SwiftUI
import UIKit

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
                    Text("模拟器可连本机中转 http://127.0.0.1:8780。这不是中台链接（pair）。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Armada Remote")
        }
    }
}

struct WorkspaceListView: View {
    @EnvironmentObject var session: Session
    var body: some View {
        NavigationStack {
            List {
                if session.hubOffline {
                    Text("中台离线或没有打开的仓").foregroundStyle(.secondary)
                }
                ForEach(session.workspaces) { w in
                    NavigationLink(value: w) {
                        VStack(alignment: .leading) {
                            Text(w.label).font(.headline)
                            Text(w.workspaceRoot).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("工作区")
            .navigationDestination(for: WorkspaceDTO.self) { w in
                DispatchView(workspace: w)
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
            .overlay {
                if session.workspaces.isEmpty && !session.hubOffline {
                    Text("中台离线或没有打开的仓").foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct DispatchView: View {
    @EnvironmentObject var session: Session
    let workspace: WorkspaceDTO
    @State private var prompt = ""
    @State private var sending = false
    @State private var err: String?
    @State private var sent: RunDTO?
    var body: some View {
        Form {
            Section(workspace.label) {
                Text(workspace.workspaceRoot).font(.caption).foregroundStyle(.secondary)
            }
            Section("Prompt") {
                TextField("不限字数", text: $prompt, axis: .vertical)
                    .lineLimit(8...20)
            }
            if let err { Text(err).foregroundStyle(.red) }
            if let sent {
                NavigationLink("已派发 \(sent.runId)") { RunDetailView(runId: sent.runId) }
            }
            Button(sending ? "派发中…" : "派发") {
                Task { await send() }
            }
            .disabled(sending || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .navigationTitle("派发")
    }

    private func send() async {
        sending = true
        defer { sending = false }
        do {
            sent = try await session.api().dispatch(workspaceId: workspace.workspaceId, prompt: prompt)
            err = nil
            await session.refresh()
        } catch {
            err = error.localizedDescription
        }
    }
}

struct RunListView: View {
    @EnvironmentObject var session: Session
    var body: some View {
        NavigationStack {
            List(session.runs) { run in
                NavigationLink(value: run.runId) {
                    HStack {
                        Circle().fill(color(run.status)).frame(width: 10, height: 10)
                        VStack(alignment: .leading) {
                            Text(run.prompt).lineLimit(2)
                            Text(run.status).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("任务")
            .navigationDestination(for: String.self) { RunDetailView(runId: $0) }
            .refreshable { await session.refresh() }
        }
    }

    private func color(_ status: String) -> Color {
        switch status {
        case "completed": return .green
        case "running", "dispatched", "binding", "queued": return .blue
        case "error", "aborted": return .red
        case "cancelled": return .gray
        default: return .orange
        }
    }
}

struct RunDetailView: View {
    @EnvironmentObject var session: Session
    let runId: String
    @State private var run: RunDTO?
    @State private var err: String?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let run {
                    Text(run.status).font(.headline)
                    if let e = run.error, !e.isEmpty { Text(e).foregroundStyle(.red) }
                    Text(run.prompt).font(.footnote).foregroundStyle(.secondary)
                    Divider()
                    Text(run.finalText ?? "").textSelection(.enabled)
                    if let ask = run.pendingAsk {
                        AskView(runId: runId, ask: ask) {
                            await reload()
                        }
                    }
                    Button("复制正文") {
                        UIPasteboard.general.string = run.finalText ?? ""
                    }
                    Button("取消任务") {
                        Task {
                            try? await session.api().cancel(runId: runId)
                            await reload()
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
        .task { await reload() }
    }

    private func reload() async {
        do {
            run = try await session.api().run(id: runId)
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
            Text("AskQuestion").font(.headline)
            ForEach(ask.questions) { q in
                Text(q.prompt).font(.subheadline)
                ForEach(q.options) { o in
                    Button(o.label) { optionId = o.id }
                        .buttonStyle(.bordered)
                        .tint(optionId == o.id ? .accentColor : .secondary)
                }
            }
            if let err { Text(err).foregroundStyle(.red) }
            HStack {
                Button("Continue") { Task { await submit(action: "continue") } }
                    .disabled(optionId == nil)
                Button("Skip") { Task { await submit(action: "skip") } }
            }
        }
        .padding(.vertical)
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
