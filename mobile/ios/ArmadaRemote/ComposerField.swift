import SwiftUI
import UIKit

/// 竖向 `TextField` 在父视图（`Session` SSE）重绘时会拆掉 IME 组合态。
/// 用稳定 `UITextView`：有 marked text 时不把 SwiftUI 的 text 写回。
struct ComposerField: UIViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var enabled: Bool
    var minHeight: CGFloat = 36
    var maxHeight: CGFloat = 132

    func makeCoordinator() -> Coord { Coord(text: $text) }

    func makeUIView(context: Context) -> ComposerTextView {
        let view = ComposerTextView()
        view.minHeight = minHeight
        view.maxHeight = maxHeight
        view.delegate = context.coordinator
        view.font = .preferredFont(forTextStyle: .body)
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 8, left: 4, bottom: 8, right: 4)
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.placeholderLabel.text = placeholder
        view.placeholderLabel.font = view.font
        view.placeholderLabel.textColor = .placeholderText
        view.placeholderLabel.numberOfLines = 1
        view.addSubview(view.placeholderLabel)
        view.placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            view.placeholderLabel.topAnchor.constraint(equalTo: view.topAnchor, constant: 8),
            view.placeholderLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
            view.placeholderLabel.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -8),
        ])
        view.text = text
        view.refreshPlaceholder()
        return view
    }

    func updateUIView(_ uiView: ComposerTextView, context: Context) {
        context.coordinator.text = $text
        uiView.minHeight = minHeight
        uiView.maxHeight = maxHeight
        uiView.isEditable = enabled
        uiView.isUserInteractionEnabled = enabled
        uiView.placeholderLabel.text = placeholder
        if uiView.markedTextRange != nil { return }
        if uiView.text != text {
            uiView.text = text
            uiView.refreshPlaceholder()
            uiView.invalidateIntrinsicContentSize()
        }
    }

    final class Coord: NSObject, UITextViewDelegate {
        var text: Binding<String>
        init(text: Binding<String>) { self.text = text }
        func textViewDidChange(_ textView: UITextView) {
            (textView as? ComposerTextView)?.refreshPlaceholder()
            textView.invalidateIntrinsicContentSize()
            text.wrappedValue = textView.text ?? ""
        }
    }
}

final class ComposerTextView: UITextView {
    var minHeight: CGFloat = 36
    var maxHeight: CGFloat = 132
    let placeholderLabel = UILabel()

    func refreshPlaceholder() {
        placeholderLabel.isHidden = !(text ?? "").isEmpty
    }

    override var intrinsicContentSize: CGSize {
        let width = bounds.width > 0 ? bounds.width : UIScreen.main.bounds.width - 88
        let fitting = sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let height = min(max(fitting.height, minHeight), maxHeight)
        isScrollEnabled = fitting.height > maxHeight + 0.5
        return CGSize(width: UIView.noIntrinsicMetric, height: height)
    }
}
