import SwiftUI
import WebKit
import UIKit

enum MarkdownHTML {
    static func from(_ source: String) -> String {
        let blocks = splitFences(source)
        let inner = blocks.map(renderBlock).joined()
        return """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
        <style>
        :root { color-scheme: light dark; }
        html, body { margin: 0; padding: 0; }
        body {
          font: 13px/1.65 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
          color: #27272a;
          word-wrap: break-word;
          overflow-wrap: anywhere;
        }
        @media (prefers-color-scheme: dark) {
          body { color: #e4e4e7; }
          h1, h2, h3 { color: #f4f4f5; }
          pre, code { background: #18181b; color: #e4e4e7; }
          code { background: #27272a; }
          th, td { border-color: #3f3f46; }
          th { color: #d4d4d8; }
          blockquote { border-color: #52525b; color: #a1a1aa; }
          a { color: #38bdf8; }
          hr { border-color: #27272a; }
        }
        h1 { font-size: 16px; font-weight: 600; margin: 12px 0 4px; }
        h2 { font-size: 15px; font-weight: 600; margin: 12px 0 4px; }
        h3 { font-size: 14px; font-weight: 500; margin: 12px 0 4px; }
        p { margin: 0 0 8px; }
        ul, ol { margin: 0 0 8px; padding-left: 20px; }
        li { margin: 2px 0; }
        strong { font-weight: 600; }
        em { font-style: italic; }
        hr { border: none; border-top: 1px solid #e4e4e7; margin: 12px 0; }
        blockquote { border-left: 2px solid #d4d4d8; padding-left: 12px; color: #71717a; margin: 0 0 8px; }
        a { color: #0284c7; text-decoration: none; }
        pre {
          margin: 0 0 8px; padding: 10px; border-radius: 6px;
          background: #f4f4f5; overflow-x: auto; font-size: 12px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        pre code { background: none; padding: 0; font-size: 12px; }
        code {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12px; background: #f4f4f5; padding: 1px 4px; border-radius: 4px;
        }
        table { border-collapse: collapse; font-size: 12px; margin: 0 0 8px; width: 100%; }
        th, td { border: 1px solid #d4d4d8; padding: 4px 8px; text-align: left; vertical-align: top; }
        th { font-weight: 600; }
        .wrap { overflow-x: auto; margin: 0 0 8px; }
        </style></head><body>\(inner)</body></html>
        """
    }

    private enum Block {
        case html(String)
        case fence(String)
    }

    private static func splitFences(_ source: String) -> [Block] {
        var out: [Block] = []
        var rest = source.replacingOccurrences(of: "\r\n", with: "\n")
        while let start = rest.range(of: "```") {
            let before = String(rest[..<start.lowerBound])
            if !before.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                out.append(contentsOf: parseFlow(before).map(Block.html))
            }
            rest = String(rest[start.upperBound...])
            let nl = rest.firstIndex(of: "\n") ?? rest.endIndex
            rest = nl == rest.endIndex ? "" : String(rest[rest.index(after: nl)...])
            if let end = rest.range(of: "```") {
                out.append(.fence(String(rest[..<end.lowerBound]).trimmingCharacters(in: .newlines)))
                rest = String(rest[end.upperBound...])
                if rest.hasPrefix("\n") { rest.removeFirst() }
            } else {
                out.append(.fence(rest))
                rest = ""
            }
        }
        if !rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            out.append(contentsOf: parseFlow(rest).map(Block.html))
        }
        return out
    }

    private static func renderBlock(_ b: Block) -> String {
        switch b {
        case .fence(let code):
            return "<pre><code>\(escape(code))</code></pre>"
        case .html(let h):
            return h
        }
    }

    private static func parseFlow(_ text: String) -> [String] {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var i = 0
        var out: [String] = []
        while i < lines.count {
            let line = lines[i]
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { i += 1; continue }
            if t.hasPrefix("|") && t.contains("|") {
                var rows: [String] = []
                while i < lines.count {
                    let r = lines[i].trimmingCharacters(in: .whitespaces)
                    if r.hasPrefix("|") { rows.append(r); i += 1 } else { break }
                }
                out.append(renderTable(rows))
                continue
            }
            if t == "---" || t == "***" || t == "___" {
                out.append("<hr>")
                i += 1
                continue
            }
            if t.hasPrefix("> ") || t == ">" {
                var buf: [String] = []
                while i < lines.count {
                    let r = lines[i].trimmingCharacters(in: .whitespaces)
                    if r.hasPrefix("> ") { buf.append(String(r.dropFirst(2))); i += 1 }
                    else if r == ">" { buf.append(""); i += 1 }
                    else { break }
                }
                out.append("<blockquote>\(inline(buf.joined(separator: " ")))</blockquote>")
                continue
            }
            if heading(t) != nil {
                let h = heading(t)!
                out.append("<h\(h.level)>\(inline(h.text))</h\(h.level)>")
                i += 1
                continue
            }
            if isUl(t) || isOl(t) {
                let ordered = isOl(t)
                var items: [String] = []
                while i < lines.count {
                    let r = lines[i].trimmingCharacters(in: .whitespaces)
                    if ordered, let item = olItem(r) { items.append(item); i += 1 }
                    else if !ordered, let item = ulItem(r) { items.append(item); i += 1 }
                    else { break }
                }
                let tag = ordered ? "ol" : "ul"
                out.append("<\(tag)>" + items.map { "<li>\(inline($0))</li>" }.joined() + "</\(tag)>")
                continue
            }
            var para: [String] = [t]
            i += 1
            while i < lines.count {
                let r = lines[i].trimmingCharacters(in: .whitespaces)
                if r.isEmpty || r.hasPrefix("|") || r.hasPrefix("#") || r.hasPrefix("> ") || isUl(r) || isOl(r) || r == "---" { break }
                para.append(r)
                i += 1
            }
            out.append("<p>\(inline(para.joined(separator: " ")))</p>")
        }
        return out
    }

    private static func heading(_ t: String) -> (level: Int, text: String)? {
        if t.hasPrefix("### ") { return (3, String(t.dropFirst(4))) }
        if t.hasPrefix("## ") { return (2, String(t.dropFirst(3))) }
        if t.hasPrefix("# ") { return (1, String(t.dropFirst(2))) }
        return nil
    }

    private static func isUl(_ t: String) -> Bool {
        t.hasPrefix("- ") || t.hasPrefix("* ")
    }
    private static func ulItem(_ t: String) -> String? {
        if t.hasPrefix("- ") { return String(t.dropFirst(2)) }
        if t.hasPrefix("* ") { return String(t.dropFirst(2)) }
        return nil
    }
    private static func isOl(_ t: String) -> Bool {
        olItem(t) != nil
    }
    private static func olItem(_ t: String) -> String? {
        guard let dot = t.firstIndex(of: ".") else { return nil }
        let n = t[..<dot]
        guard !n.isEmpty, n.allSatisfy(\.isNumber) else { return nil }
        let rest = t[t.index(after: dot)...]
        guard rest.hasPrefix(" ") else { return nil }
        return String(rest.dropFirst())
    }

    private static func renderTable(_ rows: [String]) -> String {
        let parsed = rows.map { row -> [String] in
            var parts = row.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
            if parts.first == "" { parts.removeFirst() }
            if parts.last == "" { parts.removeLast() }
            return parts
        }.filter { row in !row.allSatisfy { $0.allSatisfy({ $0 == "-" || $0 == ":" || $0.isWhitespace }) } }
        guard let head = parsed.first else { return "" }
        let body = parsed.dropFirst()
        var html = "<div class=\"wrap\"><table><thead><tr>"
        html += head.map { "<th>\(inline($0))</th>" }.joined()
        html += "</tr></thead><tbody>"
        for r in body {
            html += "<tr>" + r.map { "<td>\(inline($0))</td>" }.joined() + "</tr>"
        }
        html += "</tbody></table></div>"
        return html
    }

    private static func inline(_ raw: String) -> String {
        var s = escape(raw)
        s = replace(s, pattern: "`([^`]+)`", template: "<code>$1</code>")
        s = replace(s, pattern: #"\*\*([^*]+)\*\*"#, template: "<strong>$1</strong>")
        s = replace(s, pattern: #"\*([^*]+)\*"#, template: "<em>$1</em>")
        s = replace(s, pattern: #"\[([^\]]+)\]\(([^)]+)\)"#, template: "<a href=\"$2\">$1</a>")
        return s
    }

    private static func replace(_ s: String, pattern: String, template: String) -> String {
        (try? NSRegularExpression(pattern: pattern)).map {
            $0.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: template)
        } ?? s
    }

    private static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}

struct MarkdownWebView: UIViewRepresentable {
    let text: String
    @Binding var height: CGFloat

    func makeCoordinator() -> Coord { Coord() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.defaultWebpagePreferences.preferredContentMode = .mobile
        let w = WKWebView(frame: .zero, configuration: cfg)
        w.navigationDelegate = context.coordinator
        w.scrollView.isScrollEnabled = false
        w.scrollView.bounces = false
        w.isOpaque = false
        w.backgroundColor = .clear
        w.scrollView.backgroundColor = .clear
        return w
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.height = $height
        if context.coordinator.lastText != text {
            context.coordinator.lastText = text
            webView.loadHTMLString(MarkdownHTML.from(text), baseURL: nil)
        }
    }

    final class Coord: NSObject, WKNavigationDelegate {
        var lastText = ""
        var height: Binding<CGFloat> = .constant(120)
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript("document.documentElement.scrollHeight") { val, _ in
                let h = CGFloat((val as? NSNumber)?.doubleValue ?? 0)
                DispatchQueue.main.async {
                    if h > 0 { self.height.wrappedValue = h }
                }
            }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}
