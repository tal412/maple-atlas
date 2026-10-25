import Foundation
import WebKit

/// One result from `atlasEngine.read(dataURL)`.
struct EngineReading: Decodable, Sendable {
    let phase: String
    let id: String?
    let name: String?
    let inliers: Int?
    let kind: String?
    let confidence: Int?
    let text: String?
    let elapsed: Double?
    /// The player's dot on the map (portal-data coordinates), when the minimap showed it.
    let position: Position?
    /// Why no position was found ("no-dot", "few-portals", …).
    let positionNote: String?

    struct Position: Decodable, Sendable, Equatable {
        let x: Double
        let y: Double
    }

    /// Result of `atlasEngine.locate`.
    struct Located: Decodable, Sendable {
        let position: Position?
    }

    private enum CodingKeys: String, CodingKey {
        case phase, id, name, inliers, kind, confidence, text, elapsed, position, positionNote
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        phase = try c.decode(String.self, forKey: .phase)
        // Map ids are strings by contract; accept numbers too rather than dropping a match.
        if let string = try? c.decodeIfPresent(String.self, forKey: .id) {
            id = string
        } else if let number = try? c.decodeIfPresent(Int64.self, forKey: .id) {
            id = String(number)
        } else {
            id = nil
        }
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        inliers = (try? c.decodeIfPresent(Double.self, forKey: .inliers)).map { Int($0.rounded()) }
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        confidence = (try? c.decodeIfPresent(Double.self, forKey: .confidence)).map { Int($0.rounded()) }
        text = try? c.decodeIfPresent(String.self, forKey: .text)
        elapsed = try? c.decodeIfPresent(Double.self, forKey: .elapsed)
        position = try? c.decodeIfPresent(Position.self, forKey: .position)
        positionNote = try? c.decodeIfPresent(String.self, forKey: .positionNote)
    }
}

/// Hosts the hidden WKWebView that runs the JavaScript matching engine.
@MainActor
final class EngineHost: NSObject {
    enum EngineError: LocalizedError {
        case busy
        case badResult
        case navigation(String)
        case superseded

        var errorDescription: String? {
            switch self {
            case .busy: "The engine is still reading the previous frame."
            case .badResult: "The engine returned an unexpected result."
            case .navigation(let message): "Couldn't load the engine: \(message)"
            case .superseded: "The engine page was replaced."
            }
        }
    }

    let webView: WKWebView
    var onProgress: (String) -> Void = { _ in }
    var onConsole: (String) -> Void = { _ in }
    var onCrash: () -> Void = {}

    private(set) var loadedURL: URL?
    private var navigationWaiter: CheckedContinuation<Void, Error>?
    private var reading = false
    private var locating = false
    private var questReading = false

    override init() {
        let configuration = WKWebViewConfiguration()
        let preferences = WKPreferences()
        // Keep the engine running at full speed while the window is in the background.
        preferences.inactiveSchedulingPolicy = .none
        configuration.preferences = preferences
        configuration.websiteDataStore = .nonPersistent()

        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: Self.consoleBridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController = controller

        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: configuration)
        webView.isInspectable = true // Lets Safari's Web Inspector attach for diagnostics.
        super.init()
        webView.navigationDelegate = self
        controller.add(WeakMessageHandler(self), name: "atlas")
    }

    /// Loads the engine page and waits for the navigation to finish.
    func load(_ url: URL) async throws {
        navigationWaiter?.resume(throwing: EngineError.superseded)
        navigationWaiter = nil
        loadedURL = url
        reading = false
        try await withCheckedThrowingContinuation { continuation in
            navigationWaiter = continuation
            webView.load(URLRequest(url: url))
        }
    }

    /// Waits for `atlasEngine.ready()`; returns the number of maps in the index.
    func ready() async throws -> Int {
        let script = """
        for (let i = 0; i < 300 && !window.atlasEngine; i++) await new Promise(r => setTimeout(r, 100));
        if (!window.atlasEngine) throw new Error('atlasEngine is not defined on the engine page');
        const info = await window.atlasEngine.ready();
        return Array.isArray(info?.maps) ? info.maps.length : 0;
        """
        let result = try await webView.callAsyncJavaScript(script, contentWorld: .page)
        return (result as? NSNumber)?.intValue ?? 0
    }

    /// Runs one `atlasEngine.read`. Calls never overlap; a concurrent call throws `.busy`.
    func read(_ dataURL: String, frameHeight: Int) async throws -> EngineReading {
        guard !reading else { throw EngineError.busy }
        reading = true
        defer { reading = false }
        let script = "return JSON.stringify(await window.atlasEngine.read(frame, frameHeight));"
        let result = try await webView.callAsyncJavaScript(
            script, arguments: ["frame": dataURL, "frameHeight": frameHeight], contentWorld: .page)
        guard let json = result as? String,
              let reading = try? JSONDecoder().decode(EngineReading.self, from: Data(json.utf8))
        else { throw EngineError.badResult }
        return reading
    }

    /// Reads only the player's dot on an already-confirmed map (fast; no landmark matching).
    func locate(_ dataURL: String, frameHeight: Int, mapID: String) async throws -> EngineReading.Position? {
        guard !locating else { throw EngineError.busy }
        locating = true
        defer { locating = false }
        let script = "return JSON.stringify(await window.atlasEngine.locate(frame, frameHeight, mapID));"
        let result = try await webView.callAsyncJavaScript(
            script, arguments: ["frame": dataURL, "frameHeight": frameHeight, "mapID": mapID], contentWorld: .page)
        guard let json = result as? String,
              let reading = try? JSONDecoder().decode(EngineReading.Located.self, from: Data(json.utf8))
        else { throw EngineError.badResult }
        return reading.position
    }

    /// What `atlasEngine.readQuests` saw in the Quest Helper panel. `quests` stays in the
    /// engine's compact form and is passed to the phone as is.
    struct QuestReading: @unchecked Sendable {
        let visible: Bool
        let changed: Bool
        let quests: [Any]
        let text: String?
    }

    func readQuests(_ dataURL: String) async throws -> QuestReading {
        guard !questReading else { throw EngineError.busy }
        questReading = true
        defer { questReading = false }
        let script = "return JSON.stringify(await window.atlasEngine.readQuests(frame));"
        let result = try await webView.callAsyncJavaScript(script, arguments: ["frame": dataURL], contentWorld: .page)
        guard let json = result as? String,
              let value = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
              let visible = value["visible"] as? Bool
        else { throw EngineError.badResult }
        return QuestReading(visible: visible, changed: value["changed"] as? Bool ?? true,
                            quests: value["quests"] as? [Any] ?? [], text: value["text"] as? String)
    }

    func reset() async {
        _ = try? await webView.callAsyncJavaScript(
            "window.atlasEngine?.reset?.(); return true;", contentWorld: .page)
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        let text = (body["message"] as? String) ?? ""
        switch type {
        case "progress": onProgress(text)
        case "console": onConsole(text)
        default: onConsole("[\(type)] \(text)")
        }
    }

    /// Forwards console warnings/errors and uncaught errors to the diagnostics log.
    private static let consoleBridge = """
    (() => {
      const post = (message) => { try { window.webkit.messageHandlers.atlas.postMessage({type: 'console', message}); } catch (_) {} };
      const fmt = (args) => args.map(a => { try { return typeof a === 'string' ? a : (a instanceof Error ? a.stack || a.message : JSON.stringify(a)); } catch (_) { return String(a); } }).join(' ');
      for (const level of ['warn', 'error']) {
        const original = console[level].bind(console);
        console[level] = (...args) => { post(level + ': ' + fmt(args)); original(...args); };
      }
      addEventListener('error', e => post('uncaught: ' + (e.message || e)));
      addEventListener('unhandledrejection', e => post('unhandled rejection: ' + fmt([e.reason])));
    })();
    """
}

extension EngineHost: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        navigationWaiter?.resume()
        navigationWaiter = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationWaiter?.resume(throwing: EngineError.navigation(error.localizedDescription))
        navigationWaiter = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationWaiter?.resume(throwing: EngineError.navigation(error.localizedDescription))
        navigationWaiter = nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        navigationWaiter?.resume(throwing: EngineError.navigation("the web content process stopped"))
        navigationWaiter = nil
        reading = false
        onCrash()
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var host: EngineHost?
    init(_ host: EngineHost) { self.host = host }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        host?.receive(message)
    }
}
