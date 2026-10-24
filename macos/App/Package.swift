// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MapleAtlasCompanion",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "MapleAtlasCompanion",
            path: "Sources/MapleAtlasCompanion"
        )
    ]
)
