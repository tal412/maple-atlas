import AppKit
import SwiftUI
import WebKit

/// Maple Atlas itself in the app's window: the site, served through the helper on this Mac's
/// own loopback address (macos/link/local.go) and linked to the game here the way a paired
/// phone is, so the map, quests, Look and prices all work with no phone near.
@MainActor
final class AtlasBrowser: NSObject, WKUIDelegate, WKNavigationDelegate {
    let webView: WKWebView
    private var base: URL?
    private var token = ""
    private let tokenScript: WKUserContentController

    override init() {
        let configuration = WKWebViewConfiguration()
        let preferences = WKPreferences()
        // The game is usually in front: keep the page's timers and the live map running.
        preferences.inactiveSchedulingPolicy = .none
        preferences.isElementFullscreenEnabled = true
        configuration.preferences = preferences
        // Saved quests, settings and Look's files stay between launches.
        configuration.websiteDataStore = .default()
        tokenScript = WKUserContentController()
        configuration.userContentController = tokenScript
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isInspectable = true
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = true
        super.init()
        webView.uiDelegate = self
        webView.navigationDelegate = self
    }

    /// Opens the helper's address (http://127.0.0.1:PORT/#companion=TOKEN). The token is given
    /// to the page before its scripts run, so a reload, or a helper restarted with a new token,
    /// keeps the link.
    func open(_ url: URL) {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        let fragment = parts.fragment ?? ""
        let newToken = fragment.hasPrefix("companion=") ? String(fragment.dropFirst("companion=".count)) : ""
        parts.fragment = nil
        guard let newBase = parts.url, newToken.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else { return }
        let sameBase = newBase == base
        if sameBase && newToken == token { return }
        base = newBase
        token = newToken
        tokenScript.removeAllUserScripts()
        let source = "try{if(/^(127\\.0\\.0\\.1|localhost)$/.test(location.hostname))sessionStorage.setItem('maple-atlas-companion-token','\(newToken)');}catch(_){}"
        tokenScript.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if sameBase, webView.url != nil { webView.reload() } else { webView.load(URLRequest(url: newBase)) }
    }

    /// The main window's place for the page.
    weak var home: NSView?

    /// Puts the page in a view (filling it): the main window's, or the overlay's.
    func move(to view: NSView) {
        guard webView.superview !== view else { return }
        webView.removeFromSuperview()
        webView.frame = view.bounds
        webView.autoresizingMask = [.width, .height]
        view.addSubview(webView)
    }

    func goHome() { if let home { move(to: home) } }

    func reload() {
        if webView.url == nil, let base { webView.load(URLRequest(url: base)) } else { webView.reload() }
    }

    // Links to other sites (sources, the market, downloads) open in the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ["http", "https"].contains(url.scheme) { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url, navigationAction.targetFrame?.isMainFrame ?? true else { return .allow }
        if let host = url.host, !["127.0.0.1", "localhost"].contains(host), ["http", "https"].contains(url.scheme) {
            NSWorkspace.shared.open(url)
            return .cancel
        }
        return .allow
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        reload()
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        return panel.runModal() == .OK ? panel.urls : nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}

/// The main window's place for the page. The web view lives here, and moves into the overlay
/// over the game while that is open (AtlasPopupController), then comes back.
struct AtlasWebView: NSViewRepresentable {
    let browser: AtlasBrowser
    func makeNSView(context: Context) -> NSView {
        let home = NSView()
        browser.home = home
        browser.goHome()
        return home
    }
    func updateNSView(_ view: NSView, context: Context) {}
}

/// The main window: Maple Atlas, with the companion's controls (phone pairing, game window,
/// tracking) in a panel on the right.
struct MainView: View {
    @Bindable var model: CompanionModel

    var body: some View {
        AtlasWebView(browser: model.atlas)
            .overlay {
                if model.atlasURL == nil {
                    VStack(spacing: 10) {
                        ProgressView()
                        Text(model.helperProblem ?? "Opening Maple Atlas…").foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.background)
                }
            }
            .frame(minWidth: 640, minHeight: 520)
            .inspector(isPresented: $model.showControls) {
                ContentView(model: model)
                    .inspectorColumnWidth(min: 400, ideal: 460, max: 640)
            }
            .toolbar {
                ToolbarItem(placement: .navigation) {
                    Label(model.liveStatus, systemImage: model.isTracking ? "dot.radiowaves.left.and.right" : "pause.circle")
                        .labelStyle(.titleAndIcon)
                        .foregroundStyle(model.isTracking ? .primary : .secondary)
                        .help("What the companion reads from the game window")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { model.toggleAtlasPopup() } label: { Label("Over the game", systemImage: "macwindow.on.rectangle") }
                        .help("Show Maple Atlas over the game window. Anywhere: ⌃⌥W shows and hides it.")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { model.atlas.reload() } label: { Label("Reload", systemImage: "arrow.clockwise") }
                        .help("Reload Maple Atlas")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { model.toggleControls() } label: { Label("Companion", systemImage: "sidebar.right") }
                        .help("Game window, tracking and phone pairing")
                }
            }
            // The engine's web view must stay in a window hierarchy so WebKit keeps it running.
            .background(alignment: .topLeading) {
                EngineWebView(webView: model.engine.webView)
                    .frame(width: 1, height: 1)
                    .opacity(0)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
    }
}
