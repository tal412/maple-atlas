import AppKit
import Carbon.HIToolbox
import Observation
import SwiftUI

/// What the phone found in a look marked on this Mac (validated by the helper).
struct LookCard: Decodable, Equatable, Sendable {
    struct Item: Decodable, Equatable, Sendable {
        let type: String
        let name: String
        let icon: String
        let detail: String
        let extra: String
        let count: Int
    }
    let title: String
    let note: String
    let items: [Item]
}

/// The look card's state: waiting for the phone, its answer, or why there is none.
@MainActor @Observable
final class LookState {
    var waiting = false
    var card: LookCard?
    var message = ""
}

/// Look on the Mac: ⌃⌥M marks a box on the game window (drag, or click for the area around the
/// pointer), ⌃⌥A looks at the whole window ("Around me"). The screenshot goes to the phone,
/// which finds what is in it and sends a card back, shown next to the box.
///
/// The hotkeys use Carbon's RegisterEventHotKey, the one global shortcut API that needs no
/// Accessibility or Input Monitoring permission.
@MainActor
final class LookController {
    /// Asked to look: the box marked (0…1 of the game window, top-left origin), or nil for all of it.
    var onLook: ((CGRect?) -> Void)?
    /// The game window's id, for placing the marking layer and the card on it.
    var windowID: () -> CGWindowID? = { nil }

    private let state = LookState()
    private var markPanel: NSPanel?
    private var cardPanel: NSPanel?
    private var hideTask: Task<Void, Never>?
    private var hotKeys: [EventHotKeyRef?] = []
    private var lastBox: CGRect?   // where the card goes, in screen coordinates

    static let markKey = "⌃⌥M"
    static let aroundKey = "⌃⌥A"

    func start() {
        guard hotKeys.isEmpty else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, user in
            guard let event, let user else { return OSStatus(eventNotHandledErr) }
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                              MemoryLayout<EventHotKeyID>.size, nil, &id)
            let me = Unmanaged<LookController>.fromOpaque(user).takeUnretainedValue()
            let which = Int(id.id)
            MainActor.assumeIsolated { me.hotKey(which) }
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), nil)
        for (i, key) in [(1, kVK_ANSI_M), (2, kVK_ANSI_A)] {
            var ref: EventHotKeyRef?
            RegisterEventHotKey(UInt32(key), UInt32(controlKey | optionKey), EventHotKeyID(signature: OSType(0x4D41_4C4B), id: UInt32(i)),
                                GetApplicationEventTarget(), 0, &ref)
            hotKeys.append(ref)
        }
    }

    private func hotKey(_ which: Int) {
        if which == 1 { beginMark() } else { lookAll() }
    }

    // MARK: Marking

    func beginMark() {
        guard let frame = Self.gameFrame(windowID()) else { NSSound.beep(); return }
        endMark()
        let panel = MarkPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isReleasedWhenClosed = false
        let view = MarkView(frame: CGRect(origin: .zero, size: frame.size))
        view.onDone = { [weak self] rect in
            guard let self else { return }
            self.endMark()
            guard let rect else { return }
            // View coordinates (bottom-left origin) to 0…1 of the window, top-left origin.
            let box = CGRect(x: rect.minX / frame.width, y: 1 - rect.maxY / frame.height, width: rect.width / frame.width, height: rect.height / frame.height)
            self.lastBox = CGRect(x: frame.minX + rect.minX, y: frame.minY + rect.minY, width: rect.width, height: rect.height)
            self.showWaiting()
            self.onLook?(box)
        }
        panel.contentView = view
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(view)
        markPanel = panel
    }

    private func endMark() {
        markPanel?.orderOut(nil)
        markPanel = nil
    }

    func lookAll() {
        guard let frame = Self.gameFrame(windowID()) else { NSSound.beep(); return }
        endMark()
        lastBox = CGRect(x: frame.midX - 1, y: frame.midY, width: 2, height: 2)
        showWaiting()
        onLook?(nil)
    }

    // MARK: The card

    private func showWaiting() {
        state.waiting = true
        state.card = nil
        state.message = "Looking…"
        showCard(for: 20)
    }

    /// The phone's line while it looks, in place of "Looking…".
    func progress(_ text: String) {
        guard state.waiting else { return }
        state.message = text
        showCard(for: 20)
    }

    func show(_ card: LookCard) {
        state.waiting = false
        state.card = card
        state.message = card.items.isEmpty ? (card.note.isEmpty ? "Nothing from the database found here." : card.note) : card.note
        showCard(for: 15)
    }

    func fail(_ message: String) {
        state.waiting = false
        state.card = nil
        state.message = message
        showCard(for: 8)
    }

    private func showCard(for seconds: Double) {
        guard let frame = Self.gameFrame(windowID()) else { return }
        if cardPanel == nil {
            let p = NSPanel(contentRect: CGRect(x: 0, y: 0, width: 340, height: 120), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = false
            p.level = .screenSaver
            p.ignoresMouseEvents = true
            p.isReleasedWhenClosed = false
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            p.contentView = NSHostingView(rootView: LookCardView(state: state))
            cardPanel = p
        }
        guard let panel = cardPanel else { return }
        let size = panel.contentView?.fittingSize ?? CGSize(width: 340, height: 120)
        let width = min(380, max(240, size.width)), height = max(56, size.height)
        // Beside the box (right, else left), kept inside the game window.
        let box = lastBox ?? CGRect(x: frame.midX, y: frame.midY, width: 1, height: 1)
        var x = box.maxX + 12
        if x + width > frame.maxX - 8 { x = box.minX - 12 - width }
        x = max(frame.minX + 8, min(x, frame.maxX - width - 8))
        var y = box.maxY - height
        y = max(frame.minY + 8, min(y, frame.maxY - height - 40))
        panel.setFrame(CGRect(x: x, y: y, width: width, height: height), display: true)
        panel.orderFrontRegardless()
        hideTask?.cancel()
        hideTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            self?.cardPanel?.orderOut(nil)
            if self?.state.waiting == true { self?.state.waiting = false }
        }
        // Grow or shrink once the content is laid out.
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self, let panel = self.cardPanel, let fit = panel.contentView?.fittingSize, abs(fit.height - panel.frame.height) > 2 else { return }
                var f = panel.frame
                f.origin.y += f.height - fit.height
                f.size.height = fit.height
                f.origin.y = max(frame.minY + 8, f.origin.y)
                panel.setFrame(f, display: true)
            }
        }
    }

    /// The game window's frame in AppKit screen coordinates.
    static func gameFrame(_ id: CGWindowID?) -> CGRect? {
        guard let id, let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]], let window = info.first,
              let bounds = window[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: bounds),
              let primary = NSScreen.screens.first?.frame else { return nil }
        return CGRect(x: rect.minX, y: primary.height - rect.maxY, width: rect.width, height: rect.height)
    }
}

/// A borderless panel that takes the keyboard (for Esc) without activating the app.
private final class MarkPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// The marking layer: the game dimmed, the box you drag shown clear with a blue outline.
private final class MarkView: NSView {
    var onDone: ((CGRect?) -> Void)?
    private var start: CGPoint?
    private var current: CGRect?

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        start = convert(event.locationInWindow, from: nil)
        current = nil
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start else { return }
        let p = convert(event.locationInWindow, from: nil)
        current = CGRect(x: min(start.x, p.x), y: min(start.y, p.y), width: abs(p.x - start.x), height: abs(p.y - start.y))
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        guard let start else { return }
        var rect = current ?? .zero
        if rect.width < 12 || rect.height < 12 {
            // A click: the area around it (about a character's size and its surroundings).
            let w = bounds.width * 0.22, h = bounds.height * 0.3
            rect = CGRect(x: start.x - w / 2, y: start.y - h / 2, width: w, height: h).intersection(bounds)
        }
        onDone?(rect)
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == UInt16(kVK_Escape) { onDone?(nil) } else { super.keyDown(with: event) }
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.35).setFill()
        bounds.fill()
        if let current {
            NSGraphicsContext.current?.compositingOperation = .clear
            current.fill()
            NSGraphicsContext.current?.compositingOperation = .sourceOver
            let path = NSBezierPath(roundedRect: current, xRadius: 6, yRadius: 6)
            path.lineWidth = 3
            NSColor(red: 0.2, green: 0.55, blue: 1, alpha: 1).setStroke()
            path.stroke()
        }
        let text = "Drag a box around what you want to know · click for the area around a spot · Esc cancels"
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 15, weight: .semibold), .foregroundColor: NSColor.white]
        let size = (text as NSString).size(withAttributes: attrs)
        let pill = CGRect(x: bounds.midX - size.width / 2 - 16, y: bounds.maxY - 90, width: size.width + 32, height: size.height + 16)
        NSColor.black.withAlphaComponent(0.7).setFill()
        NSBezierPath(roundedRect: pill, xRadius: pill.height / 2, yRadius: pill.height / 2).fill()
        (text as NSString).draw(at: CGPoint(x: pill.minX + 16, y: pill.minY + 8), withAttributes: attrs)
    }
}

/// The card next to the marked box: what was found, each with its picture and a line or two.
private struct LookCardView: View {
    let state: LookState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if state.waiting { ProgressView().controlSize(.small).tint(.white) }
                Text(state.card?.title.isEmpty == false ? state.card!.title : state.message.isEmpty ? "Look" : state.message)
                    .font(.system(size: 13, weight: .semibold)).lineLimit(2)
            }
            if let card = state.card {
                ForEach(Array(card.items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: 10) {
                        LookIcon(url: URL(string: item.icon), name: item.name)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.name + (item.count > 1 ? " ×\(item.count)" : "")).font(.system(size: 14, weight: .bold)).lineLimit(1)
                            if !item.detail.isEmpty { Text(item.detail).font(.system(size: 12)).foregroundStyle(.white.opacity(0.85)).lineLimit(2) }
                            if !item.extra.isEmpty {
                                Text(item.extra).font(.system(size: 12, weight: .medium)).foregroundStyle(Color(red: 1, green: 0.84, blue: 0.31)).lineLimit(2)
                            }
                        }
                    }
                }
                if !card.note.isEmpty && !card.items.isEmpty {
                    Text(card.note).font(.system(size: 11)).foregroundStyle(.white.opacity(0.65)).lineLimit(2)
                }
            }
        }
        .foregroundStyle(.white)
        .padding(14)
        .frame(width: 340, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.black.opacity(0.8)))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.white.opacity(0.18), lineWidth: 1))
    }
}

private struct LookIcon: View {
    let url: URL?
    let name: String

    var body: some View {
        Group {
            if let url {
                AsyncImage(url: url) { phase in
                    if let image = phase.image { image.resizable().interpolation(.none).scaledToFit() } else { letter }
                }
            } else { letter }
        }
        .frame(width: 36, height: 36)
    }

    private var letter: some View {
        Text(String(name.prefix(1))).font(.system(size: 14, weight: .bold)).frame(width: 32, height: 32)
            .background(Circle().fill(Color.white.opacity(0.18)))
    }
}
