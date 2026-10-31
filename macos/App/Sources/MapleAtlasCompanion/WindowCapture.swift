import CoreGraphics
import CoreImage
import CoreMedia
import Foundation
import ImageIO
@preconcurrency import ScreenCaptureKit
import UniformTypeIdentifiers

/// Captures the game window chosen in Apple's system window picker.
///
/// The picker grants access to the one window the user clicks, so the app needs no
/// Screen Recording permission and never triggers its prompt. The stream runs at a
/// low frame rate and only the latest frame is kept, in memory; nothing is written to disk.
@MainActor
final class GameCapture: NSObject {
    struct Frame: Sendable {
        let preview: CGImage
        /// The minimap crop as a PNG data URL (exact colors for the dot and portal rings).
        let minimapImage: String?
        /// Full window height in the crop's pixels, which sizes the minimap title strip.
        let frameHeight: Int
    }

    enum CaptureError: LocalizedError {
        case noFrameYet, encodingFailed

        var errorDescription: String? {
            switch self {
            case .noFrameYet: "Waiting for the first frame of the game window…"
            case .encodingFailed: "Couldn't encode the captured frame."
            }
        }
    }

    /// Called with a display label and a key for remembering the minimap box.
    var onSelected: ((_ label: String, _ key: String) -> Void)?
    /// Called when sharing ends (window closed, or stopped from the menu bar).
    var onStopped: ((_ message: String) -> Void)?

    private(set) var isCapturing = false
    /// The captured game window, for placing the navigation overlay on it.
    private(set) var windowID: CGWindowID?
    private var stream: SCStream?
    private let sink = FrameSink()
    private var observing = false

    nonisolated static let matchMaxSide: CGFloat = 960
    nonisolated static let previewMaxSide: CGFloat = 640

    /// Shows the system picker, limited to single windows.
    func presentPicker() {
        let picker = SCContentSharingPicker.shared
        var configuration = SCContentSharingPickerConfiguration()
        configuration.allowedPickerModes = [.singleWindow]
        if let own = Bundle.main.bundleIdentifier { configuration.excludedBundleIDs = [own] }
        picker.defaultConfiguration = configuration
        if !observing {
            picker.add(self)
            observing = true
        }
        picker.isActive = true
        picker.present(using: .window)
    }

    /// Whether windows can be listed (Screen Recording allowed in System Settings): then the
    /// game window is found without the picker.
    nonisolated static var canListWindows: Bool { CGPreflightScreenCaptureAccess() }

    /// Windows that sent no picture after being picked (the game's blank helper windows),
    /// kept out of the search for a while.
    private var deadWindows: [CGWindowID: Date] = [:]
    /// When the window being read was picked, and its rank (2 = the game's own window).
    private(set) var pickedAt: Date?
    private(set) var pickedRank = 0

    /// The game's windows, best first: rank 2 (the game app's window titled "MapleStory"),
    /// then rank 1; larger first. Never a window without a title, a launcher, Steam, a browser
    /// or Maple Atlas.
    private func gameWindows() async -> [(SCWindow, Int)] {
        guard Self.canListWindows,
              let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        else { return [] }
        let own = Bundle.main.bundleIdentifier
        deadWindows = deadWindows.filter { Date.now.timeIntervalSince($0.value) < 120 }
        let area = { (w: SCWindow) in w.frame.width * w.frame.height }
        return content.windows.compactMap { window -> (SCWindow, Int)? in
            guard let app = window.owningApplication, app.bundleIdentifier != own, window.windowLayer == 0,
                  window.frame.width >= 320, window.frame.height >= 240, deadWindows[window.windowID] == nil else { return nil }
            let rank = Self.gameRank(app: app.applicationName, bundle: app.bundleIdentifier, title: window.title ?? "")
            return rank > 0 ? (window, rank) : nil
        }.sorted { $0.1 != $1.1 ? $0.1 > $1.1 : area($0.0) > area($1.0) }
    }

    /// Every window of a MapleStory app, as the system lists it (for the log when none is
    /// taken): app, title, size, layer, on screen, and the rank given.
    func describeMapleWindows() async -> String {
        guard Self.canListWindows,
              let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        else { return "windows cannot be listed" }
        let rows = content.windows.compactMap { w -> String? in
            guard let app = w.owningApplication else { return nil }
            let text = "\(app.applicationName) \(app.bundleIdentifier) \(w.title ?? "")".lowercased()
            guard text.contains("maple") else { return nil }
            let rank = Self.gameRank(app: app.applicationName, bundle: app.bundleIdentifier, title: w.title ?? "")
            return "\(app.applicationName) [\(app.bundleIdentifier)] \"\(w.title ?? "")\" \(Int(w.frame.width))×\(Int(w.frame.height)) layer \(w.windowLayer) \(w.isOnScreen ? "on" : "off") screen → rank \(rank)"
        }
        return rows.isEmpty ? "no MapleStory windows listed" : rows.joined(separator: " | ")
    }

    /// Finds the game's window and starts reading it. Returns false when none is open or
    /// windows cannot be listed.
    func findGameWindow() async -> Bool {
        guard !isCapturing, let (window, rank) = await gameWindows().first, !isCapturing else { return false }
        start(with: SCContentFilter(desktopIndependentWindow: window), windowID: window.windowID)
        currentWindow = window
        pickedAt = .now
        pickedRank = rank
        return true
    }

    /// While reading a window found automatically: switches to the game's own window when it
    /// appears and this one is not it, and drops a window that sent no picture for 6 s after
    /// being picked (looking again at once). Returns what happened, for the log, or nil.
    func recheckPickedWindow() async -> String? {
        guard isCapturing, let picked = currentWindow, let at = pickedAt else { return nil }
        if sink.latest == nil, Date.now.timeIntervalSince(at) > 6 {
            // The game's own window may just be idle (screen asleep): only lesser windows are
            // kept out; the game's own is simply picked again.
            if pickedRank < 2 { deadWindows[picked.windowID] = .now }
            guard pickedRank < 2 || Date.now.timeIntervalSince(at) > 30 else { return nil }
            stop()
            let found = await findGameWindow()
            return "The picked window sent no picture; " + (found ? "picked \(currentWindow?.title ?? "a window") of \(currentWindow?.owningApplication?.applicationName ?? "?")" : "looking for the game again")
        }
        guard pickedRank < 2, let (best, rank) = await gameWindows().first, rank == 2, best.windowID != picked.windowID else { return nil }
        stop()
        start(with: SCContentFilter(desktopIndependentWindow: best), windowID: best.windowID)
        currentWindow = best
        pickedAt = .now
        pickedRank = rank
        return "Switched to the game's own window"
    }

    /// Whether a window is the game itself: 0 = not the game, 2 = the game's own window (the
    /// "MapleStory Classic World" app, window "MapleStory"), 1 = another MapleStory window of a
    /// non-excluded app. Never the launcher, Steam, a browser (a MapleStory page or the Maple
    /// Atlas site) or Maple Atlas itself.
    nonisolated static func gameRank(app: String, bundle: String, title: String) -> Int {
        let a = app.lowercased(), b = bundle.lowercased(), t = title.lowercased().trimmingCharacters(in: .whitespaces)
        for bad in ["launcher", "atlas", "steam", "installer", "setup", "updater"] where a.contains(bad) || b.contains(bad) || t.contains(bad) {
            return 0
        }
        let browsers = ["com.google.chrome", "com.apple.safari", "org.mozilla", "com.microsoft.edgemac", "company.thebrowser", "com.brave",
                        "com.operasoftware", "com.vivaldi", "com.hnc.discord", "com.apple.finder"]
        if browsers.contains(where: { b.hasPrefix($0) }) { return 0 }
        // A window without a title is one of the game's blank helper windows, never the game.
        guard !t.isEmpty else { return 0 }
        let isGameApp = a.contains("maplestory") || b.contains("maplestory")
        if isGameApp && t == "maplestory" { return 2 }
        if isGameApp || t == "maplestory" { return 1 }
        return 0
    }

    /// The window being read is not the game (a launcher picked before this check existed):
    /// the caller stops it and looks again.
    var isReadingNonGame: Bool {
        guard isCapturing, #available(macOS 15.2, *), let window = currentWindow,
              let app = window.owningApplication else { return false }
        return Self.gameRank(app: app.applicationName, bundle: app.bundleIdentifier, title: window.title ?? "") == 0
    }
    private var currentWindow: SCWindow?

    func stop() {
        let current = stream
        stream = nil
        isCapturing = false
        sink.clear()
        if let current { Task { try? await current.stopCapture() } }
    }

    /// The latest frame: a small preview of the whole window and, unless preview-only,
    /// the minimap crop (normalized, top-left origin) as a JPEG data URL. Cropping happens
    /// before the ≤ 960 px downscale, so the minimap keeps its detail.
    /// The top-right part of the window, where the game's Quest Helper panel sits, as
    /// a PNG data URL (at most 1600 px on the long side).
    nonisolated func questPanelImage(region: CGRect) throws -> String {
        guard let image = sink.latest else { throw CaptureError.noFrameYet }
        let corner = Self.cropped(image, to: region) ?? image
        return try Self.pngDataURL(from: Self.downscaled(corner, maxSide: 1600))
    }

    /// The same part of the window as an image, for on-device text recognition.
    /// The whole window (at most maxSide px), for finding the game's panels by their text.
    nonisolated func wholeWindowCGImage(maxSide: CGFloat = 1600) throws -> CGImage {
        guard let image = sink.latest else { throw CaptureError.noFrameYet }
        return Self.downscaled(image, maxSide: maxSide)
    }

    nonisolated func questPanelCGImage(region: CGRect) throws -> CGImage {
        guard let image = sink.latest else { throw CaptureError.noFrameYet }
        return Self.downscaled(Self.cropped(image, to: region) ?? image, maxSide: 1600)
    }

    nonisolated func frame(region: CGRect, previewOnly: Bool) throws -> Frame {
        guard let image = sink.latest else { throw CaptureError.noFrameYet }
        let preview = Self.downscaled(image, maxSide: Self.previewMaxSide)
        guard !previewOnly else { return Frame(preview: preview, minimapImage: nil, frameHeight: image.height) }
        let minimap = Self.cropped(image, to: region) ?? image
        let scaled = Self.downscaled(minimap, maxSide: Self.matchMaxSide)
        let factor = Double(scaled.width) / Double(max(1, minimap.width))
        return Frame(
            preview: preview, minimapImage: try Self.pngDataURL(from: scaled),
            frameHeight: Int((Double(image.height) * factor).rounded()))
    }

    fileprivate func start(with filter: SCContentFilter, windowID knownID: CGWindowID? = nil) {
        stop()
        let scale = CGFloat(filter.pointPixelScale)
        let configuration = SCStreamConfiguration()
        configuration.width = max(64, Int(filter.contentRect.width * scale))
        configuration.height = max(64, Int(filter.contentRect.height * scale))
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 10) // feeds the 5 Hz dot reading
        configuration.queueDepth = 3
        configuration.showsCursor = false
        configuration.capturesAudio = false
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.ignoreShadowsSingleWindow = true

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        do {
            try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: sink.queue)
        } catch {
            onStopped?("Couldn't read the game window: \(error.localizedDescription)")
            return
        }
        self.stream = stream
        isCapturing = true
        if #available(macOS 15.2, *) { windowID = knownID ?? filter.includedWindows.first?.windowID } else { windowID = knownID }
        onSelected?(Self.label(for: filter), Self.key(for: filter))
        Task {
            do {
                try await stream.startCapture()
            } catch {
                guard self.stream === stream else { return }
                self.stream = nil
                self.isCapturing = false
                self.onStopped?("Couldn't start reading the game window: \(error.localizedDescription)")
            }
        }
    }

    fileprivate func streamStopped(_ stopped: SCStream) {
        guard stream === stopped else { return }
        stream = nil
        isCapturing = false
        sink.clear()
        onStopped?("Game window no longer shared. Choose it again.")
    }

    private static func label(for filter: SCContentFilter) -> String {
        if #available(macOS 15.2, *), let window = filter.includedWindows.first {
            let parts = [window.owningApplication?.applicationName ?? "", window.title ?? ""].filter { !$0.isEmpty }
            if !parts.isEmpty { return parts.joined(separator: " — ") }
        }
        return "Game window"
    }

    /// Remembers the minimap box per game app; older macOS versions share one box.
    private static func key(for filter: SCContentFilter) -> String {
        if #available(macOS 15.2, *), let id = filter.includedWindows.first?.owningApplication?.bundleIdentifier {
            return id
        }
        return "default"
    }

    // MARK: Image helpers

    nonisolated private static func fittedSize(_ size: CGSize, maxSide: CGFloat) -> CGSize {
        guard size.width > 0, size.height > 0 else { return CGSize(width: 960, height: 720) }
        let factor = min(1, maxSide / max(size.width, size.height))
        return CGSize(width: max(1, (size.width * factor).rounded()), height: max(1, (size.height * factor).rounded()))
    }

    nonisolated private static func cropped(_ image: CGImage, to region: CGRect) -> CGImage? {
        let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        let rect = CGRect(
            x: region.minX * bounds.width, y: region.minY * bounds.height,
            width: region.width * bounds.width, height: region.height * bounds.height
        ).integral.intersection(bounds)
        guard rect.width >= 16, rect.height >= 16 else { return nil }
        return image.cropping(to: rect)
    }

    nonisolated private static func downscaled(_ image: CGImage, maxSide: CGFloat) -> CGImage {
        let size = CGSize(width: image.width, height: image.height)
        let fitted = fittedSize(size, maxSide: maxSide)
        guard fitted.width < size.width,
              let context = CGContext(
                data: nil, width: Int(fitted.width), height: Int(fitted.height), bitsPerComponent: 8,
                bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return image }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(origin: .zero, size: fitted))
        return context.makeImage() ?? image
    }

    nonisolated static func pngDataURL(from image: CGImage) throws -> String {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)
        else { throw CaptureError.encodingFailed }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw CaptureError.encodingFailed }
        return "data:image/png;base64," + (data as Data).base64EncodedString()
    }
}

/// Carries ScreenCaptureKit objects from framework callback threads to the main actor.
private struct Unchecked<Value>: @unchecked Sendable { let value: Value }

extension GameCapture: SCContentSharingPickerObserver {
    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {}

    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        let box = Unchecked(value: filter)
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                SCContentSharingPicker.shared.isActive = false
                self.start(with: box.value)
            }
        }
    }

    nonisolated func contentSharingPickerStartDidFailWithError(_ error: any Error) {
        let message = error.localizedDescription
        DispatchQueue.main.async {
            MainActor.assumeIsolated { self.onStopped?("The window picker couldn't open: \(message)") }
        }
    }
}

extension GameCapture: SCStreamDelegate {
    nonisolated func stream(_ stream: SCStream, didStopWithError error: any Error) {
        let box = Unchecked(value: stream)
        DispatchQueue.main.async {
            MainActor.assumeIsolated { self.streamStopped(box.value) }
        }
    }
}

/// Receives stream frames on a background queue and keeps only the newest one.
private final class FrameSink: NSObject, SCStreamOutput, @unchecked Sendable {
    let queue = DispatchQueue(label: "io.github.tal412.maple-atlas-companion.frames")
    private let lock = NSLock()
    private var image: CGImage?
    private let context = CIContext(options: [.cacheIntermediates: false])

    var latest: CGImage? { lock.withLock { image } }
    func clear() { lock.withLock { image = nil } }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: rawStatus) == .complete,
              let pixels = sampleBuffer.imageBuffer
        else { return }
        let ci = CIImage(cvPixelBuffer: pixels)
        guard let cg = context.createCGImage(ci, from: ci.extent) else { return }
        lock.withLock { image = cg }
    }
}
