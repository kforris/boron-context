// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BoronMenuBar",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "BoronMenuBar", targets: ["BoronMenuBar"])
    ],
    targets: [
        .executableTarget(
            name: "BoronMenuBar",
            path: "Sources/BoronMenuBar"
        ),
        .testTarget(
            name: "BoronMenuBarTests",
            dependencies: ["BoronMenuBar"],
            path: "Tests/BoronMenuBarTests"
        )
    ]
)
