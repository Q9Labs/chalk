import SwiftUI
import WebKit

struct WhiteboardWebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let content = WKUserContentController()
        content.add(context.coordinator, name: "chalk")

        let config = WKWebViewConfiguration()
        config.userContentController = content

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.backgroundColor = .clear
        webView.isOpaque = false

        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "whiteboard") {
            let dir = url.deletingLastPathComponent()
            webView.loadFileURL(url, allowingReadAccessTo: dir)
        }

        return webView
    }
    
    func updateUIView(_ uiView: WKWebView, context: Context) {
        // Handle updates (e.g. permission changes)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "chalk" else { return }
            // Bridge messages from JS land here. For now, log only.
            // Next step: forward to MeetingKit (WS + presign) and respond via evaluateJavaScript.
            // print("whiteboard js:", message.body)
        }
    }
}
