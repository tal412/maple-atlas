import AppKit

/// The Atlas button: a small round button on the game window's bottom-left corner (the free
/// space left of the chat bar) while the game is in front. A click opens a menu with what is
/// useful in play (Maple Atlas over the game, search, quests, directions, Look), so the game
/// never has to be left. It never takes the keyboard from the game.
@MainActor
final class AtlasButtonController {
    var windowID: () -> CGWindowID? = { nil }
    var enabled: () -> Bool = { true }
    /// The menu, made fresh at each click (its items follow the app's state).
    var menu: () -> NSMenu = { NSMenu() }

    private var panel: NSPanel?
    private var timer: Timer?
    static let size: CGFloat = 40

    func start() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.place() }
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.place(forceFront: true) }
        }
    }

    private func makePanel() -> NSPanel {
        let p = NSPanel(contentRect: CGRect(x: 0, y: 0, width: Self.size, height: Self.size), styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.level = .screenSaver
        p.hidesOnDeactivate = false
        p.becomesKeyOnlyIfNeeded = true
        p.isReleasedWhenClosed = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        let view = AtlasButtonView(frame: CGRect(x: 0, y: 0, width: Self.size, height: Self.size))
        view.onClick = { [weak self, weak view] in
            guard let self, let view else { return }
            self.menu().popUp(positioning: nil, at: CGPoint(x: 0, y: Self.size + 6), in: view)
        }
        p.contentView = view
        return p
    }

    private func place(forceFront: Bool = false) {
        guard enabled(), let frame = Self.frontGameFrame(windowID()) else { panel?.orderOut(nil); return }
        if panel == nil { panel = makePanel() }
        guard let panel else { return }
        let rect = CGRect(x: frame.minX + 12, y: frame.minY + 12, width: Self.size, height: Self.size)
        if panel.frame != rect { panel.setFrame(rect, display: true) }
        if forceFront || !panel.isVisible || !panel.isOnActiveSpace { panel.orderFrontRegardless() }
    }

    /// The game window's frame (AppKit screen coordinates) while it is on screen and the game or
    /// this app is in front; nil otherwise, so the button never floats over other apps.
    static func frontGameFrame(_ id: CGWindowID?) -> CGRect? {
        guard let id, let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]], let window = info.first,
              let bounds = window[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: bounds),
              let primary = NSScreen.screens.first?.frame, (window[kCGWindowIsOnscreen as String] as? Bool) != false else { return nil }
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        if let owner = window[kCGWindowOwnerPID as String] as? pid_t, let front, front != owner, front != ProcessInfo.processInfo.processIdentifier { return nil }
        return CGRect(x: rect.minX, y: primary.height - rect.maxY, width: rect.width, height: rect.height)
    }
}

/// The round button: the app's icon in a dark disc with a gold ring.
private final class AtlasButtonView: NSView {
    var onClick: (() -> Void)?
    private var hovering = false

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .cursorUpdate], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }
    override func cursorUpdate(with event: NSEvent) { NSCursor.pointingHand.set() }
    override func mouseUp(with event: NSEvent) {
        if bounds.contains(convert(event.locationInWindow, from: nil)) { onClick?() }
    }

    override func draw(_ dirtyRect: NSRect) {
        let disc = bounds.insetBy(dx: 1.5, dy: 1.5)
        let circle = NSBezierPath(ovalIn: disc)
        NSColor(calibratedRed: 0.09, green: 0.10, blue: 0.12, alpha: hovering ? 0.95 : 0.82).setFill()
        circle.fill()
        NSColor(calibratedRed: 0.94, green: 0.77, blue: 0.10, alpha: 1).setStroke()
        circle.lineWidth = 2
        circle.stroke()
        if let icon = NSApp.applicationIconImage {
            icon.draw(in: disc.insetBy(dx: 5, dy: 5), from: .zero, operation: .sourceOver, fraction: 1)
        }
    }
}

/// A menu item that runs a closure.
final class ActionItem: NSMenuItem {
    private let run: () -> Void
    init(_ title: String, key: String = "", modifiers: NSEvent.ModifierFlags = [], checked: Bool = false, _ run: @escaping () -> Void) {
        self.run = run
        super.init(title: title, action: #selector(fire), keyEquivalent: key)
        keyEquivalentModifierMask = modifiers
        target = self
        state = checked ? .on : .off
    }
    required init(coder: NSCoder) { fatalError("not used") }
    @objc private func fire() { run() }
}
