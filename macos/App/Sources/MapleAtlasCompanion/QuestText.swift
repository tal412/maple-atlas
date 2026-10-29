import CoreGraphics
import Foundation
import Vision

/// Reads the game's Quest Helper panel with Apple's on-device text recognition (Vision).
/// On real panels over sky, scenery and plants it read every count right where the
/// bundled Tesseract reader misread slashes and digits ("18 / 20" as "16 / 2").
/// Only the lines are found here; the shared parser in the engine turns them into quests.
enum QuestText {
    struct Line {
        let text: String
        let box: CGRect   // pixels, top-left origin
    }

    /// The panel's lines in reading order, from its "Quest Helper" title down, or nil when
    /// no panel is seen. marked: the player drew a box around the panel, so without a
    /// readable title every line in the box is taken.
    static func panelText(_ image: CGImage, marked: Bool) -> String? {
        let lines = recognize(image)
        guard !lines.isEmpty else { return nil }
        guard let header = lines.first(where: { isHeader($0.text) }) else {
            return marked ? lines.map(\.text).joined(separator: "\n") : nil
        }
        let lineHeight = max(1, header.box.height)
        // The title row also holds the AUTO, minimize and close buttons: it sets the
        // panel's right edge, and only the title itself is kept from it.
        let titleRow = lines.filter { overlapsVertically($0.box, header.box) }
        let right = (titleRow.map(\.box.maxX).max() ?? header.box.maxX) + lineHeight
        var kept = [header]
        var bottom = header.box.maxY
        for line in lines where line.box.midY > header.box.maxY {
            guard line.box.minX >= header.box.minX - lineHeight * 1.5, line.box.minX < right else { continue }
            if line.box.minY - bottom > lineHeight * 3.5 { break }   // past the panel's end
            kept.append(line)
            bottom = max(bottom, line.box.maxY)
        }
        return kept.map(\.text).joined(separator: "\n")
    }

    /// Vision loads its model on first use (tens of seconds on some Macs): done once in the
    /// background at launch, so the first panel read is not held up.
    static func warmUp() {
        Task.detached(priority: .utility) {
            guard let context = CGContext(data: nil, width: 160, height: 48, bitsPerComponent: 8, bytesPerRow: 0,
                                          space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return }
            context.setFillColor(gray: 1, alpha: 1)
            context.fill(CGRect(x: 0, y: 0, width: 160, height: 48))
            if let image = context.makeImage() { _ = recognize(image) }
        }
    }

    /// Recognized lines sorted top to bottom, then left to right.
    static func recognize(_ image: CGImage) -> [Line] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false   // item and monster names are not dictionary words
        request.recognitionLanguages = ["en-US"]
        do { try VNImageRequestHandler(cgImage: image).perform([request]) } catch { return [] }
        let w = CGFloat(image.width), h = CGFloat(image.height)
        let lines = (request.results ?? []).compactMap { observation -> Line? in
            guard let text = observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespaces),
                  !text.isEmpty else { return nil }
            let b = observation.boundingBox   // normalized, bottom-left origin
            return Line(text: text, box: CGRect(x: b.minX * w, y: (1 - b.maxY) * h, width: b.width * w, height: b.height * h))
        }
        return lines.sorted { a, b in
            overlapsVertically(a.box, b.box) ? a.box.minX < b.box.minX : a.box.midY < b.box.midY
        }
    }

    private static func overlapsVertically(_ a: CGRect, _ b: CGRect) -> Bool {
        min(a.maxY, b.maxY) - max(a.minY, b.minY) > min(a.height, b.height) * 0.5
    }

    /// "Quest Helper (2/5)", allowing a few misread letters.
    static func isHeader(_ text: String) -> Bool {
        let letters = text.lowercased().filter { $0.isLetter }
        guard letters.count >= 9 else { return false }
        guard letters.first == "q" else { return false }
        // The title's "(2/5)" lets one more slip through; a quest named "Quest Hunter …" has none.
        let distance = editDistance(String(letters.prefix(11)), "questhelper")
        return distance <= 2 || (distance <= 3 && text.range(of: #"\(\s*\d[\d\s/|lI]*\)"#, options: .regularExpression) != nil)
    }

    private static func editDistance(_ a: String, _ b: String) -> Int {
        let a = Array(a), b = Array(b)
        var row = Array(0...b.count)
        for i in 1...max(1, a.count) where !a.isEmpty {
            var previous = row[0]
            row[0] = i
            for j in 1...max(1, b.count) where !b.isEmpty {
                let old = row[j]
                row[j] = min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] == b[j - 1] ? 0 : 1))
                previous = old
            }
        }
        return row[b.count]
    }
}
