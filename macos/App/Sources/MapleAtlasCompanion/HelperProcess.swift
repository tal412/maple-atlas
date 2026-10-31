import Foundation

/// A pairing code announced by the helper. `link` is what the QR encodes.
struct PairingCode: Equatable, Sendable {
    let link: String
    let code: String
    let expires: Date
    let addresses: [String]
}

/// Events the `maple-link` helper prints on stdout (one JSON object per line).
/// Where the phone's route goes next on the map you are on (map-image pixels).
struct NavInfo: Sendable, Equatable {
    struct Target: Decodable, Sendable, Equatable {
        let kind: String   // "portal", "npc" (where the NPC stands), "spot" (older phones) or "arrived"
        let label: String
        let x: Double?
        let y: Double?
    }
    let map: String
    let name: String
    let dest: String
    let step: Int
    let steps: Int
    let live: Bool
    let hint: String
    let target: Target
}

/// A quest pinned on the phone, for the overlay row on the game window.
struct PinnedQuest: Decodable, Sendable, Equatable {
    struct Objective: Decodable, Sendable, Equatable {
        let name: String
        let have: Int?
        let need: Int?
        /// Picture URL (the datamine CDN, checked by the helper), or "".
        let icon: String
        /// For an ore: the monster that drops it most here (picture URL) and the chance in %.
        let monster: String?
        let chance: Double?
    }
    let title: String
    let ready: Bool
    /// "ores" for the map's ores; "" for a quest.
    let kind: String?
    let objectives: [Objective]
}

enum HelperEvent: Sendable {
    case engine(URL)
    case code(PairingCode)
    /// A saved phone pairing is active; no QR is needed.
    case paired(addresses: [String])
    case state(phase: String, message: String)
    case log(String)
    case error(String)
    /// Navigation from the phone for the on-game overlay; nil when no route is active.
    case nav(NavInfo?)
    /// Quests pinned on the phone (empty: none).
    case pins([PinnedQuest])

    private struct Raw: Decodable {
        let event: String
        let url: String?
        let link: String?
        let code: String?
        let expires: Double?
        let addresses: [String]?
        let phase: String?
        let message: String?
        let from: String?
        let active: Bool?
        let map: String?
        let name: String?
        let dest: String?
        let step: Int?
        let steps: Int?
        let live: Bool?
        let hint: String?
        let target: NavInfo.Target?
        let quests: [PinnedQuest]?
    }

    /// Returns nil for unknown or malformed events, which the contract says to ignore.
    init?(line: String) {
        guard let raw = try? JSONDecoder().decode(Raw.self, from: Data(line.utf8)) else { return nil }
        switch raw.event {
        case "engine":
            guard let string = raw.url, let url = URL(string: string) else { return nil }
            self = .engine(url)
        case "code":
            guard let link = raw.link, let code = raw.code else { return nil }
            let expires = raw.expires.map { Date(timeIntervalSince1970: $0 / 1000) } ?? .now.addingTimeInterval(600)
            self = .code(PairingCode(link: link, code: code, expires: expires, addresses: raw.addresses ?? []))
        case "paired":
            self = .paired(addresses: raw.addresses ?? [])
        case "state":
            guard let phase = raw.phase else { return nil }
            self = .state(phase: phase, message: raw.message ?? "")
        case "log":
            self = .log(raw.message ?? "")
        case "contact":
            self = .log("A phone with this code reached the Mac (\(raw.from ?? "?")).")
        case "error":
            self = .error(raw.message ?? "Unknown error")
        case "nav":
            guard raw.active == true else { self = .nav(nil); return }
            guard let map = raw.map, let step = raw.step, let steps = raw.steps, let target = raw.target else { return nil }
            self = .nav(NavInfo(map: map, name: raw.name ?? "", dest: raw.dest ?? "", step: step, steps: steps,
                                live: raw.live ?? false, hint: raw.hint ?? "", target: target))
        case "pins":
            self = .pins(raw.quests ?? [])
        default:
            return nil
        }
    }
}

/// Commands written to the helper's stdin (one JSON object per line).
enum HelperCommand {
    /// Use the saved pairing, or create a code when none exists.
    case start
    /// Forget the saved phone and create a code for a new one.
    case pair
    case stop
    case tracking(state: String)
    case location(id: String, confidence: Int, observedAt: Date)
    /// The player's position on that map, in the portal data's coordinates.
    case position(id: String, x: Int, y: Int, observedAt: Date)
    /// The quests tracked in the game's Quest Helper (engine's compact form).
    case quests(visible: Bool, quests: [Any], observedAt: Date)

    var payload: [String: Any] {
        switch self {
        case .start: ["cmd": "start"]
        case .pair: ["cmd": "pair"]
        case .stop: ["cmd": "stop"]
        case .tracking(let state): ["cmd": "tracking", "state": state]
        case .location(let id, let confidence, let observedAt):
            [
                "cmd": "location",
                "id": id,
                "confidence": max(0, min(100, confidence)),
                "observedAt": Int64((observedAt.timeIntervalSince1970 * 1000).rounded()),
            ]
        case .quests(let visible, let quests, let observedAt):
            [
                "cmd": "quests", "visible": visible, "quests": quests,
                "observedAt": Int64((observedAt.timeIntervalSince1970 * 1000).rounded()),
            ]
        case .position(let id, let x, let y, let observedAt):
            [
                "cmd": "position", "id": id, "x": x, "y": y,
                "observedAt": Int64((observedAt.timeIntervalSince1970 * 1000).rounded()),
            ]
        }
    }
}

/// Owns one running `maple-link` process and its pipes.
@MainActor
final class HelperProcess {
    enum LaunchError: LocalizedError {
        case missing(URL)
        var errorDescription: String? {
            switch self {
            case .missing(let url): "The connection helper is missing (\(url.path))."
            }
        }
    }

    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let errors = Pipe()
    private var readers: [LineReader] = []
    private var inputClosed = false

    init(
        executable: URL,
        arguments: [String],
        onEvent: @escaping @MainActor @Sendable (HelperEvent) -> Void,
        onStderr: @escaping @MainActor @Sendable (String) -> Void,
        onExit: @escaping @MainActor @Sendable (Int32) -> Void
    ) throws {
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw LaunchError.missing(executable)
        }
        process.executableURL = executable
        process.arguments = arguments
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        process.terminationHandler = { process in
            let status = process.terminationStatus
            Task { @MainActor in onExit(status) }
        }
        try process.run()

        readers = [
            LineReader(output.fileHandleForReading) { line in
                if let event = HelperEvent(line: line) { onEvent(event) }
            },
            LineReader(errors.fileHandleForReading, onLine: onStderr),
        ]
    }

    var isRunning: Bool { process.isRunning }

    func send(_ command: HelperCommand) {
        guard !inputClosed, process.isRunning,
              var data = try? JSONSerialization.data(withJSONObject: command.payload)
        else { return }
        data.append(0x0A)
        // SIGPIPE is ignored app-wide, so a dead helper surfaces as a thrown error here.
        try? input.fileHandleForWriting.write(contentsOf: data)
    }

    /// Sends `stop`, closes stdin (the helper exits on EOF) and makes sure the process is gone.
    func shutdown(timeout: TimeInterval = 1.0) {
        if process.isRunning {
            send(.stop)
        }
        if !inputClosed {
            inputClosed = true
            try? input.fileHandleForWriting.close()
        }
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            usleep(20_000)
        }
        if process.isRunning {
            process.terminate()
        }
        readers.forEach { $0.cancel() }
    }
}

/// Splits a pipe's output into lines and delivers them, in order, on the main thread.
private final class LineReader: @unchecked Sendable {
    private let handle: FileHandle
    private let lock = NSLock()
    private var buffer = Data()

    init(_ handle: FileHandle, onLine: @escaping @MainActor @Sendable (String) -> Void) {
        self.handle = handle
        handle.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil } // EOF
            guard let self else { return }
            for line in self.lines(appending: chunk, atEOF: chunk.isEmpty) {
                DispatchQueue.main.async { MainActor.assumeIsolated { onLine(line) } }
            }
        }
    }

    private func lines(appending chunk: Data, atEOF: Bool) -> [String] {
        lock.lock()
        defer { lock.unlock() }
        buffer.append(chunk)
        var lines: [String] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            lines.append(String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self))
            buffer.removeSubrange(buffer.startIndex...newline)
        }
        if atEOF, !buffer.isEmpty {
            lines.append(String(decoding: buffer, as: UTF8.self))
            buffer.removeAll()
        }
        return lines.map { $0.trimmingCharacters(in: .init(charactersIn: "\r")) }
    }

    func cancel() { handle.readabilityHandler = nil }
}
