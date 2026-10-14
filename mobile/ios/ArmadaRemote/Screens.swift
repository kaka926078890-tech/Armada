import SwiftUI
import UIKit
import Foundation
import PhotosUI

/// Same tokens as `hub/web/src/index.css`. Dark is the hub default.
enum Hub {
    static let done = Color(red: 0x34 / 255, green: 0xD3 / 255, blue: 0x99 / 255)
    static let live = Color(red: 0x38 / 255, green: 0xBD / 255, blue: 0xF8 / 255)
    static let radius: CGFloat = 10

    struct Palette {
        var background: Color
        var foreground: Color
        var card: Color
        var primary: Color
        var onPrimary: Color
        var muted: Color
        var mutedForeground: Color
        var border: Color
        var destructive: Color
        var ask: Color
        var plan: Color
    }

    static func palette(dark: Bool) -> Palette {
        if dark {
            return Palette(
                background: Color(red: 0x0A / 255, green: 0x0A / 255, blue: 0x0A / 255),
                foreground: Color(red: 0xFA / 255, green: 0xFA / 255, blue: 0xFA / 255),
                card: Color(red: 0x17 / 255, green: 0x17 / 255, blue: 0x17 / 255),
                primary: Color(red: 0xE5 / 255, green: 0xE5 / 255, blue: 0xE5 / 255),
                onPrimary: Color(red: 0x17 / 255, green: 0x17 / 255, blue: 0x17 / 255),
                muted: Color(red: 0x26 / 255, green: 0x26 / 255, blue: 0x26 / 255),
                mutedForeground: Color(red: 0xA3 / 255, green: 0xA3 / 255, blue: 0xA3 / 255),
                border: Color.white.opacity(0.10),
                destructive: Color(red: 0xF8 / 255, green: 0x71 / 255, blue: 0x71 / 255),
                ask: Color(red: 0x59 / 255, green: 0x9C / 255, blue: 0xE7 / 255),
                plan: Color(red: 0xF1 / 255, green: 0xB4 / 255, blue: 0x67 / 255)
            )
        }
        return Palette(
            background: .white,
            foreground: Color(red: 0x0A / 255, green: 0x0A / 255, blue: 0x0A / 255),
            card: .white,
            primary: Color(red: 0x17 / 255, green: 0x17 / 255, blue: 0x17 / 255),
            onPrimary: Color(red: 0xFA / 255, green: 0xFA / 255, blue: 0xFA / 255),
            muted: Color(red: 0xF5 / 255, green: 0xF5 / 255, blue: 0xF5 / 255),
            mutedForeground: Color(red: 0x73 / 255, green: 0x73 / 255, blue: 0x73 / 255),
            border: Color(red: 0xE5 / 255, green: 0xE5 / 255, blue: 0xE5 / 255),
            destructive: Color(red: 0xDC / 255, green: 0x26 / 255, blue: 0x26 / 255),
            ask: Color(red: 0x3B / 255, green: 0x82 / 255, blue: 0xC4 / 255),
            plan: Color(red: 0xD9 / 255, green: 0x97 / 255, blue: 0x3A / 255)
        )
    }
}

private struct HubPaletteKey: EnvironmentKey {
    static let defaultValue = Hub.palette(dark: true)
}

extension EnvironmentValues {
    var hub: Hub.Palette {
        get { self[HubPaletteKey.self] }
        set { self[HubPaletteKey.self] = newValue }
    }
}

func statusColor(_ status: String, hub: Hub.Palette) -> Color {
    switch status {
    case "completed": return Hub.done
    case "running", "dispatched", "binding", "queued", "created": return Hub.live
    case "error", "aborted", "unknown": return hub.destructive
    case "cancelled": return hub.mutedForeground
    default: return hub.plan
    }
}

struct FleetCluster: Identifiable {
    var label: String
    var chatgpt: Bool
    var boxed: Bool
    var slots: [WorkspaceDTO]
    var id: String { label }
}

func fleetClusters(_ slots: [WorkspaceDTO]) -> [FleetCluster] {
    let cursor = slots.filter { !$0.workspaceRoot.hasPrefix("chatgpt:") }
    let gpt = slots.filter { $0.workspaceRoot.hasPrefix("chatgpt:") }
    let boxed = !gpt.isEmpty
    var out: [FleetCluster] = []
    if !cursor.isEmpty { out.append(FleetCluster(label: "Cursor", chatgpt: false, boxed: boxed, slots: cursor)) }
    if !gpt.isEmpty { out.append(FleetCluster(label: "ChatGPT", chatgpt: true, boxed: boxed, slots: gpt)) }
    return out
}

func fleetSlotTitle(_ slot: WorkspaceDTO) -> String {
    let label = slot.label.trimmingCharacters(in: .whitespacesAndNewlines)
    if !label.isEmpty { return label }
    return slot.workspaceRoot.split { $0 == "/" || $0 == "\\" }.map(String.init).last ?? slot.workspaceRoot
}

func hubEdge(_ color: Color?, hub: Hub.Palette) -> Color {
    if color == .red { return hub.destructive }
    if color == .green { return Hub.done }
    return .clear
}

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

/// CDP Ask 的 label 是 A/B/C；正文在 text。去掉「A：」前缀，避免「A A：…」。
func askOptionBody(label: String, text: String) -> String {
    let L = label.trimmingCharacters(in: .whitespacesAndNewlines)
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty || t == L { return "" }
    if L.isEmpty { return t }
    let escaped = NSRegularExpression.escapedPattern(for: L)
    guard let regex = try? NSRegularExpression(pattern: "^\(escaped)(?:\\s*[：:]\\s*|\\s+)") else { return t }
    let range = NSRange(t.startIndex..., in: t)
    return regex.stringByReplacingMatches(in: t, options: [], range: range, withTemplate: "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

func visibleAskOptions(_ options: [PendingAskOption]) -> [PendingAskOption] {
    if options.contains(where: { $0.freeform == true }) { return options }
    let used = Set(options.map { $0.label.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }.filter { !$0.isEmpty })
    var letter = "D"
    for scalar in 65...90 {
        let c = String(UnicodeScalar(scalar)!)
        if !used.contains(c) { letter = c; break }
    }
    return options + [PendingAskOption(id: "__freeform__", label: letter, text: "Other...", freeform: true)]
}

func isFreeformAskOption(_ options: [PendingAskOption], picked: String?) -> Bool {
    guard let picked, !picked.isEmpty else { return false }
    return options.first(where: { $0.id == picked })?.freeform == true || picked == "__freeform__"
}

func appendSnippetBody(_ current: String, _ body: String) -> String {
    var end = body.endIndex
    while end > body.startIndex {
        let previous = body.index(before: end)
        guard body[previous].isWhitespace else { break }
        end = previous
    }
    let trimmedEnd = String(body[..<end])
    if current.isEmpty { return trimmedEnd }
    return current.hasSuffix("\n") ? current + trimmedEnd : current + "\n" + trimmedEnd
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

func boardCardElapsed(updatedAt: Int?, now: Date = Date()) -> String? {
    guard let updatedAt, updatedAt > 0 else { return nil }
    let secs = max(0, Int((now.timeIntervalSince1970 * 1000 - Double(updatedAt)) / 1000))
    if secs < 60 { return "\(secs)s" }
    if secs < 3600 { return "\(secs / 60)m" }
    if secs < 86_400 { return "\(secs / 3600)h" }
    return "\(secs / 86_400)d"
}

let detailPromptMaxHeight: CGFloat = 180

func detailPromptShownHeight(_ contentHeight: CGFloat, cap: CGFloat = detailPromptMaxHeight) -> CGFloat {
    min(max(contentHeight, 24), cap)
}

/// 页内主操作。导航栏必须用系统 `Button`，塞进 `ToolbarItem` 会被 iOS 26 玻璃胶囊裁成「源发 / 查看已藏」。
struct VolumeButton: View {
    enum Kind { case accent, quiet, danger, plan }
    let title: String
    var kind: Kind = .accent
    var compact: Bool = false
    var expand: Bool = true
    var enabled: Bool = true
    var busy: Bool = false
    let action: () -> Void
    @Environment(\.hub) private var hub

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if busy { ProgressView().controlSize(.small).tint(fg) }
                Text(title)
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(1)
            }
            .frame(maxWidth: expand ? .infinity : nil, minHeight: compact ? 32 : 36)
            .padding(.horizontal, compact ? 12 : 14)
            .foregroundStyle(fg)
            .background(bg, in: RoundedRectangle(cornerRadius: Hub.radius, style: .continuous))
            .overlay {
                if kind == .quiet {
                    RoundedRectangle(cornerRadius: Hub.radius, style: .continuous)
                        .strokeBorder(hub.border, lineWidth: 1)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(!enabled || busy)
        .opacity(enabled ? 1 : 0.4)
    }

    private var fg: Color {
        switch kind {
        case .accent: return hub.onPrimary
        case .quiet: return hub.foreground
        case .danger: return .white
        case .plan: return Color(red: 0x1A / 255, green: 0x1A / 255, blue: 0x1A / 255)
        }
    }

    private var bg: Color {
        switch kind {
        case .accent: return hub.primary
        case .quiet: return hub.muted
        case .danger: return hub.destructive
        case .plan: return hub.plan
        }
    }
}

/// 详情页次要动作：复制 / 未读 / 隐藏。横排图标+文案，避免三个全宽描边按钮叠成表单。
struct DetailActionBar: View {
    @Environment(\.hub) private var hub
    struct Item: Identifiable {
        let id: String
        let title: String
        let systemImage: String
        let action: () -> Void
    }

    let items: [Item]

    var body: some View {
        if !items.isEmpty {
            HStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    if index > 0 {
                        Divider()
                            .frame(height: 28)
                            .opacity(0.5)
                    }
                    Button(action: item.action) {
                        VStack(spacing: 5) {
                            Image(systemName: item.systemImage)
                                .font(.body.weight(.semibold))
                                .symbolRenderingMode(.hierarchical)
                                .frame(height: 22)
                            Text(item.title)
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                        }
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .foregroundStyle(hub.foreground)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(item.title)
                }
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 4)
            .background(hub.muted, in: RoundedRectangle(cornerRadius: Hub.radius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Hub.radius, style: .continuous)
                    .strokeBorder(hub.border, lineWidth: 1)
            }
        }
    }
}

struct RunRow: View {
    let run: RunDTO
    let unread: Bool
    var now: Date = Date()
    @Environment(\.hub) private var hub
    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Rectangle()
                .fill(hubEdge(runRowChrome(run, unread: unread), hub: hub))
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 8) {
                Text(run.displayTitle)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(hub.foreground)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                HStack(spacing: 6) {
                    if unread {
                        Circle()
                            .fill(run.status == "completed" && run.pendingAsk == nil ? Hub.done : hub.destructive)
                            .frame(width: 6, height: 6)
                    }
                    Text(caption)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(badgeForeground)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(badgeForeground.opacity(0.14), in: Capsule())
                    Spacer(minLength: 8)
                    if let elapsed = boardCardElapsed(updatedAt: run.updatedAt, now: now) {
                        Text(elapsed)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(hub.mutedForeground)
                            .monospacedDigit()
                    }
                }
            }
            .padding(.leading, 12)
            .padding(.vertical, 2)
        }
    }

    private var caption: String {
        if run.pendingAsk != nil && run.status == "running" { return "待处理" }
        if !run.queuedOutbound.isEmpty { return "队列 \(run.queuedOutbound.count)" }
        return statusLabel(run.status)
    }

    private var badgeForeground: Color {
        if run.pendingAsk != nil { return hub.destructive }
        if unread && run.status == "completed" { return Hub.done }
        if unread && ["error", "aborted", "unknown"].contains(run.status) { return hub.destructive }
        return statusColor(run.status, hub: hub)
    }
}

struct BindView: View {
    @EnvironmentObject var session: Session
    @Environment(\.hub) private var hub
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
            .navigationBarTitleDisplayMode(.inline)
            .scrollContentBackground(.hidden)
            .background(hub.background)
            .toolbarBackground(hub.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
    }
}

enum FleetSlotPlace {
    case only, first, middle, last
}

func fleetSlotPlace(_ index: Int, count: Int) -> FleetSlotPlace {
    if count <= 1 { return .only }
    if index == 0 { return .first }
    if index == count - 1 { return .last }
    return .middle
}

struct FleetLine: Identifiable {
    enum Kind {
        case header(String, Bool)
        case slot(WorkspaceDTO, Bool, FleetSlotPlace)
    }

    let id: String
    let kind: Kind
}

func fleetLines(_ slots: [WorkspaceDTO]) -> [FleetLine] {
    var lines: [FleetLine] = []
    for cluster in fleetClusters(slots) {
        if cluster.boxed {
            lines.append(FleetLine(id: "header-\(cluster.label)", kind: .header(cluster.label, cluster.chatgpt)))
        }
        for (index, slot) in cluster.slots.enumerated() {
            lines.append(FleetLine(
                id: slot.id,
                kind: .slot(slot, cluster.boxed, fleetSlotPlace(index, count: cluster.slots.count))
            ))
        }
    }
    return lines
}

struct FleetClusterHeader: View {
    @Environment(\.hub) private var hub
    @Environment(\.colorScheme) private var colorScheme
    let title: String
    let chatgpt: Bool

    var body: some View {
        Text(title)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(chatgpt ? hub.background : hub.foreground)
            .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
            .padding(.horizontal, 16)
            .background(chatgpt ? hub.foreground : (colorScheme == .dark ? hub.muted : hub.border))
            .clipShape(UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 0, bottomTrailingRadius: 0, topTrailingRadius: 14, style: .continuous))
    }
}

struct FleetSlotRow: View {
    @EnvironmentObject var session: Session
    @Environment(\.hub) private var hub
    @Environment(\.colorScheme) private var colorScheme
    let slot: WorkspaceDTO
    var boxed: Bool
    var place: FleetSlotPlace

    var body: some View {
        Group {
            if slot.workspaceRoot == "chatgpt:monitor" {
                Text("需要用监控启动")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(hub.plan)
                    .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                    .padding(.horizontal, 16)
            } else {
                NavigationLink(value: AppRoute.workspace(slot)) {
                    HStack(spacing: 12) {
                        Text(fleetSlotTitle(slot))
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(hub.foreground)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        if session.hasLive(slot) {
                            ProgressView().controlSize(.small)
                        }
                        if session.unreadCount(in: slot) > 0 {
                            Circle()
                                .fill(hub.destructive)
                                .frame(width: 8, height: 8)
                                .accessibilityLabel("未读")
                        }
                    }
                    .padding(.horizontal, 16)
                    .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .navigationLinkIndicatorVisibility(.hidden)
            }
        }
        .background(rowFill)
        .clipShape(rowShape)
        .overlay(alignment: .bottom) {
            if boxed && place != .last && place != .only {
                Rectangle().fill(hub.border).frame(height: 1)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if slot.workspaceRoot != "chatgpt:monitor", session.unreadCount(in: slot) > 0 {
                Button("全部已读") {
                    session.markAllRead(.workspace(machineId: slot.machineId, workspaceRoot: slot.workspaceRoot))
                }
                .tint(hub.primary)
            }
        }
    }

    private var rowFill: Color {
        guard boxed else { return .clear }
        return colorScheme == .dark ? hub.card : hub.muted
    }

    private var rowShape: UnevenRoundedRectangle {
        let bottom: CGFloat = (place == .last || place == .only) && boxed ? 14 : (boxed ? 0 : 14)
        let top: CGFloat = boxed ? 0 : 14
        return UnevenRoundedRectangle(topLeadingRadius: top, bottomLeadingRadius: bottom, bottomTrailingRadius: bottom, topTrailingRadius: top, style: .continuous)
    }
}

struct FleetReloadBanner: View {
    @EnvironmentObject var session: Session
    @Environment(\.hub) private var hub
    let machineId: String

    var body: some View {
        let pending = session.machineReloadPending(machineId)
        Group {
            if let pending {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small).tint(Hub.live)
                    Text(pending == "skip" ? "正在跳过…" : pending == "now" ? "正在 Reload…" : "空闲后 Reload…")
                        .font(.system(size: 12))
                        .foregroundStyle(Hub.live)
                    Spacer(minLength: 8)
                    if pending != "skip" {
                        Button("取消") {
                            Task { await session.setCursorReload(action: "skip", machineId: machineId) }
                        }
                        .font(.system(size: 12, weight: .medium))
                        .buttonStyle(.borderless)
                        .disabled(session.reloadBusy[machineId] != nil)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(Hub.live.opacity(0.10), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(Hub.live.opacity(0.25), lineWidth: 1)
                }
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text("扩展待 Reload")
                        .font(.system(size: 12))
                        .foregroundStyle(hub.plan)
                    HStack(spacing: 4) {
                        reloadButton("立即", action: "now", label: "现在 Reload", fill: true)
                        reloadButton("空闲后", action: "when-idle", label: "空闲后自动", fill: false)
                        reloadButton("跳过", action: "skip", label: "这次跳过", fill: false)
                    }
                }
                .padding(8)
                .background(hub.plan.opacity(0.10), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(hub.plan.opacity(0.25), lineWidth: 1)
                }
            }
        }
    }

    private func reloadButton(_ title: String, action: String, label: String, fill: Bool) -> some View {
        Button(title) {
            Task { await session.setCursorReload(action: action, machineId: machineId) }
        }
        .accessibilityLabel(label)
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(fill ? hub.onPrimary : hub.foreground)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background {
            if fill {
                RoundedRectangle(cornerRadius: 8, style: .continuous).fill(hub.primary)
            } else if action == "when-idle" {
                RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(hub.border, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
    }
}

struct FleetLineRow: View {
    let line: FleetLine

    var body: some View {
        lineBody
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(insets)
    }

    @ViewBuilder
    private var lineBody: some View {
        switch line.kind {
        case .header(let title, let chatgpt):
            FleetClusterHeader(title: title, chatgpt: chatgpt)
        case .slot(let slot, let boxed, let place):
            FleetSlotRow(slot: slot, boxed: boxed, place: place)
        }
    }

    private var insets: EdgeInsets {
        switch line.kind {
        case .header:
            return EdgeInsets(top: 12, leading: 16, bottom: 0, trailing: 16)
        case .slot(_, let boxed, let place):
            let bottom: CGFloat = boxed && (place == .last || place == .only) ? 4 : (boxed ? 0 : 4)
            return EdgeInsets(top: boxed ? 0 : 4, leading: 16, bottom: bottom, trailing: 16)
        }
    }
}

struct FleetMachineSection: View {
    @EnvironmentObject var session: Session
    @Environment(\.hub) private var hub
    let id: String
    let name: String
    let slots: [WorkspaceDTO]

    var body: some View {
        let online = slots.contains(where: \.online)
        Section {
            ForEach(fleetLines(slots)) { line in
                FleetLineRow(line: line)
            }
            if session.machineNeedsReload(id), online {
                FleetReloadBanner(machineId: id)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
            }
        } header: {
            machineHeader(online: online)
        }
    }

    private func machineHeader(online: Bool) -> some View {
        let unread = session.unreadCount(machineId: id)
        return HStack(spacing: 8) {
            Circle()
                .fill(online ? Hub.done : hub.mutedForeground)
                .frame(width: 8, height: 8)
            Text(name)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(hub.foreground)
            Spacer(minLength: 8)
            if unread > 0 {
                Button("全部已读") {
                    session.markAllRead(.machine(id))
                }
                .font(.system(size: 15, weight: .semibold))
                .padding(.vertical, 8)
                .padding(.horizontal, 4)
                .contentShape(Rectangle())
                .buttonStyle(.borderless)
            }
        }
        .textCase(nil)
    }
}

struct WorkspaceListView: View {
    @EnvironmentObject var session: Session
    @Environment(\.hub) private var hub
    @State private var path = NavigationPath()
    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let notice = session.cursorReload?.notice, !notice.isEmpty {
                    Text(notice).foregroundStyle(.orange)
                }
                if session.hubOffline {
                    Text("中台离线或没有打开的仓").foregroundStyle(.secondary)
                }
                ForEach(session.machineGroups, id: \.id) { group in
                    FleetMachineSection(id: group.id, name: group.name, slots: group.slots)
                }
            }
            .navigationTitle("舰队")
            .navigationBarTitleDisplayMode(.inline)
            .listStyle(.plain)
            .listRowSpacing(0)
            .scrollContentBackground(.hidden)
            .background(hub.background)
            .toolbarBackground(hub.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .navigationDestination(for: AppRoute.self) { route in
                switch route {
                case .workspace(let w):
                    WorkspaceHome(workspace: w)
                case .run(let id):
                    RunDetailView(runId: id).id(id)
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
                    .dynamicTypeSize(.xSmall ... .xxLarge)
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button("解绑") { session.unbind() }
                        .dynamicTypeSize(.xSmall ... .xxLarge)
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
    @Environment(\.hub) private var hub
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

    private var openRuns: [RunDTO] {
        session.runs(in: live, archived: false)
    }

    private var hiddenN: Int {
        session.runs(in: live, archived: true).count
    }

    var filtered: [RunDTO] {
        if showArchived { return boardRuns }
        return boardRuns.filter { $0.column == tab }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(BoardColumn.allCases) { col in
                        let n = openRuns.filter { $0.column == col }.count
                        let selected = !showArchived && tab == col
                        Button {
                            showArchived = false
                            tab = col
                        } label: {
                            HStack(spacing: 4) {
                                Text(col.title)
                                if n > 0 { Text("\(n)").font(.system(size: 12)) }
                                if columnHasAlert(openRuns, column: col, isUnread: session.isUnread) {
                                    Circle().fill(hub.destructive).frame(width: 7, height: 7)
                                }
                            }
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(selected ? hub.onPrimary : hub.mutedForeground)
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(selected ? hub.primary : hub.muted)
                            .clipShape(RoundedRectangle(cornerRadius: Hub.radius, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }
                    Button {
                        showArchived = true
                    } label: {
                        HStack(spacing: 4) {
                            Text("已隐藏")
                            if hiddenN > 0 { Text("\(hiddenN)").font(.system(size: 12)) }
                        }
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(showArchived ? hub.onPrimary : hub.mutedForeground)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(showArchived ? hub.primary : hub.muted)
                        .clipShape(RoundedRectangle(cornerRadius: Hub.radius, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
            List {
                if let err = session.lastError {
                    Text(err).foregroundStyle(.red).font(.caption)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                if showArchived {
                    Text("已隐藏的任务仍保留，可取消隐藏。").font(.caption).foregroundStyle(.secondary)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                if filtered.isEmpty {
                    Text(showArchived ? "还没有已隐藏的任务" : "这一列还没有任务").foregroundStyle(.secondary)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                ForEach(filtered, id: \.runId) { run in
                    NavigationLink(value: AppRoute.run(run.runId)) {
                        RunRow(run: run, unread: session.isUnread(run))
                            .padding(.vertical, 10)
                            .padding(.trailing, 12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(hub.card)
                            .clipShape(RoundedRectangle(cornerRadius: Hub.radius, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: Hub.radius, style: .continuous)
                                    .strokeBorder(hub.border, lineWidth: 1)
                            }
                    }
                    .navigationLinkIndicatorVisibility(.hidden)
                    .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
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
                        if session.canMarkUnread(run) {
                            Button("标为未读") {
                                session.markUnread(run.runId, hold: false)
                            }
                            .tint(hub.plan)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(hub.background)
        }
        .navigationTitle(live.label)
        .toolbarBackground(hub.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .safeAreaInset(edge: .top) {
            if !live.canInject {
                Text(RelayAPIError.operatorMessage("CDP_NOT_READY"))
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(hub.destructive.opacity(0.10))
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("派发") { showDispatch = true }
                    .dynamicTypeSize(.xSmall ... .xxLarge)
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

/// Form/List 按内容理想宽度布局横向 ScrollView，多出来的胶囊被裁掉且滑不到。
/// 按行宽换行，和中台 flex-wrap 一样把每条都留在屏内。
struct ChipFlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(proposal: proposal, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let frames = arrange(proposal: ProposedViewSize(width: bounds.width, height: bounds.height), subviews: subviews).frames
        for (index, frame) in frames.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                anchor: .topLeading,
                proposal: ProposedViewSize(width: frame.width, height: frame.height)
            )
        }
    }

    private func arrange(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, frames: [CGRect]) {
        let maxWidth = proposal.width ?? .infinity
        var frames: [CGRect] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var usedWidth: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
            usedWidth = max(usedWidth, x - spacing)
        }
        let width = proposal.width ?? usedWidth
        return (CGSize(width: width, height: y + rowHeight), frames)
    }
}

struct PromptSnippetChips: View {
    let snippets: [PromptSnippet]
    let onAppend: (String) -> Void
    @Environment(\.hub) private var hub

    var body: some View {
        Group {
            if !snippets.isEmpty {
                ChipFlowLayout(spacing: 6) {
                    ForEach(snippets) { snippet in
                        Button(snippet.title) { onAppend(snippet.body) }
                            .buttonStyle(.plain)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(hub.foreground)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(hub.muted, in: Capsule())
                            .overlay(Capsule().strokeBorder(hub.border, lineWidth: 1))
                            .fixedSize()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

struct DraftImage: Identifiable {
    let id = UUID()
    var data: Data
    var mime: String
    var name: String
}

func imageMagicMime(_ data: Data) -> String? {
    if data.count >= 4, data[0] == 0x89, data[1] == 0x50, data[2] == 0x4E, data[3] == 0x47 { return "image/png" }
    if data.count >= 3, data[0] == 0xFF, data[1] == 0xD8, data[2] == 0xFF { return "image/jpeg" }
    return nil
}

func prepareUploadImage(_ data: Data, name: String) -> DraftImage? {
    if let mime = imageMagicMime(data) {
        if data.count > 8 * 1024 * 1024 { return nil }
        return DraftImage(data: data, mime: mime, name: nameFor(name, mime: mime))
    }
    guard let img = UIImage(data: data), let jpeg = img.jpegData(compressionQuality: 0.92) else { return nil }
    if jpeg.count > 8 * 1024 * 1024 { return nil }
    return DraftImage(data: jpeg, mime: "image/jpeg", name: nameFor(name, mime: "image/jpeg"))
}

private func nameFor(_ raw: String, mime: String) -> String {
    let base = (raw as NSString).lastPathComponent
    let stem = (base as NSString).deletingPathExtension
    let safe = stem.isEmpty ? "image" : stem
    return mime == "image/png" ? "\(safe).png" : "\(safe).jpg"
}

/// 豆包 / GPT 底栏：胶囊输入 + 32pt 圆发送。语音是现网能力，收成图标，不抽独立通栏大钮。
struct ComposerBar: View {
    @Environment(\.hub) private var hub
    @Binding var text: String
    @Binding var pickerItems: [PhotosPickerItem]
    var sending: Bool
    var listening: Bool
    var canSend: Bool
    var photoVisible: Bool = false
    var photoEnabled: Bool = true
    var maxPick: Int = 4
    var onMic: () -> Void
    var onPhotoDisabled: () -> Void
    var onSend: () -> Void
    var onPasteImage: ((Data) -> Void)? = nil

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Button(action: onMic) {
                Image(systemName: listening ? "stop.fill" : "mic")
                    .font(.subheadline.weight(.semibold))
                    .frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
            .disabled(sending)
            if photoVisible {
                if photoEnabled {
                    PhotosPicker(selection: $pickerItems, maxSelectionCount: max(0, maxPick), matching: .images) {
                        Image(systemName: "photo")
                            .font(.subheadline.weight(.semibold))
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.plain)
                    .disabled(sending)
                } else {
                    Button(action: onPhotoDisabled) {
                        Image(systemName: "photo")
                            .font(.subheadline.weight(.semibold))
                            .frame(width: 32, height: 32)
                            .opacity(0.4)
                    }
                    .buttonStyle(.plain)
                }
            }
            ComposerField(text: $text, placeholder: "输入提示词", enabled: !listening && !sending, onPasteImage: onPasteImage)
                .padding(.horizontal, 8)
                .frame(minHeight: 36, maxHeight: 132)
                .fixedSize(horizontal: false, vertical: true)
                .background(hub.muted, in: RoundedRectangle(cornerRadius: Hub.radius, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: Hub.radius, style: .continuous)
                        .strokeBorder(hub.border, lineWidth: 1)
                }
            Button(action: onSend) {
                Image(systemName: sending ? "hourglass" : "arrow.up")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(canSend ? hub.onPrimary : .white)
                    .frame(width: 32, height: 32)
                    .background(canSend ? hub.primary : Color.secondary.opacity(0.35), in: RoundedRectangle(cornerRadius: Hub.radius, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel(sending ? "发送中" : "发送")
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 8)
    }
}

struct DispatchSheet: View {
    @EnvironmentObject var session: Session
    let workspace: WorkspaceDTO
    var followupRunId: String? = nil
    var followupIsLive: Bool = false
    var onDone: (BoardColumn) -> Void
    @StateObject private var speech = PromptSpeech()
    @State private var prompt = ""
    @State private var sending = false
    @State private var err: String?
    @State private var drafts: [DraftImage] = []
    @State private var blobsAvailable = true
    @State private var pickerItems: [PhotosPickerItem] = []
    @Environment(\.dismiss) private var dismiss

    private var live: WorkspaceDTO {
        liveWorkspace(id: workspace.workspaceId, slots: session.workspaces, fallback: workspace)
    }

    private var trimmed: String {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var chatgptTextOnly: Bool { live.workspaceRoot.hasPrefix("chatgpt:") }
    private var photoEnabled: Bool { !followupIsLive && !chatgptTextOnly }
    private var canSend: Bool {
        live.canInject && !sending && !speech.listening && (!trimmed.isEmpty || (photoEnabled && !drafts.isEmpty))
    }

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
                    PromptSnippetChips(
                        snippets: session.snippets,
                        onAppend: { body in
                            prompt = appendSnippetBody(prompt, body)
                        }
                    )
                    if speech.listening {
                        Text("正在听…说完点停止，改完再派发")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Prompt")
                } footer: {
                    Text("语音只写入提示词，不会自动发送。")
                }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 8) {
                    if !drafts.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(drafts) { draft in
                                    ZStack(alignment: .topTrailing) {
                                        if let ui = UIImage(data: draft.data) {
                                            Image(uiImage: ui)
                                                .resizable()
                                                .scaledToFill()
                                                .frame(width: 56, height: 56)
                                                .clipped()
                                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                        }
                                        Button {
                                            drafts.removeAll { $0.id == draft.id }
                                        } label: {
                                            Image(systemName: "xmark.circle.fill")
                                                .foregroundStyle(.white, .black.opacity(0.45))
                                        }
                                        .offset(x: 4, y: -4)
                                    }
                                }
                            }
                            .padding(.horizontal, 16)
                        }
                    }
                    ComposerBar(
                        text: $prompt,
                        pickerItems: $pickerItems,
                        sending: sending,
                        listening: speech.listening,
                        canSend: canSend,
                        photoVisible: blobsAvailable,
                        photoEnabled: photoEnabled && !sending && drafts.count < 4,
                        maxPick: max(1, 4 - drafts.count),
                        onMic: { toggleMic() },
                        onPhotoDisabled: {
                            if chatgptTextOnly {
                                err = RelayAPIError.operatorMessage("CHATGPT_TEXT_ONLY")
                            } else {
                                err = RelayAPIError.operatorMessage(followupIsLive ? "OUTBOUND_TEXT_ONLY" : "ATTACHMENT_COUNT")
                            }
                        },
                        onSend: { Task { await send() } },
                        onPasteImage: { data in addDraft(data, name: "paste") }
                    )
                    .background(.bar)
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
            .onChange(of: speech.prompt) { _, next in
                if speech.listening { prompt = next }
            }
            .onChange(of: speech.listening) { _, listening in
                if !listening { prompt = speech.prompt }
            }
            .onChange(of: pickerItems) { _, items in
                Task { await ingestPicker(items) }
            }
            .task { await session.loadSnippets() }
        }
    }

    private func addDraft(_ data: Data, name: String) {
        if chatgptTextOnly {
            err = RelayAPIError.operatorMessage("CHATGPT_TEXT_ONLY")
            return
        }
        if drafts.count >= 4 {
            err = RelayAPIError.operatorMessage("ATTACHMENT_COUNT")
            return
        }
        guard let draft = prepareUploadImage(data, name: name) else {
            err = imageMagicMime(data) == nil ? "无法转换这张图" : RelayAPIError.operatorMessage("ATTACHMENT_TOO_LARGE")
            return
        }
        drafts.append(draft)
    }

    private func ingestPicker(_ items: [PhotosPickerItem]) async {
        pickerItems = []
        for item in items {
            if drafts.count >= 4 {
                err = RelayAPIError.operatorMessage("ATTACHMENT_COUNT")
                break
            }
            guard let data = try? await item.loadTransferable(type: Data.self) else {
                err = "无法转换这张图"
                continue
            }
            addDraft(data, name: "image")
        }
    }

    private func toggleMic() {
        if speech.listening {
            speech.stop()
            prompt = speech.prompt
        } else {
            speech.prompt = prompt
            speech.toggle()
        }
    }

    private func send() async {
        if speech.listening {
            speech.stop()
            prompt = speech.prompt
            return
        }
        let text = trimmed
        guard canSend else { return }
        sending = true
        defer { sending = false }
        do {
            var ids: [String] = []
            if photoEnabled {
                for draft in drafts {
                    ids.append(try await session.api().uploadBlob(data: draft.data, mime: draft.mime, name: draft.name).id)
                }
            }
            let run: RunDTO
            if let followupRunId {
                run = try await session.api().followup(runId: followupRunId, prompt: text, attachmentIds: ids)
            } else {
                run = try await session.api().dispatch(workspaceId: live.workspaceId, prompt: text, attachmentIds: ids)
            }
            err = nil
            await session.refresh()
            onDone(run.column)
            dismiss()
        } catch {
            if let e = error as? RelayAPIError, case .http(404, _) = e {
                blobsAvailable = false
                drafts = []
            }
            err = error.localizedDescription
        }
    }
}

struct DetailPromptCard: View {
    let text: String
    @Binding var contentHeight: CGFloat
    @State private var expanded = false
    @Environment(\.hub) private var hub

    private var overflows: Bool { contentHeight > detailPromptMaxHeight }
    private var shownHeight: CGFloat {
        expanded ? max(contentHeight, 24) : detailPromptShownHeight(contentHeight)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 6) {
                if overflows {
                    VolumeButton(title: expanded ? "收起" : "展开", kind: .quiet, compact: true, expand: false) {
                        withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
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
                                    hub.muted.opacity(0.0),
                                    hub.muted,
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                            .frame(height: 28)
                            .allowsHitTesting(false)
                        }
                    }
            }
            .padding(12)
            .background(hub.muted, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .containerRelativeFrame(.horizontal) { width, _ in width * 0.78 }
        }
        .onChange(of: text) { _, _ in expanded = false }
    }
}

struct DetailReplyBlock: View {
    let text: String?
    let isLive: Bool
    @Binding var height: CGFloat
    var onWorkspaceFile: ((String) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let text, !text.isEmpty {
                MarkdownWebView(text: text, height: $height, onWorkspaceFile: onWorkspaceFile)
                    .frame(height: max(height, 80))
            } else if isLive {
                Text("还没有终态正文").font(.subheadline).foregroundStyle(.secondary)
            } else {
                Text("没有正文").font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(.top, 4)
    }
}

struct RunDetailView: View {
    @EnvironmentObject var session: Session
    @Environment(\.hub) private var hub
    let runId: String
    @State private var run: RunDTO?
    @State private var err: String?
    @State private var mdHeight: CGFloat = 120
    @State private var promptHeight: CGFloat = 40
    @State private var showDispatch = false
    @State private var copied = false
    @State private var filePath: String?
    @State private var showChat = false
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
                    if let err { Text(err).foregroundStyle(hub.destructive) }
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(run.displayTitle)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(hub.foreground)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(statusLabel(run.status))
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(run.isLive ? Hub.live : hub.mutedForeground)
                    }
                    Text("\(run.workspace(from: session.workspaces).machineName) · \(run.workspace(from: session.workspaces).label)")
                        .font(.system(size: 12))
                        .foregroundStyle(hub.mutedForeground)
                        .lineLimit(1)
                    if let e = run.displayError { Text(RelayAPIError.operatorMessage(e)).foregroundStyle(hub.destructive) }
                    if slot?.canInject == false, run.displayError != "CDP_NOT_READY" {
                        Text(RelayAPIError.operatorMessage("CDP_NOT_READY")).foregroundStyle(hub.destructive)
                    }
                    DetailPromptCard(text: run.prompt, contentHeight: $promptHeight)
                    DetailReplyBlock(text: run.finalText, isLive: run.isLive, height: $mdHeight, onWorkspaceFile: { filePath = $0 })
                    Button("查看对话记录") { showChat = true }
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(hub.mutedForeground)
                        .buttonStyle(.plain)
                    if let ask = run.pendingAsk {
                        AskView(runId: runId, ask: ask) { await reload() }
                    }
                    if !run.queuedOutbound.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("\(run.queuedOutbound.count) 条还在排队")
                                .font(.system(size: 12))
                                .foregroundStyle(hub.mutedForeground)
                            ForEach(run.queuedOutbound) { q in
                                Text(q.prompt)
                                    .font(.system(size: 13))
                                    .foregroundStyle(hub.foreground)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(hub.card, in: RoundedRectangle(cornerRadius: Hub.radius, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: Hub.radius, style: .continuous)
                                .strokeBorder(hub.border, lineWidth: 1)
                        }
                    }
                    if run.isLive || run.showsRetry {
                        HStack(spacing: 8) {
                            if run.isLive {
                                VolumeButton(title: "取消任务", kind: .danger, compact: true, expand: false) {
                                    Task {
                                        try? await session.api().cancel(runId: runId)
                                        await reload()
                                        await session.refresh()
                                    }
                                }
                            }
                            if run.showsRetry {
                                VolumeButton(title: "重试", compact: true, expand: false, enabled: slot?.canInject ?? false) {
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
                            Spacer(minLength: 0)
                        }
                    }
                } else if let err {
                    Text(err).foregroundStyle(hub.destructive)
                } else {
                    ProgressView()
                }
            }
            .padding()
        }
        .safeAreaInset(edge: .bottom) {
            if let run {
                DetailActionBar(items: housekeepingItems(run))
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
                    .padding(.bottom, 6)
                    .frame(maxWidth: .infinity)
                    .background(hub.card)
                    .overlay(alignment: .top) {
                        Rectangle().fill(hub.border).frame(height: 1)
                    }
            }
        }
        .background(hub.background)
        .navigationTitle("详情")
        .toolbarBackground(hub.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("续聊") { showDispatch = true }
                    .disabled(!((slot?.canInject ?? false) && (run?.canFollowup ?? false)))
                    .dynamicTypeSize(.xSmall ... .xxLarge)
            }
        }
        .sheet(isPresented: $showDispatch) {
            if let slot {
                DispatchSheet(workspace: slot, followupRunId: runId, followupIsLive: run?.isLive == true) { _ in
                    showDispatch = false
                    Task {
                        await reload()
                        await session.refresh()
                    }
                }
            }
        }
        .sheet(isPresented: $showChat) {
            NavigationStack {
                ChatHistoryView(runId: runId)
            }
        }
        .task(id: runId) {
            copied = false
            mdHeight = 120
            promptHeight = 40
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
        .navigationDestination(isPresented: Binding(
            get: { filePath != nil },
            set: { if !$0 { filePath = nil } }
        )) {
            if let filePath {
                WorkspaceFileView(runId: runId, path: filePath)
            }
        }
    }

    private func housekeepingItems(_ run: RunDTO) -> [DetailActionBar.Item] {
        var items = [
            DetailActionBar.Item(
                id: "copy",
                title: copied ? "已复制" : "复制正文",
                systemImage: copied ? "checkmark" : "doc.on.doc",
                action: { copyBody(run) }
            )
        ]
        if session.canMarkUnread(run) {
            items.append(DetailActionBar.Item(
                id: "unread",
                title: "标为未读",
                systemImage: "envelope.badge",
                action: { session.markUnread(runId, hold: true) }
            ))
        }
        if run.isArchived {
            items.append(DetailActionBar.Item(
                id: "unhide",
                title: "取消隐藏",
                systemImage: "eye",
                action: { unhide(run) }
            ))
        } else if run.showsArchive {
            items.append(DetailActionBar.Item(
                id: "hide",
                title: "隐藏",
                systemImage: "eye.slash",
                action: { hide(run) }
            ))
        }
        return items
    }

    private func copyBody(_ run: RunDTO) {
        UIPasteboard.general.string = run.finalText ?? ""
        copied = true
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            copied = false
        }
    }

    private func hide(_ run: RunDTO) {
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

    private func unhide(_ run: RunDTO) {
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

struct ChatTurnBubble: View {
    let turn: ChatTurnDTO
    @Environment(\.hub) private var hub
    @State private var height: CGFloat = 20
    private var isUser: Bool { turn.role == "user" }

    var body: some View {
        MarkdownWebView(text: turn.text, height: $height)
            .frame(height: max(height, 20), alignment: .topLeading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, isUser ? 14 : 2)
            .padding(.vertical, isUser ? 8 : 0)
            .background {
                if isUser {
                    RoundedRectangle(cornerRadius: 16, style: .continuous).fill(hub.muted)
                }
            }
            .containerRelativeFrame(.horizontal, alignment: isUser ? .trailing : .leading) { width, _ in
                isUser ? width * 0.78 : width
            }
    }
}

struct ChatHistoryView: View {
    @EnvironmentObject var session: Session
    @Environment(\.hub) private var hub
    @Environment(\.dismiss) private var dismiss
    let runId: String
    @State private var turns: [ChatTurnDTO] = []
    @State private var err: String?
    @State private var loaded = false

    var body: some View {
        Group {
            if let err {
                Text(err).foregroundStyle(hub.destructive).padding()
            } else if !loaded {
                ProgressView()
            } else if turns.isEmpty {
                Text("还没有对话")
                    .font(.system(size: 13))
                    .foregroundStyle(hub.mutedForeground)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 32)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        ForEach(Array(turns.enumerated()), id: \.offset) { _, turn in
                            ChatTurnBubble(turn: turn)
                        }
                    }
                    .padding(16)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(hub.background)
        .navigationTitle("对话记录")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(hub.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("关闭") { dismiss() }
            }
        }
        .task { await reload() }
        .refreshable { await reload() }
    }

    private func reload() async {
        do {
            turns = try await session.api().chat(runId: runId)
            err = nil
            loaded = true
        } catch {
            err = error.localizedDescription
            loaded = true
        }
    }
}

struct WorkspaceFileView: View {
    @EnvironmentObject var session: Session
    let runId: String
    let path: String
    @State private var file: WorkspaceFileDTO?
    @State private var err: String?
    @State private var height: CGFloat = 120
    @State private var nestedPath: String?

    private var title: String {
        file?.name ?? path.split { $0 == "/" || $0 == "\\" }.map(String.init).last ?? path
    }

    private var markdown: Bool {
        let mime = file?.mime ?? ""
        let name = file?.name ?? path
        return mime == "text/markdown" || name.lowercased().hasSuffix(".md") || name.lowercased().hasSuffix(".markdown")
    }

    var body: some View {
        Group {
            if let err {
                Text(err).foregroundStyle(.red).padding()
            } else if let file {
                ScrollView {
                    if markdown {
                        MarkdownWebView(text: file.text, height: $height, onWorkspaceFile: { nestedPath = $0 })
                            .frame(height: max(height, 80))
                            .padding()
                    } else {
                        Text(file.text)
                            .font(.system(.footnote, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding()
                    }
                }
            } else {
                ProgressView().padding()
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: path) {
            err = nil
            file = nil
            do {
                file = try await session.api().workspaceFile(runId: runId, path: path)
            } catch {
                err = error.localizedDescription
            }
        }
        .navigationDestination(isPresented: Binding(
            get: { nestedPath != nil },
            set: { if !$0 { nestedPath = nil } }
        )) {
            if let nestedPath {
                WorkspaceFileView(runId: runId, path: nestedPath)
            }
        }
    }
}

struct AskView: View {
    let runId: String
    let ask: PendingAskDTO
    var onDone: () async -> Void
    @EnvironmentObject var session: Session
    @Environment(\.hub) private var hub
    @State private var optionId: String?
    @State private var pickedByQuestion: [String: String] = [:]
    @State private var freeformText = ""
    @State private var freeformByQuestion: [String: String] = [:]
    @State private var err: String?
    @State private var busyAction: String?
    @State private var planHeight: CGFloat = 80

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if isPlan {
                Text("计划").font(.system(size: 12, weight: .medium)).foregroundStyle(hub.mutedForeground)
                Text(ask.questions.first?.prompt ?? "")
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                if let overview = ask.questions.first?.options.first?.text,
                   !overview.isEmpty, overview != "Build" {
                    MarkdownWebView(text: overview, height: $planHeight)
                        .frame(height: max(planHeight, 80))
                }
                if let err { Text(err).foregroundStyle(.red) }
                if canContinue {
                HStack {
                    Spacer(minLength: 0)
                    VolumeButton(
                        title: busyAction == "continue" ? "Building..." : "Build",
                        kind: .plan,
                        compact: true,
                        expand: false,
                        enabled: busyAction == nil,
                        busy: busyAction == "continue"
                    ) {
                        Task { await submitBuild() }
                    }
                }
                }
            } else {
                Text("提问").font(.system(size: 12, weight: .medium)).foregroundStyle(hub.mutedForeground)
                ForEach(ask.questions) { q in
                    Text(q.prompt)
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if canContinue {
                    ForEach(visibleAskOptions(q.options)) { o in
                        Button {
                            if ask.questions.count > 1 {
                                pickedByQuestion[q.id] = o.id
                            } else {
                                optionId = o.id
                                if o.freeform != true { freeformText = "" }
                            }
                        } label: {
                            HStack(alignment: .top, spacing: 8) {
                                Text(o.label.isEmpty ? o.id.uppercased() : o.label)
                                    .font(.body.monospaced())
                                    .foregroundStyle(.secondary)
                                Text(o.freeform == true ? "Other..." : askOptionBody(label: o.label, text: o.text))
                                    .font(.body)
                                    .multilineTextAlignment(.leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(.vertical, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(busyAction != nil)
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 10)
                        .frame(minHeight: 36)
                        .background(
                            RoundedRectangle(cornerRadius: 10)
                                .fill((ask.questions.count > 1 ? pickedByQuestion[q.id] == o.id : optionId == o.id) ? hub.primary.opacity(0.10) : Color.clear)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .stroke((ask.questions.count > 1 ? pickedByQuestion[q.id] == o.id : optionId == o.id) ? hub.primary : hub.border, lineWidth: 1)
                        )
                        if (ask.questions.count > 1 ? pickedByQuestion[q.id] == o.id : optionId == o.id) && o.freeform == true {
                            TextField("Other...", text: Binding(
                                get: {
                                    ask.questions.count > 1 ? (freeformByQuestion[q.id] ?? "") : freeformText
                                },
                                set: { next in
                                    if ask.questions.count > 1 {
                                        freeformByQuestion[q.id] = next
                                    } else {
                                        freeformText = next
                                    }
                                }
                            ), axis: .vertical)
                                .lineLimit(1...6)
                                .disabled(busyAction != nil)
                        }
                    }
                    }
                }
                if !canContinue {
                    Text("多题请到 Cursor 里逐题作答。这里的选项会串在一起，不能代为选择。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let err { Text(err).foregroundStyle(.red) }
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    VolumeButton(
                        title: busyAction == "skip" ? "Skipping..." : "Skip",
                        kind: .quiet,
                        compact: true,
                        expand: false,
                        enabled: busyAction == nil,
                        busy: busyAction == "skip"
                    ) {
                        Task { await submit(action: "skip") }
                    }
                    if canContinue {
                    VolumeButton(
                        title: (busyAction == "continue" || busyAction == "freeform") ? "Continuing..." : "Continue",
                        compact: true,
                        expand: false,
                        enabled: canSubmitChoice && busyAction == nil,
                        busy: busyAction == "continue" || busyAction == "freeform"
                    ) {
                        Task { await submit(action: pickedFreeform ? "freeform" : "continue") }
                    }
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(hub.card)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(hub.border, lineWidth: 1)
        }
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(isPlan ? hub.plan : hub.ask)
                .frame(width: 3)
                .padding(.vertical, 10)
        }
    }

    private var isPlan: Bool { isPlanAsk(ask) }
    private var canContinue: Bool { continueAllowed(ask) }
    private var typed: String { freeformText.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var askRows: [PendingAskOption] { visibleAskOptions(ask.questions.first?.options ?? []) }
    private var pickedFreeform: Bool { isFreeformAskOption(askRows, picked: optionId) }
    private var canSubmitChoice: Bool {
        if ask.questions.count > 1 {
            return ask.questions.allSatisfy { q in
                guard let id = pickedByQuestion[q.id], !id.isEmpty else { return false }
                if isFreeformAskOption(visibleAskOptions(q.options), picked: id) {
                    return !(freeformByQuestion[q.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                }
                return true
            }
        }
        return pickedFreeform ? !typed.isEmpty : optionId != nil
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
            busyAction = nil
        } catch {
            err = error.localizedDescription
            busyAction = nil
        }
    }

    private func submit(action: String) async {
        guard busyAction == nil else { return }
        if action == "continue", ask.questions.count < 2, optionId == nil { return }
        if action == "freeform", typed.isEmpty { return }
        busyAction = action
        var body: [String: Any] = ["request_id": ask.request_id, "action": action]
        if action == "freeform" {
            body["text"] = typed
            body["answers"] = [] as [[String: Any]]
        } else if action == "continue", ask.questions.count > 1 {
            body["answers"] = ask.questions.map { q -> [String: Any] in
                let id = pickedByQuestion[q.id] ?? ""
                var item: [String: Any] = ["question_id": q.id, "option_ids": [id]]
                if isFreeformAskOption(visibleAskOptions(q.options), picked: id) {
                    item["text"] = (freeformByQuestion[q.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                }
                return item
            }
        } else if action == "continue", let q = ask.questions.first, let optionId {
            body["answers"] = [["question_id": q.id, "option_ids": [optionId]]]
        }
        do {
            try await session.api().answer(runId: runId, body: body)
            await onDone()
            busyAction = nil
        } catch {
            err = error.localizedDescription
            busyAction = nil
        }
    }
}

struct SnippetSettingChip: View {
    let snippet: PromptSnippet
    let onEdit: () -> Void
    let onDelete: () -> Void
    @Environment(\.hub) private var hub

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Button(snippet.title, action: onEdit)
                .buttonStyle(.plain)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(hub.foreground)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(hub.muted, in: Capsule())
                .overlay(Capsule().strokeBorder(hub.border, lineWidth: 1))
            Button(action: onDelete) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(hub.mutedForeground)
                    .frame(width: 16, height: 16)
                    .background(Circle().fill(hub.card))
                    .overlay(Circle().strokeBorder(hub.border, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("删除 \(snippet.title)")
            .offset(x: 6, y: -6)
        }
        .padding(.top, 6)
        .padding(.trailing, 6)
    }
}

struct SnippetEditSheet: View {
    let snippet: PromptSnippet
    let onSave: (PromptSnippet) async throws -> Void
    let onClose: () -> Void
    @State private var title: String
    @State private var snippetBody: String
    @State private var busy = false
    @State private var rowError: String?

    init(
        snippet: PromptSnippet,
        onSave: @escaping (PromptSnippet) async throws -> Void,
        onClose: @escaping () -> Void
    ) {
        self.snippet = snippet
        self.onSave = onSave
        self.onClose = onClose
        _title = State(initialValue: snippet.title)
        _snippetBody = State(initialValue: snippet.body)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("标题", text: $title)
                }
                Section("提示词") {
                    TextEditor(text: $snippetBody)
                        .frame(minHeight: 140)
                }
                if let rowError {
                    Section {
                        Text(rowError).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("编辑快捷提示词")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消", action: onClose).disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        Task {
                            await run {
                                try await onSave(PromptSnippet(id: snippet.id, title: title, body: snippetBody))
                                onClose()
                            }
                        }
                    }
                    .disabled(busy)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func run(_ operation: () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        rowError = nil
        defer { busy = false }
        do {
            try await operation()
        } catch {
            rowError = error.localizedDescription
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var appearance: Appearance
    @EnvironmentObject var session: Session
    @Environment(\.hub) private var hub
    @State private var editingSnippet: PromptSnippet?

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
            Section("快捷提示词") {
                if let error = session.lastError {
                    Text(error).foregroundStyle(.red).font(.caption)
                }
                if session.snippets.isEmpty {
                    Text("还没有快捷提示词，请在中台添加")
                        .foregroundStyle(.secondary)
                } else {
                    ChipFlowLayout(spacing: 6) {
                        ForEach(session.snippets) { snippet in
                            SnippetSettingChip(
                                snippet: snippet,
                                onEdit: { editingSnippet = snippet },
                                onDelete: {
                                    Task {
                                        try? await session.saveSnippets(
                                            session.snippets.filter { $0.id != snippet.id }
                                        )
                                    }
                                }
                            )
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }
            }
        }
        .navigationTitle("设置")
        .scrollContentBackground(.hidden)
        .background(hub.background)
        .toolbarBackground(hub.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .sheet(item: $editingSnippet) { snippet in
            SnippetEditSheet(
                snippet: snippet,
                onSave: { next in
                    try await session.saveSnippets(
                        session.snippets.map { $0.id == next.id ? next : $0 }
                    )
                },
                onClose: { editingSnippet = nil }
            )
        }
        .task { await session.loadSnippets() }
    }
}
