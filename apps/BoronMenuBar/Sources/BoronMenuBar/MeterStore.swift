import AppKit
import Foundation

@MainActor
final class MeterStore: ObservableObject {
    @Published private(set) var health: BoronHealth?
    @Published private(set) var meter: ContextMeterSummary?
    @Published private(set) var audit: ContextMeterAudit?
    @Published private(set) var isRefreshing = false
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var errorMessage: String?

    private let client: BoronClient
    private var refreshLoop: Task<Void, Never>?

    init(client: BoronClient = BoronClient()) {
        self.client = client
    }

    deinit {
        refreshLoop?.cancel()
    }

    var isHealthy: Bool {
        health?.ok == true
    }

    var menuTitle: String {
        guard isHealthy else { return "B !" }
        guard let meter else { return "B ·" }
        let reuse = MetricFormatting.compactTokens(meter.reExplanation.avoidedTokens)
        let source = meter.sourceWindow.savingsRatio.map(MetricFormatting.percentage) ?? "—"
        return "B R\(reuse) · S\(source)"
    }

    var tokenBars: [TokenBar] {
        guard let meter else { return [] }
        return [
            TokenBar(label: "Candidates", value: meter.candidateTokens, role: .candidate),
            TokenBar(label: "Capsules", value: meter.capsuleTokens, role: .capsule),
            TokenBar(label: "Filtered", value: meter.filteredTokens, role: .filtered),
        ]
    }

    func start() {
        guard refreshLoop == nil else { return }
        refreshLoop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        do {
            async let healthRequest = client.health()
            async let meterRequest = client.meter()
            let (health, meter) = try await (healthRequest, meterRequest)
            self.health = health
            self.meter = meter
            audit = try? await client.audit()
            lastUpdated = Date()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
            if health == nil {
                health = nil
            }
        }
    }

    func openRepository() {
        guard let url = URL(string: "https://github.com/kforris/boron-context") else { return }
        NSWorkspace.shared.open(url)
    }

}
