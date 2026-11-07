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

/// Maple Atlas over the game: the same page as the app's window (its web view moves into this
/// panel and back), over the game's middle, with a thin bar to close it.
@MainActor
final class AtlasPopupController {
    var gameFrame: () -> CGRect? = { nil }
    var onClosed: () -> Void = {}
    private var panel: OverlayPanel?
    private var slot: NSView?
    private var observer: NSObjectProtocol?

    var isOpen: Bool { panel?.isVisible == true }

    func open(_ browser: AtlasBrowser) {
        if panel == nil {
            let p = OverlayPanel(size: CGSize(width: 1100, height: 720))
            p.minSize = CGSize(width: 520, height: 400)
            let root = NSView()
            root.wantsLayer = true
            root.layer?.cornerRadius = 14
            root.layer?.masksToBounds = true
            root.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
            let bar = NSHostingView(rootView: PopupBar(close: { [weak self] in self?.close() }))
            let slot = NSView()
            for v in [bar, slot] { v.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(v) }
            NSLayoutConstraint.activate([
                bar.topAnchor.constraint(equalTo: root.topAnchor), bar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
                bar.trailingAnchor.constraint(equalTo: root.trailingAnchor), bar.heightAnchor.constraint(equalToConstant: 30),
                slot.topAnchor.constraint(equalTo: bar.bottomAnchor), slot.leadingAnchor.constraint(equalTo: root.leadingAnchor),
                slot.trailingAnchor.constraint(equalTo: root.trailingAnchor), slot.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            ])
            p.contentView = root
            p.onEscape = nil  // Esc belongs to the page (it closes its own dialogs)
            panel = p
            self.slot = slot
        }
        guard let panel, let slot else { return }
        let area = gameFrame() ?? NSScreen.main?.visibleFrame ?? .zero
        let size = CGSize(width: max(560, area.width * 0.86), height: max(420, area.height * 0.86))
        panel.setFrame(CGRect(x: area.midX - size.width / 2, y: area.midY - size.height / 2, width: size.width, height: size.height), display: false)
        browser.move(to: slot)
        panel.orderFrontRegardless()
        panel.makeKey()
        panel.makeFirstResponder(browser.webView)
        // Clicking back into the game puts it away.
        observer = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: panel, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }
    }

    func close() {
        guard isOpen else { return }
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        panel?.orderOut(nil)
        onClosed()
    }
}

private struct PopupBar: View {
    let close: () -> Void
    var body: some View {
        HStack(spacing: 8) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 18, height: 18)
            Text("Maple Atlas").font(.system(size: 12, weight: .semibold))
            Text("· ⌃⌥W or a click on the game hides it · ⌃⌥M menu").font(.system(size: 11)).foregroundStyle(.secondary)
            Spacer()
            Button(action: close) { Image(systemName: "xmark").font(.system(size: 11, weight: .bold)) }
                .buttonStyle(.borderless).help("Hide (⌃⌥W)")
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.bar)
    }
}
