import AppKit
import Observation
import SwiftUI

/// What the overlay card shows.
@MainActor @Observable
final class OverlayState {
    var label = ""
    var hint = ""
    var step = ""
    var kind = "portal"
    /// Direction from your dot to the target, in radians (0 = right, y down); nil when unknown.
    var angle: Double?
    /// When the angle was last worked out from a fresh position.
    var angleAt: Date?
}

/// The pinned quests drawn in one row on the game window.
@Observable
final class PinsState {
    var quests: [PinnedQuest] = []
}

/// A click-through card on top of the game window during a route: an arrow from your dot to
/// the next portal (or the best hunting spot), what it is, the live hint and the step. It
/// follows the game window and hides when that window is not on screen.
@MainActor
final class OverlayController {
    private let state = OverlayState()
    private let pinsState = PinsState()
    private var panel: NSPanel?
    private var pinsPanel: NSPanel?
    private var showsCard = false
    private var timer: Timer?
    private var windowID: CGWindowID?
    /// Told when the card is shown or hidden for a new reason (for Diagnostics).
    var onReason: ((String) -> Void)?
    private var reason = ""
    private func report(_ text: String) { if text != reason { reason = text; onReason?(text) } }
    private static let size = CGSize(width: 460, height: 96)

    func update(nav: NavInfo?, pins: [PinnedQuest] = [], position: EngineReading.Position?, onMap: String?, windowID: CGWindowID?, enabled: Bool, why: String? = nil) {
        pinsState.quests = enabled ? pins : []
        guard enabled, nav != nil || !pins.isEmpty else { hide(); report(why ?? "hidden"); return }
        self.windowID = windowID
        showsCard = nav != nil
        guard let nav else { show(); return }
        state.kind = nav.target.kind
        state.label = nav.target.label
        state.hint = nav.hint.isEmpty ? (nav.live ? "" : "Waiting for your position on the minimap") : nav.hint
        state.step = "Step \(nav.step) of \(nav.steps)" + (nav.dest.isEmpty ? "" : " · to \(nav.dest)")
        if let p = position, onMap == nav.map, let tx = nav.target.x, let ty = nav.target.y {
            state.angle = atan2(ty - p.y, tx - p.x)
            state.angleAt = .now
        } else if let at = state.angleAt, Date.now.timeIntervalSince(at) < 6, onMap == nav.map {
            // A short miss (the dot hidden for a moment): keep pointing the last way.
        } else {
            state.angle = nil   // a spinner shows while your position is worked out
        }
        show()
    }

    func hide() {
        timer?.invalidate(); timer = nil
        panel?.orderOut(nil)
        pinsPanel?.orderOut(nil)
    }

    private static func makePanel<V: View>(_ view: V, size: CGSize) -> NSPanel {
        let p = NSPanel(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        // Above a game in full screen (its own Space): the overlay level, allowed in every
        // Space including full-screen ones, and brought forward again when the Space changes.
        p.level = .screenSaver
        p.ignoresMouseEvents = true
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        p.contentView = NSHostingView(rootView: view)
        return p
    }

    private func show() {
        if panel == nil {
            panel = Self.makePanel(OverlayCard(state: state), size: Self.size)
            pinsPanel = Self.makePanel(PinsRow(state: pinsState), size: CGSize(width: 600, height: Self.pinsHeight))
            NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.place(forceFront: true) }
            }
        }
        place()
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.place() }
            }
        }
    }

    static let pinsHeight: CGFloat = 52

    /// Top centre of the game window, just below its title bar: the pinned quests' row, then
    /// the route card under it.
    private func place(forceFront: Bool = false) {
        guard let panel, let pinsPanel else { return }
        guard let frame = gameFrame() else { panel.orderOut(nil); pinsPanel.orderOut(nil); return }
        report("shown on the game window at \(Int(frame.minX)),\(Int(frame.minY)) (\(Int(frame.width))×\(Int(frame.height)))")
        var top = frame.maxY - 48
        if pinsState.quests.isEmpty {
            pinsPanel.orderOut(nil)
        } else {
            let fitting = pinsPanel.contentView?.fittingSize.width ?? 400
            let width = min(max(160, fitting), frame.width - 40)
            pinsPanel.setFrame(CGRect(x: frame.midX - width / 2, y: top - Self.pinsHeight, width: width, height: Self.pinsHeight), display: true)
            if forceFront || !pinsPanel.isVisible || !pinsPanel.isOnActiveSpace { pinsPanel.orderFrontRegardless() }
            top -= Self.pinsHeight + 8
        }
        guard showsCard else { panel.orderOut(nil); return }
        let width = min(Self.size.width, max(240, frame.width - 40))
        let origin = CGPoint(x: frame.midX - width / 2, y: top - Self.size.height)
        panel.setFrame(CGRect(origin: origin, size: CGSize(width: width, height: Self.size.height)), display: true)
        if forceFront || !panel.isVisible || !panel.isOnActiveSpace { panel.orderFrontRegardless() }
    }

    /// The game window's frame in AppKit screen coordinates, or nil when it is not on screen.
    private func gameFrame() -> CGRect? {
        guard let id = windowID else { report("hidden · the game window's id is unknown (choose the window again)"); return nil }
        guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]], let window = info.first,
              let bounds = window[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds),
              let primary = NSScreen.screens.first?.frame
        else { report("hidden · the game window \(id) is not listed"); return nil }
        if (window[kCGWindowIsOnscreen as String] as? Bool) == false { report("hidden · the game window is not on screen"); return nil }
        // Only while the game (or this app) is in front, so the card never floats over other apps.
        let front = NSWorkspace.shared.frontmostApplication
        if let owner = window[kCGWindowOwnerPID as String] as? pid_t, let pid = front?.processIdentifier,
           pid != owner, pid != ProcessInfo.processInfo.processIdentifier {
            report("hidden · \(front?.localizedName ?? "another app") is in front, not the game")
            return nil
        }
        return CGRect(x: rect.minX, y: primary.height - rect.maxY, width: rect.width, height: rect.height)
    }
}

private struct OverlayCard: View {
    let state: OverlayState

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle().fill(Color(red: 0.04, green: 0.34, blue: 0.82))
                if state.kind == "arrived" {
                    Image(systemName: "flag.checkered").font(.system(size: 26, weight: .bold))
                } else if let angle = state.angle {
                    Image(systemName: "arrow.right").font(.system(size: 30, weight: .heavy)).rotationEffect(.radians(angle))
                } else {
                    ProgressView().controlSize(.regular).progressViewStyle(.circular).tint(.white)
                }
            }
            .frame(width: 60, height: 60)
            .foregroundStyle(.white)
            VStack(alignment: .leading, spacing: 3) {
                Text(state.label).font(.system(size: 15, weight: .semibold)).lineLimit(2)
                if !state.hint.isEmpty {
                    Text(state.hint).font(.system(size: 14, weight: .medium)).foregroundStyle(Color(red: 1, green: 0.84, blue: 0.31)).lineLimit(1)
                }
                Text(state.step).font(.system(size: 11)).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
            }
            .foregroundStyle(.white)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 18).fill(Color.black.opacity(0.74)))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.white.opacity(0.18), lineWidth: 1))
    }
}

/// The pinned quests in one row: each objective's picture and count (a check when done);
/// a thin divider between quests; a quest ready to turn in shows a flag.
private struct PinsRow: View {
    let state: PinsState

    var body: some View {
        HStack(spacing: 10) {
            ForEach(Array(state.quests.enumerated()), id: \.offset) { qi, quest in
                if qi > 0 { Rectangle().fill(Color.white.opacity(0.25)).frame(width: 1, height: 26) }
                if quest.ready {
                    Image(systemName: "flag.checkered").font(.system(size: 15, weight: .bold)).foregroundStyle(Color(red: 0.45, green: 0.9, blue: 0.55))
                        .help(quest.title)
                }
                ForEach(Array(quest.objectives.enumerated()), id: \.offset) { _, o in
                    let done = (o.have ?? 0) >= (o.need ?? Int.max)
                    HStack(spacing: 5) {
                        PinIcon(url: URL(string: o.icon), name: o.name)
                        Text(o.have.map(String.init) ?? "?").font(.system(size: 14, weight: .bold).monospacedDigit())
                            + Text("/\(o.need.map(String.init) ?? "?")").font(.system(size: 12, weight: .medium).monospacedDigit())
                        if done { Image(systemName: "checkmark.circle.fill").font(.system(size: 13)).foregroundStyle(Color(red: 0.45, green: 0.9, blue: 0.55)) }
                    }
                    .foregroundStyle(done ? Color.white.opacity(0.75) : Color.white)
                }
            }
        }
        .padding(.horizontal, 14)
        .frame(height: OverlayController.pinsHeight)
        .fixedSize(horizontal: true, vertical: false)
        .background(Capsule().fill(Color.black.opacity(0.72)))
        .overlay(Capsule().stroke(Color.white.opacity(0.18), lineWidth: 1))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// An objective's picture, loaded once and kept (falls back to the name's first letter).
private struct PinIcon: View {
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
        .frame(width: 30, height: 30)
    }

    private var letter: some View {
        Text(String(name.prefix(1))).font(.system(size: 13, weight: .bold)).frame(width: 26, height: 26)
            .background(Circle().fill(Color.white.opacity(0.18)))
    }
}
