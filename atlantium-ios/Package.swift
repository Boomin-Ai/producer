// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "AtlantiumCore", platforms: [.macOS(.v13)], products: [.library(name: "AtlantiumCore", targets: ["AtlantiumCore"])], targets: [.target(name: "AtlantiumCore", path: "Core"), .testTarget(name: "AtlantiumCoreTests", dependencies: ["AtlantiumCore"], path: "Tests/AtlantiumCoreTests")])
