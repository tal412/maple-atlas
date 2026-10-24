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
        let minimapJPEG: String?
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
    private var stream: SCStream?
    private let sink = FrameSink()
    private var observing = false

    nonisolated static let matchMaxSide: CGFloat = 960
    nonisolated static let previewMaxSide: CGFloat = 640
    nonisolated static let jpegQuality: CGFloat = 0.85

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
    nonisolated func frame(region: CGRect, previewOnly: Bool) throws -> Frame {
        guard let image = sink.latest else { throw CaptureError.noFrameYet }
        let preview = Self.downscaled(image, maxSide: Self.previewMaxSide)
        guard !previewOnly else { return Frame(preview: preview, minimapJPEG: nil) }
        let minimap = Self.cropped(image, to: region) ?? image
        return Frame(preview: preview, minimapJPEG: try Self.jpegDataURL(from: Self.downscaled(minimap, maxSide: Self.matchMaxSide)))
    }

    fileprivate func start(with filter: SCContentFilter) {
        stop()
        let scale = CGFloat(filter.pointPixelScale)
        let configuration = SCStreamConfiguration()
        configuration.width = max(64, Int(filter.contentRect.width * scale))
        configuration.height = max(64, Int(filter.contentRect.height * scale))
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 2) // 2 fps is plenty.
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

    nonisolated private static func jpegDataURL(from image: CGImage) throws -> String {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)
        else { throw CaptureError.encodingFailed }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: jpegQuality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw CaptureError.encodingFailed }
        return "data:image/jpeg;base64," + (data as Data).base64EncodedString()
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
