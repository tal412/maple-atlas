import AppKit
import Foundation
import Observation
import os

/// Which build of the website the phone should open.
enum SiteOption: String, CaseIterable, Identifiable {
    case dev
    case main

    var id: String { rawValue }
    var title: String { self == .dev ? "Dev" : "Main" }
    var url: String {
        switch self {
        case .dev: "https://tal412.github.io/maple-atlas/dev/"
        case .main: "https://tal412.github.io/maple-atlas/"
        }
    }
}

enum EngineStatus: Equatable {
    case waitingForHelper
    case loading(String)
    case ready(mapCount: Int)
    case failed(String)
}

struct ConfirmedMap: Equatable {
    let id: String
    let name: String
    let inliers: Int?
    let confidence: Int?
    let kind: String?
    let at: Date
}

/// All app state. Owns the helper process, the engine web view and the tracking loop.
@MainActor
@Observable
final class CompanionModel {
    // MARK: Phone
    private(set) var phase = "idle"
    private(set) var phaseMessage = "Starting the connection helper…"
    private(set) var pairing: PairingCode?
    private(set) var qrImage: CGImage?
    private(set) var helperProblem: String?
    /// A phone is paired and reconnects by itself; the QR is hidden.
    private(set) var hasPairedPhone = false
    var lastError: String?

    // MARK: Game window
    /// Name of the window chosen in the system picker, if one is being read.
    private(set) var gameWindowLabel: String?
    private(set) var captureProblem: String?
    /// In-memory thumbnail of the selected window; never written to disk.
    private(set) var previewImage: CGImage?
    private(set) var minimapRect = CompanionModel.defaultMinimapRect

    // MARK: Tracking
    private(set) var engineStatus = EngineStatus.waitingForHelper
    private(set) var isTracking = false
    private(set) var readingText = "Not tracking"
    private(set) var lastConfirmed: ConfirmedMap?
    /// Latest player position on the confirmed map, in the portal data's coordinates.
    private(set) var lastPosition: EngineReading.Position? {
        didSet { refreshOverlay() }
    }
    /// The phone's route on the map you are on, for the overlay on the game window.
    /// Quests pinned on the phone, drawn in one row on the game window.
    private(set) var pins: [PinnedQuest] = [] {
        didSet { refreshOverlay() }
    }
    private(set) var nav: NavInfo? {
        didSet { refreshOverlay() }
    }
    /// Show the navigation card on top of the game window during a route.
    var showOverlay = UserDefaults.standard.object(forKey: "showOverlay") as? Bool ?? true {
        didSet { UserDefaults.standard.set(showOverlay, forKey: "showOverlay"); refreshOverlay() }
    }
    @ObservationIgnored private lazy var overlay: OverlayController = {
        let o = OverlayController()
        o.onReason = { [weak self] reason in self?.log("Overlay: \(reason)") }
        return o
    }()

    private func refreshOverlay() {
        let why = !showOverlay ? "off in Settings" : !isTracking ? "hidden · not tracking" : !isPhoneConnected ? "hidden · phone not connected" : nav == nil ? "hidden · no route on the phone" : nil
        overlay.update(nav: isPhoneConnected ? nav : nil, pins: isPhoneConnected ? pins : [], position: lastPosition, onMap: lastConfirmed?.id,
                       windowID: capture.windowID, enabled: showOverlay && isTracking, why: why)
    }
    /// What the game's Quest Helper panel showed at the last read.
    private(set) var questSummary = "Not read yet"

    // MARK: Diagnostics
    private(set) var logLines: [String] = []

    var site: SiteOption {
        didSet {
            guard site != oldValue else { return }
            UserDefaults.standard.set(site.rawValue, forKey: Keys.site)
            restartHelper()
        }
    }

    @ObservationIgnored let engine = EngineHost()
    @ObservationIgnored let updater = Updater()
    @ObservationIgnored let capture = GameCapture()
    @ObservationIgnored private var regionKey = "default"
    @ObservationIgnored private var helper: HelperProcess?
    @ObservationIgnored private var helperGeneration = 0
    @ObservationIgnored private var engineLoad: Task<Void, Never>?
    @ObservationIgnored private var trackingTask: Task<Void, Never>?
    @ObservationIgnored private var trackingActivity: NSObjectProtocol?
    @ObservationIgnored private var lastSearchingSent: Date?
    @ObservationIgnored private var previewTask: Task<Void, Never>?
    @ObservationIgnored private var positionTask: Task<Void, Never>?
    @ObservationIgnored private var questTask: Task<Void, Never>?
    @ObservationIgnored private var questsSentAt: Date?
    @ObservationIgnored private var noMatchSince = Date.now
    @ObservationIgnored private let logger = Logger(subsystem: "io.github.tal412.maple-atlas-companion", category: "app")

    private enum Keys {
        static let site = "site"
        static let minimapRects = "minimapRects"
        static let questRects = "questRects"
    }

    init() {
        // The phone always opens the main site (the dev preview is no longer offered).
        site = .main
        UserDefaults.standard.removeObject(forKey: Keys.site)
        engine.onProgress = { [weak self] message in
            guard let self else { return }
            if case .ready = self.engineStatus { return }
            self.engineStatus = .loading(message)
        }
        engine.onConsole = { [weak self] message in self?.log("engine: \(message)") }
        capture.onSelected = { [weak self] label, key in
            guard let self else { return }
            self.gameWindowLabel = label
            self.captureProblem = nil
            self.regionKey = key
            self.minimapRect = Self.storedMinimapRect(for: key) ?? Self.defaultMinimapRect
            let quest = Self.storedRect(for: key, in: Keys.questRects)
            self.questRect = quest ?? Self.defaultQuestRect
            self.questMarked = quest != nil
            self.previewImage = nil
            self.log("Reading window: \(label)")
            self.wideRect = nil
            self.autoMinimapRect = nil
            self.fittedMinimapRect = nil
            self.autoQuestRect = nil
            self.panelsTriedAt = .distantPast
            self.stoppedByPlayer = false
            if self.isTracking { self.runTrackingLoop() }
        }
        capture.onStopped = { [weak self] message in
            guard let self else { return }
            self.gameWindowLabel = nil
            self.previewImage = nil
            self.captureProblem = message
            self.stopTracking()
            self.log(message)
        }
        engine.onCrash = { [weak self] in
            guard let self, let url = self.engine.loadedURL else { return }
            self.log("Engine web process stopped; reloading.")
            self.loadEngine(url, force: true)
        }
    }

    var isPhoneConnected: Bool { phase == "connected" }
    var isHelperRunning: Bool { helper?.isRunning == true }

    var phaseTitle: String {
        switch phase {
        case "idle": "Not paired"
        case "waiting": hasPairedPhone ? "Paired · waiting for your phone" : "Waiting for your phone"
        case "connecting": "Connecting…"
        case "verifying": "Verifying…"
        case "connected": "Connected to phone"
        case "reconnecting": hasPairedPhone ? "Phone away" : "Connection interrupted"
        case "disconnected": "Disconnected"
        case "failed": "Connection failed"
        case "expired": "Code expired"
        default: phase.capitalized
        }
    }

    var hasGameWindow: Bool { gameWindowLabel != nil }

    // MARK: Lifecycle

    func start() {
        updater.start()
        launchHelper()
        startPreviewLoop()
        startAutoLoop()
    }

    /// Whether the game window can be found without the picker (Screen Recording allowed).
    private(set) var canFindWindow = GameCapture.canListWindows
    @ObservationIgnored private var autoTask: Task<Void, Never>?
    /// The player pressed Stop: tracking is not restarted by itself until a window is chosen
    /// or found again, or Start is pressed.
    @ObservationIgnored private var stoppedByPlayer = false
    /// The window being read was found automatically (not chosen in the picker).
    @ObservationIgnored private var autoPicked = false
    @ObservationIgnored private var windowsLoggedAt = Date.distantPast

    /// Every 2 s: finds the MapleStory window when none is being read, and starts tracking
    /// as soon as there is a window and the engine is ready.
    private func startAutoLoop() {
        if !canFindWindow { _ = CGRequestScreenCaptureAccess() }   // macOS asks once
        log(canFindWindow ? "Screen Recording allowed · looking for the MapleStory window"
            : "Screen Recording not allowed · choose the game window, or allow it in System Settings and reopen the app")
        autoTask?.cancel()
        autoTask = Task {
            while !Task.isCancelled {
                let allowed = GameCapture.canListWindows
                if allowed != canFindWindow { log(allowed ? "Screen Recording now allowed" : "Screen Recording no longer allowed") }
                canFindWindow = allowed
                if canFindWindow, autoPicked, capture.isReadingNonGame {
                    log("The window being read is not the game; looking for the game again")
                    stopTracking()
                    capture.stop()
                    gameWindowLabel = nil
                }
                if canFindWindow, autoPicked, let change = await capture.recheckPickedWindow() {
                    log(change)
                }
                if canFindWindow, !capture.isCapturing, Date.now.timeIntervalSince(windowsLoggedAt) > 30 {
                    windowsLoggedAt = .now
                    log("Looking for the game · " + (await capture.describeMapleWindows()))
                }
                if canFindWindow, !capture.isCapturing, await capture.findGameWindow() {
                    autoPicked = true
                    stoppedByPlayer = false
                    log("Found the game window by itself")
                }
                if hasGameWindow, case .ready = engineStatus, !isTracking, !stoppedByPlayer { startTracking() }
                await findPanelsIfDue()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    /// Stop pressed in the window.
    func stopTrackingByPlayer() {
        stoppedByPlayer = true
        stopTracking()
    }

    func openScreenRecordingSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Called from `applicationWillTerminate`: stop, close stdin, terminate.
    func shutdown() {
        autoTask?.cancel()
        trackingTask?.cancel()
        previewTask?.cancel()
        positionTask?.cancel()
        questTask?.cancel()
        capture.stop()
        helper?.shutdown()
        helper = nil
    }

    func restartHelper() {
        helperGeneration += 1 // Ignore the old process's remaining output and exit.
        helper?.shutdown()
        helper = nil
        pairing = nil
        qrImage = nil
        phase = "idle"
        phaseMessage = "Restarting the connection helper…"
        launchHelper()
    }

    private func launchHelper() {
        helperProblem = nil
        let paths = Self.helperPaths()
        log("Starting helper: \(paths.executable.path) (site \(site.url))")
        helperGeneration += 1
        let generation = helperGeneration
        do {
            let process = try HelperProcess(
                executable: paths.executable,
                arguments: ["--engine-dir", paths.engineDir.path, "--site", site.url, "--state-dir", Self.stateDirectory(for: site).path],
                onEvent: { [weak self] event in
                    guard let self, self.helperGeneration == generation else { return }
                    self.handle(event)
                },
                onStderr: { [weak self] line in self?.log("helper: \(line)") },
                onExit: { [weak self] status in
                    guard let self, self.helperGeneration == generation else { return }
                    self.helper = nil
                    self.helperProblem = "The connection helper stopped (status \(status))."
                    self.phase = "failed"
                    self.phaseMessage = "Restart the helper to pair again."
                    self.pairing = nil
                    self.qrImage = nil
                    self.log("Helper exited with status \(status).")
                })
            helper = process
            helper?.send(.start)
        } catch {
            helperProblem = error.localizedDescription
            phase = "failed"
            phaseMessage = "The phone link can't start without its helper."
            log("Helper launch failed: \(error.localizedDescription)")
        }
    }

    /// The helper lives next to our executable; env vars let a dev build point elsewhere.
    private static func helperPaths() -> (executable: URL, engineDir: URL) {
        let env = ProcessInfo.processInfo.environment
        let executable = env["MAPLE_LINK_PATH"].map(URL.init(fileURLWithPath:))
            ?? Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/maple-link")
        let engineDir = env["MAPLE_ENGINE_DIR"].map(URL.init(fileURLWithPath:))
            ?? (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("engine")
        return (executable, engineDir)
    }

    private func handle(_ event: HelperEvent) {
        switch event {
        case .engine(let url):
            log("Engine at \(url.absoluteString)")
            loadEngine(url)
        case .code(let code):
            pairing = code
            qrImage = QRCode.image(for: code.link)
            hasPairedPhone = false
            log("New pairing code \(code.code)")
        case .paired(let addresses):
            pairing = nil
            qrImage = nil
            hasPairedPhone = true
            log("Using the saved phone pairing (\(addresses.joined(separator: ", ")))")
        case .state(let newPhase, let message):
            if newPhase != phase { log("Phone link: \(newPhase)" + (message.isEmpty ? "" : " · \(message)")) }
            let wasConnected = isPhoneConnected
            phase = newPhase
            phaseMessage = message
            if newPhase == "connected" { hasPairedPhone = true; questsSentAt = nil }
            if !["waiting", "connecting", "verifying"].contains(newPhase) {
                // The QR is only useful while a code is pending.
                pairing = nil
                qrImage = nil
            }
            if isPhoneConnected != wasConnected { refreshOverlay() }
            if isPhoneConnected && !wasConnected {
                lastSearchingSent = nil
                if !isTracking { helper?.send(.tracking(state: "paused")) }
            }
        case .log(let message):
            log("helper: \(message)")
        case .error(let message):
            lastError = message
            log("helper error: \(message)")
        case .nav(let info):
            if info?.map != nav?.map || info?.step != nav?.step || info?.target.kind != nav?.target.kind || (info == nil) != (nav == nil) {
                log(info.map { "Route from phone: step \($0.step) of \($0.steps) on map \($0.map) · \($0.target.kind) · \($0.target.label)" } ?? "Route from phone: none")
            }
            if info != nav { nav = info }
        case .pins(let quests):
            if quests.map(\.title) != pins.map(\.title) {
                log("Pinned on the phone: " + (quests.isEmpty ? "none" : quests.map(\.title).joined(separator: ", ")))
            }
            if quests != pins { pins = quests }
        }
    }

    // MARK: Phone actions

    /// Shows a fresh code: a new one for an unpaired Mac, or, when a phone is
    /// paired, a code for a different phone (the old pairing is forgotten).
    func newCode() {
        if helper == nil { launchHelper(); return }
        hasPairedPhone = false
        helper?.send(.pair)
    }

    /// Where the helper keeps the phone pairing, separately for the Main and Dev sites.
    private static func stateDirectory(for site: SiteOption) -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("Maple Atlas Companion/\(site.rawValue)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return dir
    }

    func disconnect() {
        helper?.send(.stop)
    }

    // MARK: Engine

    func reloadEngine() {
        guard let url = engine.loadedURL else { return }
        loadEngine(url, force: true)
    }

    private func loadEngine(_ url: URL, force: Bool = false) {
        guard force || url != engine.loadedURL else { return }
        engineLoad?.cancel()
        engineStatus = .loading("Loading the map index…")
        engineLoad = Task {
            do {
                try await engine.load(url)
                let count = try await engine.ready()
                guard !Task.isCancelled else { return }
                engineStatus = .ready(mapCount: count)
                QuestText.warmUp()
                log("Engine ready with \(count) maps.")
            } catch EngineHost.EngineError.superseded {
                return
            } catch {
                guard !Task.isCancelled else { return }
                engineStatus = .failed(error.localizedDescription)
                log("Engine failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: Game window

    /// Opens Apple's window picker. Choosing a window there needs no Screen Recording permission.
    func chooseGameWindow() {
        captureProblem = nil
        autoPicked = false
        capture.presentPicker()
    }

    // MARK: Minimap region

    /// A larger area read instead of the box when the minimap was found running past it
    /// (cleared when the box changes or another window is read).
    @ObservationIgnored private var wideRect: CGRect?
    private var readRect: CGRect { wideRect ?? fittedMinimapRect ?? autoMinimapRect ?? minimapRect }
    /// The found box fitted to the minimap window's real edges. The window's size changes with
    /// the map, so it is dropped on every new map and whenever a read fails (the generous found
    /// box is read again and fitted anew).
    @ObservationIgnored private var fittedMinimapRect: CGRect?
    @ObservationIgnored private var fittedForMap: String?

    // MARK: Finding the panels

    /// Where the game's minimap window and Quest Helper were found (normalized), from text read
    /// over the whole game window; nil until found. Used ahead of the boxes drawn by hand.
    private(set) var autoMinimapRect: CGRect?
    private(set) var autoQuestRect: CGRect?
    /// What the preview shows: the found boxes, else the ones drawn by hand.
    var shownMinimapRect: CGRect { fittedMinimapRect ?? autoMinimapRect ?? minimapRect }
    var shownQuestRect: CGRect { autoQuestRect ?? questRect }
    @ObservationIgnored private var panelsFoundAt = Date.distantPast
    /// A box drawn by hand this session wins over the found one.
    @ObservationIgnored private var minimapByHand = false
    @ObservationIgnored private var questByHand = false
    @ObservationIgnored private var panelsTriedAt = Date.distantPast
    @ObservationIgnored private var panelsBusy = false
    private(set) var panelsStatus = "Looking for the minimap and the Quest Helper…"

    /// Reads the whole window for the panels' titles: every 4 s until both are found, then
    /// every 30 s, and at once when a read lost its panel.
    private func findPanelsIfDue(force: Bool = false) async {
        guard !panelsBusy, capture.isCapturing, case .ready = engineStatus else { return }
        let missing = (autoMinimapRect == nil && !minimapByHand) || (autoQuestRect == nil && !questByHand)
        let due = force ? Date.now.timeIntervalSince(panelsTriedAt) > 3
            : Date.now.timeIntervalSince(panelsTriedAt) > (missing ? 4 : 30)
        guard due else { return }
        panelsBusy = true
        panelsTriedAt = .now
        defer { panelsBusy = false }
        let capture = self.capture
        guard let read = try? await Task.detached(operation: { () -> (CGImage, [QuestText.Line]) in
            let image = try capture.wholeWindowCGImage()
            return (image, QuestText.recognize(image))
        }).value else { return }
        saveFrameSnapshotIfAsked(image: read.0, lines: read.1)
        let found = await engine.findPanels(lines: read.1, width: read.0.width, height: read.0.height)
        var changes: [String] = []
        let moved = { (a: CGRect?, b: CGRect) in a.map { abs($0.minX - b.minX) > 0.01 || abs($0.minY - b.minY) > 0.01 || abs($0.width - b.width) > 0.02 } ?? true }
        // The minimap box is fitted to the window after it is found: a rescan replaces it only
        // when the window's title bar has moved.
        let titleMoved = { (a: CGRect?, b: CGRect) in a.map { abs($0.minX - b.minX) > 0.015 || abs($0.minY - b.minY) > 0.02 } ?? true }
        if let m = found.minimap, !minimapByHand, titleMoved(autoMinimapRect, m) {
            autoMinimapRect = m
            fittedMinimapRect = nil
            wideRect = nil
            noMatchSince = .now
            changes.append("minimap at \(Self.describe(m))")
        }
        if let q = found.quest, !questByHand, moved(autoQuestRect, q) {
            autoQuestRect = q
            changes.append("Quest Helper at \(Self.describe(q))")
        }
        if found.minimap != nil || found.quest != nil { panelsFoundAt = .now }
        panelsStatus = [autoMinimapRect == nil ? "Minimap not found yet (keep it open)" : "Minimap found",
                        autoQuestRect == nil ? "Quest Helper not found yet (keep it open)" : "Quest Helper found"].joined(separator: " · ")
        if !changes.isEmpty { log("Found the " + changes.joined(separator: " and ")) }
    }

    /// Fits the found minimap box to the window's real edges, which the reader reported inside
    /// the area it read (region).
    private func fitMinimapBox(_ box: EngineReading.Box?, in region: CGRect) {
        guard let box, autoMinimapRect != nil, wideRect == nil, box.w > 0.05, box.h > 0.05 else { return }
        // Fitted only from the generous box (or a fitted one that still holds the window whole).
        let m = 0.012
        let fitted = CGRect(x: region.minX + box.x * region.width - m, y: region.minY + box.y * region.height - m,
                            width: box.w * region.width + 2 * m, height: box.h * region.height + 2 * m)
            .intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
        let current = fittedMinimapRect ?? autoMinimapRect!
        guard !fitted.isNull,
              abs(fitted.minX - current.minX) > 0.008 || abs(fitted.minY - current.minY) > 0.008 || abs(fitted.width - current.width) > 0.015 || abs(fitted.height - current.height) > 0.015
        else { return }
        fittedMinimapRect = fitted
        fittedForMap = lastConfirmed?.id
        log("Fitted the minimap box to the window: \(Self.describe(fitted))")
    }

    /// Back to the generous found box (the minimap window may have grown or moved).
    private func unfitMinimapBox(_ why: String) {
        guard fittedMinimapRect != nil else { return }
        fittedMinimapRect = nil
        log("Reading the whole found minimap area again (\(why))")
    }

    private static func describe(_ r: CGRect) -> String {
        String(format: "%.0f%%,%.0f%% %.0f%%×%.0f%%", r.minX * 100, r.minY * 100, r.width * 100, r.height * 100)
    }

    /// The debug-frame flag file saves the next whole window and the text read on it.
    private func saveFrameSnapshotIfAsked(image: CGImage, lines: [QuestText.Line]) {
        let dir = Self.stateDirectory(for: site), flag = dir.appendingPathComponent("debug-frame")
        guard FileManager.default.fileExists(atPath: flag.path) else { return }
        try? FileManager.default.removeItem(at: flag)
        guard let png = try? GameCapture.pngDataURL(from: image), let comma = png.firstIndex(of: ","),
              let data = Data(base64Encoded: String(png[png.index(after: comma)...])) else { return }
        try? data.write(to: dir.appendingPathComponent("frame-snapshot.png"))
        let text = lines.map { String(format: "%@\t%.0f\t%.0f\t%.0f\t%.0f\t%.2f", $0.text, $0.box.minX, $0.box.minY, $0.box.width, $0.box.height, $0.confidence) }.joined(separator: "\n")
        try? Data(text.utf8).write(to: dir.appendingPathComponent("frame-snapshot.txt"))
        log("Saved a whole-window snapshot (frame-snapshot.png, \(image.width)×\(image.height), \(lines.count) text lines)")
    }

    /// MapleStory draws its minimap in the top-left corner.
    static let defaultMinimapRect = CGRect(x: 0, y: 0, width: 0.4, height: 0.4)

    /// Sets the normalized (top-left origin) region that is sent to the engine.
    func setMinimapRect(_ rect: CGRect) {
        let unit = CGRect(x: 0, y: 0, width: 1, height: 1)
        let clamped = rect.standardized.intersection(unit)
        guard !clamped.isNull, clamped.width >= 0.02, clamped.height >= 0.02, clamped != minimapRect else { return }
        minimapRect = clamped
        Self.storeMinimapRect(clamped, for: regionKey)
        // Drawn by hand: it replaces the found box for this session.
        minimapByHand = true
        autoMinimapRect = nil
        fittedMinimapRect = nil
        regionChanged()
    }

    func resetMinimapRect() {
        setMinimapRect(Self.defaultMinimapRect)
        minimapByHand = false
        panelsTriedAt = .distantPast
    }

    var isDefaultMinimapRect: Bool { minimapRect == Self.defaultMinimapRect }

    private func regionChanged() {
        wideRect = nil
        noMatchSince = .now
        if isTracking { Task { await engine.reset() } }
    }

    private static func storedMinimapRect(for key: String) -> CGRect? { storedRect(for: key, in: Keys.minimapRects) }
    private static func storeMinimapRect(_ rect: CGRect, for key: String) { storeRect(rect, for: key, in: Keys.minimapRects) }

    private static func storedRect(for key: String, in store: String) -> CGRect? {
        let all = UserDefaults.standard.dictionary(forKey: store) as? [String: [Double]]
        guard let values = all?[key], values.count == 4 else { return nil }
        return CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
    }

    private static func storeRect(_ rect: CGRect?, for key: String, in store: String) {
        var all = (UserDefaults.standard.dictionary(forKey: store) as? [String: [Double]]) ?? [:]
        all[key] = rect.map { [$0.minX, $0.minY, $0.width, $0.height].map { Double($0) } }
        UserDefaults.standard.set(all, forKey: store)
    }

    // MARK: Quest Helper region

    /// Where the game puts the Quest Helper: the top-right part of the window.
    static let defaultQuestRect = CGRect(x: 0.55, y: 0, width: 0.45, height: 0.5)
    /// The area read for the Quest Helper (normalized, top-left origin).
    private(set) var questRect = CompanionModel.defaultQuestRect
    /// True when the player drew the box: the engine then reads it even when it cannot find the
    /// panel by its colours.
    private(set) var questMarked = false

    func setQuestRect(_ rect: CGRect) {
        let clamped = rect.standardized.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
        guard !clamped.isNull, clamped.width >= 0.03, clamped.height >= 0.03 else { return }
        questRect = clamped
        questMarked = true
        questByHand = true
        autoQuestRect = nil
        Self.storeRect(clamped, for: regionKey, in: Keys.questRects)
    }

    func resetQuestRect() {
        questRect = Self.defaultQuestRect
        questMarked = false
        questByHand = false
        panelsTriedAt = .distantPast
        Self.storeRect(nil, for: regionKey, in: Keys.questRects)
    }

    // MARK: Preview

    /// Refreshes the preview once a second while not tracking (the tracking loop updates it otherwise).
    private func startPreviewLoop() {
        previewTask?.cancel()
        previewTask = Task {
            while !Task.isCancelled {
                if !isTracking, capture.isCapturing {
                    let capture = self.capture, region = minimapRect
                    let frame = await Task.detached { try? capture.frame(region: region, previewOnly: true) }.value
                    if !isTracking, let frame { previewImage = frame.preview }
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    // MARK: Tracking

    /// How long the map name can go unread before the status explains how to show it.
    private static let noMatchHint: TimeInterval = 12

    func startTracking() {
        guard !isTracking, hasGameWindow else { return }
        isTracking = true
        readingText = "Reading the map name…"
        refreshOverlay()
        // Keep App Nap from stretching the capture interval while the game is in front.
        trackingActivity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiatedAllowingIdleSystemSleep], reason: "Tracking the game window")
        runTrackingLoop()
    }

    func stopTracking() {
        guard isTracking else { return }
        trackingTask?.cancel()
        trackingTask = nil
        positionTask?.cancel()
        positionTask = nil
        questTask?.cancel()
        questTask = nil
        isTracking = false
        refreshOverlay()
        readingText = "Not tracking"
        if let activity = trackingActivity {
            ProcessInfo.processInfo.endActivity(activity)
            trackingActivity = nil
        }
        helper?.send(.tracking(state: "paused"))
    }

    /// Map recognition runs every 1.5 s; between those reads the dot alone is located
    /// about five times a second on the confirmed map, so the phone follows smoothly.
    private func runPositionLoop() {
        positionTask?.cancel()
        positionTask = Task {
            while !Task.isCancelled {
                let deadline = ContinuousClock.now + .milliseconds(200)
                await locateOnce()
                try? await Task.sleep(until: deadline, clock: .continuous)
            }
        }
    }

    private func locateOnce() async {
        guard isTracking, case .ready = engineStatus, let map = lastConfirmed,
              Date.now.timeIntervalSince(map.at) < 10 else { return }
        let capture = self.capture, region = readRect
        guard let frame = try? await Task.detached(operation: { try capture.frame(region: region, previewOnly: false) }).value,
              let png = frame.minimapImage,
              let located = try? await engine.locate(png, frameHeight: frame.frameHeight, mapID: map.id),
              !Task.isCancelled, isTracking, lastConfirmed?.id == map.id
        else { return }
        // The log says how the dot was placed, or why it was not, each time that changes.
        fitMinimapBox(located.box, in: region)
        let note = located.position != nil ? "found (\(located.method ?? "?"))" : (located.positionNote ?? "not found")
        if note != positionNoteLogged.note || map.id != positionNoteLogged.map {
            positionNoteLogged = (map.id, note)
            log("Position on map \(map.id): \(note)")
        }
        saveMinimapSnapshotIfAsked(png: png, note: "map \(map.id): \(note)")
        if located.positionNote?.hasPrefix("no-minimap") == true || located.positionNote?.hasPrefix("collapsed") == true || located.positionNote?.contains("shape") == true {
            unfitMinimapBox("the minimap did not fit")
            Task { await findPanelsIfDue(force: true) }
        }
        // The minimap runs past its box (a big map, zoomed in): read a larger area from the game
        // window's top-left corner, where the game keeps the minimap, from now on.
        if located.positionNote?.hasPrefix("collapsed") == true, wideRect == nil {
            wideRect = CGRect(x: 0, y: 0, width: max(minimapRect.maxX, 0.7), height: max(minimapRect.maxY, 0.85))
            log("The minimap is bigger than its box; reading a larger area of the window")
        }
        guard let found = located.position else { return }
        lastPosition = found
        if isPhoneConnected {
            helper?.send(.position(id: map.id, x: Int(found.x.rounded()), y: Int(found.y.rounded()), observedAt: .now))
        }
    }

    /// The Quest Helper panel is read every 3 s (the engine skips an unchanged panel);
    /// the phone gets the list when it changes, and again every 15 s.
    private func runQuestLoop() {
        questTask?.cancel()
        questsSentAt = nil
        questTask = Task {
            while !Task.isCancelled {
                let deadline = ContinuousClock.now + .seconds(3)
                await readQuestsOnce()
                try? await Task.sleep(until: deadline, clock: .continuous)
            }
        }
    }

    private func readQuestsOnce() async {
        guard isTracking, case .ready = engineStatus else { return }
        let capture = self.capture
        let region = autoQuestRect ?? questRect, marked = autoQuestRect != nil || questMarked
        // Apple's on-device text recognition reads the panel; the engine only parses it.
        guard let read = try? await Task.detached(operation: { () -> (CGImage, String?) in
            let image = try capture.questPanelCGImage(region: region)
            return (image, QuestText.panelText(image, marked: marked))
        }).value else { return }
        do {
            let reading = try await engine.questsFromText(read.1)
            saveQuestSnapshotIfAsked(image: read.0, text: reading.text)
            guard !Task.isCancelled, isTracking else { return }
            if !reading.visible { Task { await findPanelsIfDue(force: true) } }
            let summary = !reading.visible ? "Quest Helper not found · keep it open in the game"
                : reading.quests.isEmpty ? "Quest Helper open · no quests read"
                : "\(reading.quests.count) quest\(reading.quests.count == 1 ? "" : "s") tracked"
            if summary != questSummary || (reading.changed && reading.text != nil) {
                log("Quest Helper: \(summary)" + (reading.text.map { " · " + $0.replacingOccurrences(of: "\n", with: " | ") } ?? ""))
            }
            questSummary = summary
            let due = questsSentAt.map { Date.now.timeIntervalSince($0) >= 15 } ?? true
            if isPhoneConnected, reading.changed || due {
                helper?.send(.quests(visible: reading.visible, quests: reading.quests, observedAt: .now))
                questsSentAt = .now
            }
        } catch EngineHost.EngineError.busy {
            return
        } catch {
            if !Task.isCancelled { log("Quest Helper: \(error.localizedDescription)") }
        }
    }

    private func runTrackingLoop() {
        runPositionLoop()
        runQuestLoop()
        trackingTask?.cancel()
        lastSearchingSent = nil
        noMatchSince = .now
        trackingTask = Task {
            await engine.reset()
            while !Task.isCancelled {
                let deadline = ContinuousClock.now + .milliseconds(1500)
                await trackOnce()
                try? await Task.sleep(until: deadline, clock: .continuous)
            }
        }
    }

    private func trackOnce() async {
        guard case .ready = engineStatus else {
            if case .failed = engineStatus { readingText = "The map engine didn't load." }
            else { readingText = "Loading the map index…" }
            return
        }
        do {
            let capture = self.capture, region = readRect
            let frame = try await Task.detached { try capture.frame(region: region, previewOnly: false) }.value
            guard !Task.isCancelled else { return }
            previewImage = frame.preview
            guard let png = frame.minimapImage else { return }
            let reading = try await engine.read(png, frameHeight: frame.frameHeight)
            guard !Task.isCancelled else { return }
            apply(reading)
            fitMinimapBox(reading.box, in: region)
        } catch EngineHost.EngineError.busy {
            return
        } catch {
            guard !Task.isCancelled else { return }
            if readingText != error.localizedDescription {
                log("Tracking: \(error.localizedDescription)") // Once per distinct failure, not every tick.
            }
            readingText = error.localizedDescription
        }
    }

    @ObservationIgnored private var mapLogged = ""
    @ObservationIgnored private var mapLoggedAt = Date.distantPast

    /// The log says which map is read, or why none is, each time that changes (at most every 10 s
    /// for the same kind of miss).
    private func logMapReading(_ reading: EngineReading) {
        let line: String
        if reading.phase == "confirmed", let id = reading.id {
            line = "Map: \(reading.name ?? id) (\(id))" + (reading.position != nil ? " · dot found" : reading.positionNote.map { " · dot: \($0)" } ?? "")
        } else {
            line = "Map not read (\(reading.phase))" + (reading.name.map { " · \($0)?" } ?? "") + (reading.text.map { " · \($0.prefix(80))" } ?? "")
        }
        guard line != mapLogged, reading.phase == "confirmed" || Date.now.timeIntervalSince(mapLoggedAt) > 10 else { return }
        mapLogged = line
        mapLoggedAt = .now
        log(line)
    }

    private func apply(_ reading: EngineReading) {
        logMapReading(reading)
        if reading.phase == "confirmed", let id = reading.id, fittedForMap != nil, id != fittedForMap { unfitMinimapBox("new map") }
        if reading.phase != "confirmed", reading.phase != "candidate", Date.now.timeIntervalSince(noMatchSince) > 3 { unfitMinimapBox("map name not read") }
        if reading.phase == "confirmed", let id = reading.id {
            noMatchSince = .now
            let name = reading.name ?? id
            lastConfirmed = ConfirmedMap(
                id: id, name: name, inliers: reading.inliers, confidence: reading.confidence,
                kind: reading.kind, at: .now)
            lastPosition = reading.position
            let place = reading.position == nil ? "" : " · your dot found"
            readingText = (isPhoneConnected ? "Following on phone · " : "Map name · ") + name + place
            if isPhoneConnected {
                helper?.send(.location(id: id, confidence: reading.confidence ?? 0, observedAt: .now))
                if let position = reading.position {
                    helper?.send(.position(id: id, x: Int(position.x.rounded()), y: Int(position.y.rounded()), observedAt: .now))
                }
            }
            return
        }
        if reading.phase == "candidate" {
            noMatchSince = .now
            readingText = "Reading the map name…" + (reading.name.map { " · \($0)?" } ?? "")
        } else if Date.now.timeIntervalSince(noMatchSince) >= Self.noMatchHint {
            readingText = reading.text ?? "No map name found in the box. Press + on the in-game minimap so its name shows, and keep it inside the box."
        } else {
            readingText = "Reading the map name…"
        }
        if isPhoneConnected, lastSearchingSent.map({ Date.now.timeIntervalSince($0) >= 5 }) ?? true {
            helper?.send(.tracking(state: "searching"))
            lastSearchingSent = .now
        }
    }

    // MARK: Log

    func log(_ message: String) {
        logger.info("\(message, privacy: .public)")
        let stamp = Date.now.formatted(date: .omitted, time: .standard)
        logLines.append("\(stamp)  \(message)")
        if logLines.count > 1000 { logLines.removeFirst(logLines.count - 1000) }
        appendToLogFile("\(Date.now.ISO8601Format())  \(message)\n")
    }

    /// The Diagnostics lines are also kept in companion.log next to the pairing (cut back to
    /// the newest half when it passes 2 MB), so they survive a restart and can be sent.
    @ObservationIgnored private lazy var logFile = Self.stateDirectory(for: site).appendingPathComponent("companion.log")
    private func appendToLogFile(_ line: String) {
        let data = Data(line.utf8), url = logFile
        if let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? Int, size > 2_000_000,
           let old = try? Data(contentsOf: url) {
            try? old.suffix(1_000_000).write(to: url)
        }
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: url)
        }
    }

    /// When a file named "debug-snapshot" is in the app's folder, the next Quest Helper image and
    /// its reading are saved there (quest-snapshot.png, .txt) and the flag is removed.
    @ObservationIgnored private var positionNoteLogged: (map: String, note: String) = ("", "")

    /// The debug-minimap flag file saves the next minimap crop and what was read from it.
    private func saveMinimapSnapshotIfAsked(png: String, note: String) {
        let dir = Self.stateDirectory(for: site), flag = dir.appendingPathComponent("debug-minimap")
        guard FileManager.default.fileExists(atPath: flag.path) else { return }
        try? FileManager.default.removeItem(at: flag)
        if let comma = png.firstIndex(of: ","), let data = Data(base64Encoded: String(png[png.index(after: comma)...])) {
            try? data.write(to: dir.appendingPathComponent("minimap-snapshot.png"))
            try? Data(note.utf8).write(to: dir.appendingPathComponent("minimap-snapshot.txt"))
            log("Saved a minimap snapshot (minimap-snapshot.png) · \(note)")
        }
    }

    private func saveQuestSnapshotIfAsked(image: CGImage, text: String?) {
        let dir = Self.stateDirectory(for: site), flag = dir.appendingPathComponent("debug-snapshot")
        guard FileManager.default.fileExists(atPath: flag.path) else { return }
        try? FileManager.default.removeItem(at: flag)
        guard let png = try? GameCapture.pngDataURL(from: image) else { return }
        if let comma = png.firstIndex(of: ","), let data = Data(base64Encoded: String(png[png.index(after: comma)...])) {
            try? data.write(to: dir.appendingPathComponent("quest-snapshot.png"))
        }
        try? (text ?? "").write(to: dir.appendingPathComponent("quest-snapshot.txt"), atomically: true, encoding: .utf8)
        log("Saved a Quest Helper snapshot (quest-snapshot.png)")
    }

    func clearLog() { logLines.removeAll() }
}
