import Foundation
import WebKit

/// Look's recognition on the Mac: a hidden web view with the site's look-host.html (Look's own
/// detector, namers and files, kept in this web view's cache after the first download). A box
/// marked on the game (from the ⌃⌥M menu) or the phone's Look is recognized here; the phone only shows it.
@MainActor
final class LookHost: NSObject, WKNavigationDelegate {
    /// What the phone's Look view needs (each thing with its box), as JSON, and the card for the
    /// overlay.
    struct Answer: Sendable {
        let card: LookCard
        let result: Data
    }

    enum LookHostError: LocalizedError {
        case notLoaded(String)
        case failed(String)
        var errorDescription: String? {
            switch self {
            case .notLoaded(let why): "Look is not ready (\(why))."
            case .failed(let why): why
            }
        }
    }

    /// The line to show while it works ("Naming 3 of 12…").
    var onProgress: (String) -> Void = { _ in }

    private let webView: WKWebView
    private var loadedURL: URL?
    private var navigation: CheckedContinuation<Void, Error>?

    override init() {
        let configuration = WKWebViewConfiguration()
        let preferences = WKPreferences()
        preferences.inactiveSchedulingPolicy = .none
        configuration.preferences = preferences
        // A lasting store, so Look's files (about 40 MB) download once.
        configuration.websiteDataStore = .default()
        let controller = WKUserContentController()
        configuration.userContentController = controller
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: configuration)
        webView.isInspectable = true
        super.init()
        webView.navigationDelegate = self
        controller.add(ProgressHandler(self), name: "look")
    }

    /// Opens look-host.html of the site (once per site), right away, so the first look is quick.
    func prepare(site: String) async throws {
        guard let url = URL(string: site + "look-host.html") else { throw LookHostError.notLoaded("no address") }
        if loadedURL == url { return }
        loadedURL = url
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            navigation?.resume(throwing: LookHostError.notLoaded("superseded"))
            navigation = c
            webView.load(URLRequest(url: url))
        }
        let script = """
        for (let i = 0; i < 300 && !window.MapleLookHost; i++) await new Promise(r => setTimeout(r, 100));
        if (!window.MapleLookHost) throw new Error('Look did not start');
        return await window.MapleLookHost.ready();
        """
        do { _ = try await webView.callAsyncJavaScript(script, contentWorld: .page) } catch {
            loadedURL = nil
            throw LookHostError.notLoaded(error.localizedDescription)
        }
    }

    /// Recognizes a screenshot of the game window (JPEG), in a marked box (0…1 of the window) or
    /// the whole window.
    func analyze(site: String, jpeg: Data, lines: [[Any]], map: String?, mark: CGRect?) async throws -> Answer {
        try await prepare(site: site)
        let markValue: Any = mark.map { ["x": Double($0.minX), "y": Double($0.minY), "w": Double($0.width), "h": Double($0.height)] } ?? NSNull()
        let script = "return JSON.stringify(await window.MapleLookHost.analyze({jpeg, lines, map, mark}));"
        let raw: Any?
        do {
            raw = try await webView.callAsyncJavaScript(script, arguments: [
                "jpeg": jpeg.base64EncodedString(), "lines": lines, "map": map ?? NSNull(), "mark": markValue,
            ], contentWorld: .page)
        } catch {
            throw LookHostError.failed("Look could not finish: " + error.localizedDescription)
        }
        guard let text = raw as? String, let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let card = object["card"], let result = object["result"] else { throw LookHostError.failed("Look gave no answer.") }
        let cardData = try JSONSerialization.data(withJSONObject: card)
        return Answer(card: try LookCard.fromPage(cardData), result: try JSONSerialization.data(withJSONObject: result))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        self.navigation?.resume()
        self.navigation = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loadedURL = nil
        self.navigation?.resume(throwing: error)
        self.navigation = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loadedURL = nil
        self.navigation?.resume(throwing: error)
        self.navigation = nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loadedURL = nil
    }

    fileprivate func received(_ body: Any) {
        guard let message = body as? [String: Any], let progress = message["progress"] as? String else { return }
        onProgress(String(progress.prefix(60)))
    }
}

/// Progress lines from the page (webkit.messageHandlers.look).
private final class ProgressHandler: NSObject, WKScriptMessageHandler {
    weak var host: LookHost?
    init(_ host: LookHost) { self.host = host }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let body = message.body
        MainActor.assumeIsolated { host?.received(body) }
    }
}
