import SwiftUI

@main
struct BoronMenuBarApp: App {
    @StateObject private var store: MeterStore

    init() {
        let store = MeterStore()
        _store = StateObject(wrappedValue: store)
        store.start()
    }

    var body: some Scene {
        MenuBarExtra {
            MeterPanel(store: store)
        } label: {
            Label(store.menuTitle, systemImage: "hexagon.fill")
                .accessibilityLabel("Boron Context \(store.isHealthy ? "online" : "offline")")
        }
        .menuBarExtraStyle(.window)
    }
}
