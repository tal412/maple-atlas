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
                Text("Site: \(model.site.title)")
                    .foregroundStyle(.secondary)
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
            Text("macOS shows its own window picker; click your game window. No Screen Recording permission is needed. Frames stay on this Mac; only the map ID is sent to your phone.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if model.hasGameWindow {
                VStack(alignment: .leading, spacing: 8) {
                    MinimapRegionEditor(
                        image: model.previewImage,
                        region: model.minimapRect,
                        onChange: { model.setMinimapRect($0) })
                    HStack {
                        Text("Drag a box around the in-game minimap")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Reset to top-left") { model.resetMinimapRect() }
                            .disabled(model.isDefaultMinimapRect)
                    }
                }
                .padding(.vertical, 4)
            }

            if let problem = model.captureProblem {
                Text(problem).foregroundStyle(.red).font(.callout)
            }

            HStack {
                if model.isTracking {
                    Button("Stop tracking") { model.stopTracking() }
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
            Picker("Phone opens", selection: $model.site) {
                ForEach(SiteOption.allCases) { option in
                    Text("\(option.title) — \(option.url)").tag(option)
                }
            }
            .pickerStyle(.radioGroup)
            Text("Changing this restarts the connection and creates a new code.")
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
