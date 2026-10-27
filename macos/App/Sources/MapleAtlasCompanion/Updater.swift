import AppKit
import CryptoKit
import Foundation
import Observation

/// Checks GitHub for a newer Maple Atlas Companion and installs it in place: downloads
/// the release's disk image, checks its SHA-256, then a small script waits for this
/// app to quit, swaps the app bundle and opens the new version. Only GitHub is
/// contacted, and only to check for or download an update.
@MainActor
@Observable
final class Updater {
    enum State: Equatable {
        case idle
        case checking
        case upToDate
        case available(version: String)
        case downloading(version: String)
        case failed(String)
    }

    private(set) var state = State.idle
    let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"

    @ObservationIgnored private var asset: Asset?
    @ObservationIgnored private var timer: Task<Void, Never>?

    private struct Release: Decodable {
        let tag_name: String
        let assets: [Asset]
    }

    private struct Asset: Decodable {
        let name: String
        let browser_download_url: URL
        let size: Int
        let digest: String?
    }

    private static let api = URL(string: "https://api.github.com/repos/tal412/maple-atlas/releases/latest")!
    private static let dmgName = "MapleAtlasCompanion-mac.dmg"

    var label: String {
        switch state {
        case .idle, .checking: "Version \(current)"
        case .upToDate: "Version \(current) · Up to date"
        case .available(let v): "Version \(v) is available (you have \(current))"
        case .downloading(let v): "Downloading version \(v)…"
        case .failed(let message): message
        }
    }

    var isChecking: Bool { if case .checking = state { true } else { false } }
    /// Downloading or installing: no new check meanwhile.
    var isBusy: Bool { if case .downloading = state { true } else { false } }
    var canInstall: Bool {
        if case .available = state { return true }
        return false
    }

    /// Checks now, then every 6 hours.
    func start() {
        timer?.cancel()
        timer = Task {
            while !Task.isCancelled {
                await check()
                try? await Task.sleep(for: .seconds(6 * 3600))
            }
        }
    }

    func check() async {
        if case .downloading = state { return }
        state = .checking
        do {
            var request = URLRequest(url: Self.api, timeoutInterval: 15)
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            request.setValue("MapleAtlasCompanion/\(current)", forHTTPHeaderField: "User-Agent")
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            let release = try JSONDecoder().decode(Release.self, from: data)
            let latest = release.tag_name.replacingOccurrences(of: "companion-", with: "").trimmingCharacters(in: CharacterSet(charactersIn: "v"))
            asset = release.assets.first { $0.name == Self.dmgName }
            state = asset != nil && Self.isNewer(latest, than: current) ? .available(version: latest) : .upToDate
        } catch {
            state = .idle // Offline or rate limited: try again later, quietly.
        }
    }

    static func isNewer(_ a: String, than b: String) -> Bool {
        guard b != "dev" else { return false }
        let x = a.split(separator: ".").map { Int($0) ?? 0 }, y = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<3 {
            let p = i < x.count ? x[i] : 0, q = i < y.count ? y[i] : 0
            if p != q { return p > q }
        }
        return false
    }

    func install() async {
        guard case .available(let version) = state, let asset else { return }
        let app = Bundle.main.bundleURL
        guard FileManager.default.isWritableFile(atPath: app.deletingLastPathComponent().path) else {
            state = .failed("Can't update here. Move the app to Applications, or download the new version from the website.")
            return
        }
        guard asset.browser_download_url.absoluteString.hasPrefix("https://github.com/tal412/maple-atlas/releases/download/") else {
            state = .failed("Update failed: unexpected download address.")
            return
        }
        state = .downloading(version: version)
        do {
            let (temp, response) = try await URLSession.shared.download(from: asset.browser_download_url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            let dmg = FileManager.default.temporaryDirectory.appendingPathComponent("MapleAtlasCompanion-\(version).dmg")
            try? FileManager.default.removeItem(at: dmg)
            try FileManager.default.moveItem(at: temp, to: dmg)
            let data = try Data(contentsOf: dmg, options: .mappedIfSafe)
            guard data.count == asset.size else { throw UpdateError.incomplete }
            if let digest = asset.digest?.replacingOccurrences(of: "sha256:", with: "") {
                let sum = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                guard sum.caseInsensitiveCompare(digest) == .orderedSame else { throw UpdateError.mismatch }
            }
            try launchSwap(dmg: dmg, app: app)
            NSApp.terminate(nil)
        } catch {
            state = .failed("Update failed: \(error.localizedDescription)")
        }
    }

    private enum UpdateError: LocalizedError {
        case incomplete, mismatch
        var errorDescription: String? {
            switch self {
            case .incomplete: "the download was incomplete."
            case .mismatch: "the download did not match the release."
            }
        }
    }

    /// Waits for this process to exit, replaces the bundle (restoring it on failure)
    /// and opens the new version.
    private func launchSwap(dmg: URL, app: URL) throws {
        let script = """
        PID="$1"; DMG="$2"; APP="$3"
        MNT="$(mktemp -d)"
        hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$DMG" >/dev/null || exit 1
        while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done
        NEW="$MNT/Maple Atlas Companion.app"
        if [ -d "$NEW" ]; then
          rm -rf "$APP.previous"
          if mv "$APP" "$APP.previous" && ditto "$NEW" "$APP"; then rm -rf "$APP.previous"
          else rm -rf "$APP"; mv "$APP.previous" "$APP"; fi
        fi
        hdiutil detach "$MNT" -quiet; rm -f "$DMG"
        open "$APP"
        """
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", script, "maple-atlas-update", String(ProcessInfo.processInfo.processIdentifier), dmg.path, app.path]
        try process.run()
    }
}
