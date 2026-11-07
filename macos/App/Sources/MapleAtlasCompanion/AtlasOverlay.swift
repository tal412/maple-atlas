import AppKit
import SwiftUI
import WebKit

/// A floating panel over the game, also over a game in full screen (its own Space), that takes
/// the keyboard without making this app active, so the game's screen never switches away.
final class OverlayPanel: NSPanel {
    var onEscape: (() -> Void)?
    var onKey: ((String) -> Bool)?

    init(size: CGSize) {
        super.init(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel, .resizable], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue - 1)
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        becomesKeyOnlyIfNeeded = false
        isMovableByWindowBackground = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) { onEscape?() }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
           let chars = event.charactersIgnoringModifiers, Int(chars) != nil, onKey?(chars) == true { return true }
        return super.performKeyEquivalent(with: event)
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onEscape?(); return }
        if let chars = event.charactersIgnoringModifiers, onKey?(chars) == true { return }
        super.keyDown(with: event)
    }
}

/// One entry of the Atlas menu.
struct AtlasMenuEntry: Identifiable {
    let id = UUID()
    let symbol: String
    let title: String
    var detail = ""
    var shortcut = ""
    var on: Bool?
    let run: () -> Void
}

@MainActor @Observable
final class AtlasMenuState {
    var status = ""
    var entries: [AtlasMenuEntry] = []
    var hovered: UUID?
    var pick: (AtlasMenuEntry) -> Void = { _ in }
}

/// ⌃⌥M: the Atlas menu pops up over the game (in its middle): Maple Atlas, search, quests,
/// directions, Look and the on-game navigation. A number key or a click picks an entry; Esc, ⌃⌥M
/// again or a click outside closes it.
@MainActor
final class AtlasMenuController {
    var gameFrame: () -> CGRect? = { nil }
    private let state = AtlasMenuState()
    private var panel: OverlayPanel?
    private var observer: NSObjectProtocol?

    var isOpen: Bool { panel?.isVisible == true }

    func toggle(status: String, entries: [AtlasMenuEntry]) {
        if isOpen { close(); return }
        state.status = status
        state.entries = entries
        state.hovered = nil
        state.pick = { [weak self] entry in self?.close(); entry.run() }
        if panel == nil {
            let p = OverlayPanel(size: CGSize(width: 360, height: 420))
            p.styleMask.remove(.resizable)
            p.contentView = NSHostingView(rootView: AtlasMenuCard(state: state))
            p.onEscape = { [weak self] in self?.close() }
            p.onKey = { [weak self] key in
                guard let self, let n = Int(key), n >= 1, n <= self.state.entries.count else { return false }
                self.state.pick(self.state.entries[n - 1])
                return true
            }
            panel = p
        }
        guard let panel else { return }
        panel.contentView?.layoutSubtreeIfNeeded()
        let size = panel.contentView?.fittingSize ?? CGSize(width: 360, height: 420)
        let area = gameFrame() ?? NSScreen.main?.visibleFrame ?? .zero
        panel.setFrame(CGRect(x: area.midX - size.width / 2, y: area.midY - size.height / 2, width: size.width, height: size.height), display: true)
        panel.orderFrontRegardless()
        panel.makeKey()
        // A click outside (back in the game) closes it.
        observer = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: panel, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }
    }

    func close() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        panel?.orderOut(nil)
    }
}

private struct AtlasMenuCard: View {
    let state: AtlasMenuState

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 10) {
                Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Maple Atlas").font(.system(size: 15, weight: .semibold))
                    Text(state.status).font(.system(size: 12)).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
                }
                Spacer(minLength: 0)
                Text("⌃⌥M").font(.system(size: 11, weight: .medium)).foregroundStyle(.white.opacity(0.5))
            }
            .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 8)
            ForEach(Array(state.entries.enumerated()), id: \.element.id) { i, entry in
                Button { state.pick(entry) } label: {
                    HStack(spacing: 12) {
                        Text("\(i + 1)").font(.system(size: 11, weight: .bold).monospacedDigit()).foregroundStyle(.white.opacity(0.45)).frame(width: 12)
                        Image(systemName: entry.symbol).font(.system(size: 15, weight: .medium)).frame(width: 22)
                            .foregroundStyle(Color(red: 0.94, green: 0.77, blue: 0.10))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(entry.title).font(.system(size: 14, weight: .medium))
                            if !entry.detail.isEmpty { Text(entry.detail).font(.system(size: 11)).foregroundStyle(.white.opacity(0.6)).lineLimit(1) }
                        }
                        Spacer(minLength: 8)
                        if let on = entry.on {
                            Text(on ? "On" : "Off").font(.system(size: 11, weight: .semibold)).foregroundStyle(on ? Color(red: 0.45, green: 0.9, blue: 0.55) : .white.opacity(0.5))
                        }
                        if !entry.shortcut.isEmpty { Text(entry.shortcut).font(.system(size: 11)).foregroundStyle(.white.opacity(0.5)) }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 10).fill(state.hovered == entry.id ? Color.white.opacity(0.12) : .clear))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { inside in state.hovered = inside ? entry.id : (state.hovered == entry.id ? nil : state.hovered) }
            }
            Text("Press a number, or click. Esc closes.").font(.system(size: 11)).foregroundStyle(.white.opacity(0.45))
                .padding(.horizontal, 14).padding(.top, 6).padding(.bottom, 12)
        }
        .padding(.horizontal, 4)
        .frame(width: 360)
        .foregroundStyle(.white)
        .background(RoundedRectangle(cornerRadius: 20).fill(Color.black.opacity(0.86)))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.white.opacity(0.18), lineWidth: 1))
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// The overlay's tabs. Each is one number key (or ⌘ and the number while typing).
enum OverlayTab: String, CaseIterable, Identifiable {
    case map, search, quests, directions, look, companion
    var id: String { rawValue }
    var title: String {
        switch self {
        case .map: "Map"
        case .search: "Search"
        case .quests: "Quests"
        case .directions: "Directions"
        case .look: "Look"
        case .companion: "Companion"
        }
    }
    var symbol: String {
        switch self {
        case .map: "map"
        case .search: "magnifyingglass"
        case .quests: "scroll"
        case .directions: "point.topleft.down.to.point.bottomright.curvepath"
        case .look: "photo"
        case .companion: "gearshape"
        }
    }
}

@MainActor @Observable
final class AtlasCardState {
    var tab = OverlayTab.map
    var hovered: OverlayTab?
}

/// Maple Atlas over the game, in the same dark card as the Atlas menu: a header with the live
/// status and numbered tabs, and under it the page (without the site's own header and footers)
/// or the companion's settings. The page's web view moves into the card and back to the app's
/// window when the card closes. It never brings the app's window forward.
@MainActor
final class AtlasPopupController {
    var gameFrame: () -> CGRect? = { nil }
    var onClosed: () -> Void = {}
    /// A tab was picked (a click or its number): the model shows it.
    var onTab: (OverlayTab) -> Void = { _ in }
    let state = AtlasCardState()
    private var panel: OverlayPanel?
    private var webSlot: NSView?
    private var companionSlot: NSView?
    private var observer: NSObjectProtocol?

    var isOpen: Bool { panel?.isVisible == true }

    func open(_ browser: AtlasBrowser, model: CompanionModel) {
        if panel == nil {
            let p = OverlayPanel(size: CGSize(width: 1100, height: 720))
            p.minSize = CGSize(width: 760, height: 480)
            p.appearance = NSAppearance(named: .darkAqua)
            let root = NSView()
            root.wantsLayer = true
            root.layer?.cornerRadius = 20
            root.layer?.masksToBounds = true
            root.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.86).cgColor
            root.layer?.borderColor = NSColor.white.withAlphaComponent(0.18).cgColor
            root.layer?.borderWidth = 1
            let header = NSHostingView(rootView: OverlayHeader(model: model, state: state, pick: { [weak self] tab in self?.onTab(tab) }, close: { [weak self] in self?.close() }))
            let web = NSView()
            web.wantsLayer = true
            web.layer?.cornerRadius = 14
            web.layer?.masksToBounds = true
            let companion = NSHostingView(rootView: ContentView(model: model).frame(maxWidth: 640).frame(maxWidth: .infinity))
            companion.wantsLayer = true
            companion.layer?.cornerRadius = 14
            companion.layer?.masksToBounds = true
            companion.isHidden = true
            for v in [header, web, companion] as [NSView] { v.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(v) }
            NSLayoutConstraint.activate([
                header.topAnchor.constraint(equalTo: root.topAnchor), header.leadingAnchor.constraint(equalTo: root.leadingAnchor),
                header.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            ])
            for v in [web, companion] as [NSView] {
                NSLayoutConstraint.activate([
                    v.topAnchor.constraint(equalTo: header.bottomAnchor), v.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 10),
                    v.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -10), v.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -10),
                ])
            }
            p.contentView = root
            p.onEscape = nil  // Esc belongs to the page (it closes its own dialogs)
            p.onKey = { [weak self] key in
                guard let self, let n = Int(key), n >= 1, n <= OverlayTab.allCases.count else { return false }
                self.onTab(OverlayTab.allCases[n - 1])
                return true
            }
            panel = p
            webSlot = web
            companionSlot = companion
        }
        guard let panel, let webSlot else { return }
        let area = gameFrame() ?? NSScreen.main?.visibleFrame ?? .zero
        let size = CGSize(width: max(760, min(1240, area.width * 0.86)), height: max(480, min(880, area.height * 0.88)))
        panel.setFrame(CGRect(x: area.midX - size.width / 2, y: area.midY - size.height / 2, width: size.width, height: size.height), display: false)
        browser.move(to: webSlot)
        browser.setOverlay(true)
        panel.orderFrontRegardless()
        panel.makeKey()
        show(state.tab, browser: browser)
        // Clicking back into the game puts it away.
        observer = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: panel, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }
    }

    /// Shows a tab: the page for the Atlas ones, the settings for Companion.
    func show(_ tab: OverlayTab, browser: AtlasBrowser) {
        state.tab = tab
        let companion = tab == .companion
        companionSlot?.isHidden = !companion
        webSlot?.isHidden = companion
        panel?.makeFirstResponder(companion ? companionSlot : browser.webView)
    }

    func close() {
        guard isOpen else { return }
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        panel?.orderOut(nil)
        onClosed()
    }
}

private struct OverlayHeader: View {
    let model: CompanionModel
    let state: AtlasCardState
    let pick: (OverlayTab) -> Void
    let close: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            HStack(spacing: 10) {
                Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Maple Atlas").font(.system(size: 15, weight: .semibold))
                    Text(model.liveStatus).font(.system(size: 12)).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
                }
            }
            .frame(minWidth: 150, alignment: .leading)
            HStack(spacing: 4) {
                ForEach(Array(OverlayTab.allCases.enumerated()), id: \.element.id) { i, tab in
                    let on = state.tab == tab
                    Button { pick(tab) } label: {
                        HStack(spacing: 7) {
                            Text("\(i + 1)").font(.system(size: 11, weight: .bold).monospacedDigit()).foregroundStyle(.white.opacity(0.45))
                            Image(systemName: tab.symbol).font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Color(red: 0.94, green: 0.77, blue: 0.10))
                            Text(tab.title).font(.system(size: 13, weight: on ? .semibold : .medium))
                        }
                        .padding(.horizontal, 10).padding(.vertical, 7)
                        .background(RoundedRectangle(cornerRadius: 10).fill(on ? Color.white.opacity(0.16) : state.hovered == tab ? Color.white.opacity(0.08) : .clear))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(on ? Color.white.opacity(0.22) : .clear, lineWidth: 1))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .onHover { inside in state.hovered = inside ? tab : (state.hovered == tab ? nil : state.hovered) }
                    .help("\(tab.title) · \(i + 1), or ⌘\(i + 1) while typing")
                }
            }
            Spacer(minLength: 8)
            Text("⌃⌥W hides").font(.system(size: 11, weight: .medium)).foregroundStyle(.white.opacity(0.5))
            Button(action: close) {
                Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).frame(width: 26, height: 26)
                    .background(Circle().fill(Color.white.opacity(0.10)))
            }
            .buttonStyle(.plain).help("Back to the game (⌃⌥W)")
        }
        .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 10)
        .foregroundStyle(.white)
    }
}
