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
    var onPasteImage: ((Data) -> Void)? = nil

    func makeCoordinator() -> Coord { Coord(text: $text, onPasteImage: onPasteImage) }

    func makeUIView(context: Context) -> ComposerTextView {
        let view = ComposerTextView()
        view.minHeight = minHeight
        view.maxHeight = maxHeight
        view.onPasteImage = onPasteImage
        view.delegate = context.coordinator
        view.font = .preferredFont(forTextStyle: .body)
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 8, left: 4, bottom: 8, right: 4)
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.required, for: .vertical)
        view.setContentCompressionResistancePriority(.required, for: .vertical)
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
        context.coordinator.onPasteImage = onPasteImage
        uiView.onPasteImage = onPasteImage
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
        var onPasteImage: ((Data) -> Void)?
        init(text: Binding<String>, onPasteImage: ((Data) -> Void)?) {
            self.text = text
            self.onPasteImage = onPasteImage
        }
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
    var onPasteImage: ((Data) -> Void)?

    func refreshPlaceholder() {
        placeholderLabel.isHidden = !(text ?? "").isEmpty
    }

    override func paste(_ sender: Any?) {
        if let data = pngOrJpegFromPasteboard() {
            onPasteImage?(data)
            return
        }
        if let img = UIPasteboard.general.image, let jpeg = img.jpegData(compressionQuality: 0.92) {
            onPasteImage?(jpeg)
            return
        }
        super.paste(sender)
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), pngOrJpegFromPasteboard() != nil || UIPasteboard.general.image != nil {
            return onPasteImage != nil || super.canPerformAction(action, withSender: sender)
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override var intrinsicContentSize: CGSize {
        let width = bounds.width > 0 ? bounds.width : UIScreen.main.bounds.width - 88
        let fitting = sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let height = min(max(fitting.height, minHeight), maxHeight)
        isScrollEnabled = fitting.height > maxHeight + 0.5
        return CGSize(width: UIView.noIntrinsicMetric, height: height)
    }
}

func pngOrJpegFromPasteboard() -> Data? {
    let pb = UIPasteboard.general
    if let d = pb.data(forPasteboardType: "public.png"), d.count >= 4,
       d[0] == 0x89, d[1] == 0x50, d[2] == 0x4E, d[3] == 0x47 { return d }
    if let d = pb.data(forPasteboardType: "public.jpeg"), d.count >= 3,
       d[0] == 0xFF, d[1] == 0xD8, d[2] == 0xFF { return d }
    return nil
}
