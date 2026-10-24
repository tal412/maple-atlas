import AppKit
import SwiftUI

@main
struct MapleAtlasCompanionApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Window("Maple Atlas Companion", id: "main") {
            ContentView(model: appDelegate.model)
        }
        .defaultSize(width: 560, height: 900)
        .windowResizability(.contentMinSize)

        Window("Diagnostics", id: "log") {
            LogView(model: appDelegate.model)
        }
        .defaultSize(width: 640, height: 420)

        Settings {
            SettingsView(model: appDelegate.model)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = CompanionModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Writing to a helper that has died must fail with an error, not kill the app.
        signal(SIGPIPE, SIG_IGN)
        NSApp.setActivationPolicy(.regular)
        model.start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        model.shutdown()
    }
}
