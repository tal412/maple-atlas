import SwiftUI
import WebKit

struct ContentView: View {
    let model: CompanionModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Form {
            PhoneSection(model: model)
            GameWindowSection(model: model)
            TrackingSection(model: model)
        }
        .formStyle(.grouped)
        .frame(minWidth: 480, idealWidth: 520, minHeight: 560, idealHeight: 820)
        .safeAreaInset(edge: .bottom) {
            HStack {
                Text(model.updater.label)
                    .foregroundStyle(.secondary)
                if model.updater.canInstall {
                    Button("Update") { Task { await model.updater.install() } }
                        .buttonStyle(.borderedProminent)
                } else {
                    Button(model.updater.isChecking ? "Checking…" : "Check for updates") { Task { await model.updater.check() } }
                        .disabled(model.updater.isChecking || model.updater.isBusy)
                }
                Spacer()
                Button("Diagnostics") { openWindow(id: "log") }
                SettingsLink { Text("Settings…") }
            }
            .controlSize(.small)
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
            .background(.bar)
        }
        // The engine's web view must stay in a window hierarchy so WebKit keeps it running.
        .background(alignment: .topLeading) {
            EngineWebView(webView: model.engine.webView)
                .frame(width: 1, height: 1)
                .opacity(0)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }
}

// MARK: - Phone

private struct PhoneSection: View {
    let model: CompanionModel

    var body: some View {
        Section("Phone") {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: statusSymbol)
                    .font(.title2)
                    .foregroundStyle(statusColor)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.phaseTitle).font(.headline)
                    if !model.phaseMessage.isEmpty {
                        Text(model.phaseMessage)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.vertical, 2)

            if model.phase == "waiting", let pairing = model.pairing, let qr = model.qrImage {
                PairingView(pairing: pairing, qr: qr)
            }

            if let problem = model.helperProblem {
                Label(problem, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
            }

            if let error = model.lastError {
                HStack(alignment: .top) {
                    Label(error, systemImage: "exclamationmark.circle.fill")
                        .foregroundStyle(.red)
                    Spacer()
                    Button("Dismiss") { model.lastError = nil }
                        .buttonStyle(.link)
                }
            }

            HStack {
                if model.helperProblem != nil {
                    Button("Restart helper") { model.restartHelper() }
                } else if model.hasPairedPhone {
                    Button("Pair a new phone") { model.newCode() }
                        .disabled(!model.isHelperRunning)
                        .help("Forget the paired phone and show a code for another one")
                } else {
                    Button("New code") { model.newCode() }
                        .disabled(!model.isHelperRunning)
                }
                if model.phase == "connected" || model.phase == "reconnecting" {
                    Button("Disconnect") { model.disconnect() }
                }
            }
        }
    }

    private var statusSymbol: String {
        switch model.phase {
        case "connected": "iphone.radiowaves.left.and.right"
        case "waiting": "qrcode"
        case "connecting", "verifying", "reconnecting": "arrow.triangle.2.circlepath"
        case "failed", "expired", "disconnected": "iphone.slash"
        default: "iphone"
        }
    }

    private var statusColor: Color {
        switch model.phase {
        case "connected": .green
        case "connecting", "verifying", "reconnecting", "waiting": .accentColor
        case "failed": .red
        default: .secondary
        }
    }
}

private struct PairingView: View {
    let pairing: PairingCode
    let qr: CGImage

    var body: some View {
        VStack(spacing: 10) {
            Image(decorative: qr, scale: 1)
                .interpolation(.none)
                .resizable()
                .frame(width: 260, height: 260)
                .padding(16)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
                .accessibilityLabel("Pairing QR code")

            Text("Scan with your phone's camera")
                .font(.headline)

            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(countdown(at: context.date))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }

            if !pairing.addresses.isEmpty {
                Text("This Mac: \(pairing.addresses.joined(separator: ", "))")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Button("Copy link") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(pairing.link, forType: .string)
            }
            .buttonStyle(.link)
            .font(.callout)
            .help("Copy the pairing link to open it on the phone another way")
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    private func countdown(at date: Date) -> String {
        let remaining = Int(pairing.expires.timeIntervalSince(date).rounded(.down))
        guard remaining > 0 else { return "Code expired — press New code" }
        return String(format: "Expires in %d:%02d", remaining / 60, remaining % 60)
    }
}

// MARK: - Game window

private struct GameWindowSection: View {
    /// Which box the preview edits: the minimap (false) or the Quest Helper (true).
    @State private var editingQuest = false
    let model: CompanionModel

    var body: some View {
        Section("Game window") {
            HStack {
                if let label = model.gameWindowLabel {
                    Label(label, systemImage: "macwindow")
                        .lineLimit(1).truncationMode(.middle)
                } else {
                    Text("No game window chosen").foregroundStyle(.secondary)
                }
                Spacer()
                Button(model.hasGameWindow ? "Change window…" : "Choose game window…") { model.chooseGameWindow() }
            }
            if model.canFindWindow {
                Text("The MapleStory window is found by itself and tracking starts on its own. Frames stay on this Mac; only the map ID, your dot and your quests are sent to your phone.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("To find the MapleStory window by itself, turn on Maple Atlas Companion in System Settings \u{203A} Privacy & Security \u{203A} Screen Recording, then reopen this app. Until then, choose the window in macOS\u{2019}s picker. Frames stay on this Mac.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Open Screen Recording settings") { model.openScreenRecordingSettings() }
            }

            if model.hasGameWindow {
                VStack(alignment: .leading, spacing: 8) {
                    Picker("Box", selection: $editingQuest) {
                        Text("Minimap").tag(false)
                        Text("Quest Helper").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    if editingQuest {
                        MinimapRegionEditor(
                            image: model.previewImage, region: model.questRect, label: "Quest Helper", color: .orange,
                            other: model.minimapRect, otherLabel: "Minimap",
                            onChange: { model.setQuestRect($0) })
                        HStack {
                            Text(model.questMarked ? "Drag a box around the game\u{2019}s Quest Helper panel" : "Drag a box around the game\u{2019}s Quest Helper panel (now: the top-right corner)")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button("Reset") { model.resetQuestRect() }
                                .disabled(!model.questMarked)
                        }
                    } else {
                        MinimapRegionEditor(
                            image: model.previewImage, region: model.minimapRect,
                            other: model.questRect, otherLabel: "Quest Helper",
                            onChange: { model.setMinimapRect($0) })
                        HStack {
                            Text("Drag a box around the in-game minimap and its map name")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button("Reset to top-left") { model.resetMinimapRect() }
                                .disabled(model.isDefaultMinimapRect)
                        }
                    }
                    Text("Maple Atlas reads the map name at the top of the minimap. Press + on the in-game minimap until the name shows (for example \u{201C}Victoria Road \u{00B7} Henesys\u{201D}), and keep it inside the box.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 4)
            }

            if let problem = model.captureProblem {
                Text(problem).foregroundStyle(.red).font(.callout)
            }

            HStack {
                if model.isTracking {
                    Button("Stop tracking") { model.stopTrackingByPlayer() }
                } else {
                    Button("Start tracking") { model.startTracking() }
                        .buttonStyle(.borderedProminent)
                        .disabled(!model.hasGameWindow)
                }
            }
        }
    }
}

// MARK: - Tracking

private struct TrackingSection: View {
    let model: CompanionModel

    var body: some View {
        Section("Tracking") {
            LabeledContent("Map engine") {
                switch model.engineStatus {
                case .waitingForHelper:
                    Text("Waiting for the helper…").foregroundStyle(.secondary)
                case .loading(let message):
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text(message).foregroundStyle(.secondary).lineLimit(2)
                    }
                case .ready(let count):
                    Text(count > 0 ? "Ready · \(count) maps" : "Ready")
                case .failed(let message):
                    HStack {
                        Text(message).foregroundStyle(.red).lineLimit(3)
                        Button("Reload") { model.reloadEngine() }
                    }
                }
            }

            LabeledContent("Status") {
                Text(model.readingText)
                    .foregroundStyle(model.isTracking ? .primary : .secondary)
                    .multilineTextAlignment(.trailing)
            }

            if let map = model.lastConfirmed {
                LabeledContent("Last match") {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(map.name)
                        Text(details(map))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                LabeledContent("Your position") {
                    if let position = model.lastPosition {
                        Text("x \(Int(position.x)), y \(Int(position.y))").monospacedDigit()
                    } else {
                        Text("Dot not found on the minimap").foregroundStyle(.secondary)
                    }
                }
                LabeledContent("Quest Helper") {
                    Text(model.questSummary).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func details(_ map: ConfirmedMap) -> String {
        var parts: [String] = []
        if let inliers = map.inliers { parts.append("\(inliers) inliers") }
        if let confidence = map.confidence { parts.append("\(confidence)%") }
        if let kind = map.kind { parts.append(kind) }
        parts.append(map.at.formatted(date: .omitted, time: .standard))
        return parts.joined(separator: " · ")
    }
}

// MARK: - Engine host view

private struct EngineWebView: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

// MARK: - Settings & diagnostics

struct SettingsView: View {
    @Bindable var model: CompanionModel

    var body: some View {
        Form {
            LabeledContent("Version", value: model.updater.current)
            LabeledContent("Updates") {
                HStack {
                    Text(model.updater.label).foregroundStyle(.secondary)
                    if model.updater.canInstall {
                        Button("Update") { Task { await model.updater.install() } }
                    } else {
                        Button("Check now") { Task { await model.updater.check() } }
                    }
                }
            }
            Toggle("Show navigation on the game window", isOn: $model.showOverlay)
            Text("During a route on your phone, a card on top of the game shows the way to the next portal or the best hunting spot. Clicks pass through it.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Text("The phone opens \(model.site.url). Update checks contact GitHub only.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(20)
        .frame(width: 520)
    }
}

struct LogView: View {
    let model: CompanionModel

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(model.logLines.enumerated()), id: \.offset) { index, line in
                            Text(line).id(index)
                        }
                    }
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                }
                .onChange(of: model.logLines.count) { _, count in
                    proxy.scrollTo(count - 1, anchor: .bottom)
                }
            }
            Divider()
            HStack {
                Spacer()
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(model.logLines.joined(separator: "\n"), forType: .string)
                }
                Button("Clear") { model.clearLog() }
            }
            .padding(10)
        }
        .frame(minWidth: 420, minHeight: 240)
    }
}
