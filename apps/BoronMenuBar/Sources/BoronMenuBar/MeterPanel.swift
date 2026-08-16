import AppKit
import Charts
import SwiftUI

private enum BoronPalette {
    static let background = Color(red: 0.055, green: 0.063, blue: 0.059)
    static let panel = Color.white.opacity(0.075)
    static let border = Color.white.opacity(0.16)
    static let primary = Color(red: 0.70, green: 1.00, blue: 0.33)
    static let secondary = Color(red: 0.42, green: 0.78, blue: 0.86)
    static let text = Color.white.opacity(0.96)
    static let muted = Color.white.opacity(0.74)
    static let subtle = Color.white.opacity(0.56)
}

enum PanelZoomPolicy {
    static let minimumZoom = 0.85
    static let defaultZoom = 1.10
    static let absoluteMaximumZoom = 1.40

    static func maximumZoom(visibleHeight: CGFloat, contentHeight: CGFloat) -> Double {
        guard visibleHeight > 0, contentHeight > 0 else { return defaultZoom }
        let seventyPercentHeight = Double(visibleHeight * 0.70)
        return max(minimumZoom, min(absoluteMaximumZoom, seventyPercentHeight / Double(contentHeight)))
    }

    static func clampedZoom(_ zoom: Double, maximumZoom: Double) -> Double {
        min(maximumZoom, max(minimumZoom, zoom))
    }
}

struct MeterPanel: View {
    private static let basePanelWidth: CGFloat = 410
    private static let defaultPanelHeight: CGFloat = 607

    @ObservedObject var store: MeterStore
    @AppStorage("boronPanelZoom") private var requestedZoom = PanelZoomPolicy.defaultZoom
    @State private var basePanelHeight = Self.defaultPanelHeight

    var body: some View {
        ZStack(alignment: .topLeading) {
            panelContent
                .background {
                    GeometryReader { proxy in
                        Color.clear.preference(key: PanelHeightKey.self, value: proxy.size.height)
                    }
                }
                .scaleEffect(effectiveZoom, anchor: .topLeading)
        }
        .frame(
            width: Self.basePanelWidth * effectiveZoom,
            height: basePanelHeight * effectiveZoom,
            alignment: .topLeading
        )
        .onPreferenceChange(PanelHeightKey.self) { height in
            guard height > 0 else { return }
            basePanelHeight = height
            requestedZoom = clampedZoom(requestedZoom)
        }
        .onAppear { requestedZoom = clampedZoom(requestedZoom) }
        .foregroundStyle(BoronPalette.text)
        .preferredColorScheme(.dark)
    }

    private var panelContent: some View {
        ZStack {
            BoronPalette.background.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 8) {
                header

                if let meter = store.meter {
                    hero(meter)
                    tokenChart(meter)
                    sourceWindowCard(meter)
                    auditCard
                    operationalGrid(meter)
                } else {
                    emptyState
                }

                footer
            }
            .padding(10)
        }
        .frame(width: Self.basePanelWidth)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var effectiveZoom: CGFloat {
        CGFloat(clampedZoom(requestedZoom))
    }

    private var maximumZoom: Double {
        let visibleHeight = NSScreen.main?.visibleFrame.height ?? 900
        return PanelZoomPolicy.maximumZoom(
            visibleHeight: visibleHeight,
            contentHeight: basePanelHeight
        )
    }

    private func clampedZoom(_ zoom: Double) -> Double {
        PanelZoomPolicy.clampedZoom(zoom, maximumZoom: maximumZoom)
    }

    private func zoom(by amount: Double) {
        requestedZoom = clampedZoom(requestedZoom + amount)
    }

    private var header: some View {
        HStack(spacing: 11) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(BoronPalette.primary)
                    .frame(width: 34, height: 34)
                Image(systemName: "hexagon.fill")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(BoronPalette.background)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("BORON CONTEXT")
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .tracking(1.1)
                HStack(spacing: 5) {
                    Circle()
                        .fill(store.isHealthy ? BoronPalette.primary : .red)
                        .frame(width: 6, height: 6)
                    Text(store.isHealthy ? "Daemon + PostgreSQL online" : "Boron unavailable")
                        .font(.caption)
                        .foregroundStyle(BoronPalette.muted)
                }
            }

            Spacer()

            Button {
                Task { await store.openInspector() }
            } label: {
                Label("Content", systemImage: "point.3.connected.trianglepath.dotted")
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .foregroundStyle(BoronPalette.background)
                    .background(BoronPalette.primary, in: Capsule())
            }
            .buttonStyle(.plain)
            .disabled(store.isOpeningInspector || !store.isHealthy)
            .opacity(store.isOpeningInspector || !store.isHealthy ? 0.55 : 1)
            .help("Open Boron Content Inspector")

            Button {
                Task { await store.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .rotationEffect(store.isRefreshing ? .degrees(360) : .zero)
                    .animation(
                        store.isRefreshing
                            ? .linear(duration: 0.9).repeatForever(autoreverses: false)
                            : .default,
                        value: store.isRefreshing
                    )
            }
            .buttonStyle(.plain)
            .disabled(store.isRefreshing)
            .help("Refresh now")
        }
    }

    private func hero(_ meter: ContextMeterSummary) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("RE-EXPLANATION AVOIDED · \(meter.windowDays) DAYS")
                .font(.system(size: 9, weight: .semibold, design: .rounded))
                .foregroundStyle(BoronPalette.muted)
                .tracking(0.9)

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(MetricFormatting.compactTokens(meter.reExplanation.avoidedTokens))
                    .font(.system(size: 36, weight: .bold, design: .rounded))
                    .foregroundStyle(BoronPalette.primary)
                Text("verified prior-context tokens selected for reuse")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(BoronPalette.muted)
                    .frame(maxWidth: 150, alignment: .leading)
            }

            Text(
                "\(meter.reExplanation.evidenceCount) prior activity excerpts · "
                    + "\(String(format: "%.1f", meter.reExplanation.manualReentryEquivalentMinutes)) min typing equivalent (estimated)"
            )
            .font(.system(size: 10))
            .foregroundStyle(.white.opacity(0.82))
        }
    }

    private func tokenChart(_ meter: ContextMeterSummary) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            sectionTitle("CONTEXT FLOW", trailing: "\(meter.samples) samples")

            Chart(store.tokenBars) { item in
                BarMark(
                    x: .value("Stage", item.label),
                    y: .value("Tokens", item.value)
                )
                .foregroundStyle(barColor(item.role))
                .cornerRadius(4)
                .annotation(position: .top) {
                    Text(MetricFormatting.compactTokens(item.value))
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.72))
                }
            }
            .chartXAxis {
                AxisMarks { value in
                    AxisValueLabel {
                        if let label = value.as(String.self) {
                            Text(label)
                                .font(.system(size: 9, weight: .medium))
                                .foregroundStyle(BoronPalette.muted)
                        }
                    }
                }
            }
            .chartYAxis(.hidden)
            .frame(height: 76)
        }
        .card()
    }

    private func sourceWindowCard(_ meter: ContextMeterSummary) -> some View {
        let source = meter.sourceWindow
        let eligibility = source.eligibility
        let ratio = eligibility?.ratio ?? source.coverageRatio
        return VStack(alignment: .leading, spacing: 6) {
            sectionTitle(
                "ELIGIBLE SOURCE COVERAGE",
                trailing: MetricFormatting.percentage(ratio)
            )
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.08))
                    if source.isCovered {
                        Capsule()
                            .fill(BoronPalette.primary)
                            .frame(width: max(5, proxy.size.width * ratio))
                    }
                }
            }
            .frame(height: 7)

            Text(
                eligibility.map {
                    "\($0.numerator)/\($0.eligibleDenominator) eligible measured · "
                        + "\($0.ineligible) ineligible · \($0.unobservable) unobservable"
                }
                    ?? "Legacy mixed coverage \(source.coveredEvidenceCount)/\(source.selectedEvidenceCount)"
            )
            .font(.system(size: 9))
            .foregroundStyle(BoronPalette.muted)
            .lineLimit(2)
        }
        .card()
    }

    @ViewBuilder
    private var auditCard: some View {
        if let sample = store.audit?.samples.first {
            VStack(alignment: .leading, spacing: 6) {
                sectionTitle(
                    "READ-ONLY AUDIT · LATEST",
                    trailing: sample.createdAt.formatted(date: .omitted, time: .shortened)
                )

                ForEach(sample.retrievalPlan.stages) { stage in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(stage.order)")
                            .font(.system(size: 9, weight: .bold, design: .monospaced))
                            .foregroundStyle(BoronPalette.primary)
                        Text("\(stage.layer) · \(stage.purpose)")
                            .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        Spacer()
                        Text("\(stage.candidateEvidenceCount) candidates")
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(BoronPalette.muted)
                    }
                }

                Divider().overlay(BoronPalette.border)

                let selected = sample.evidence.filter(\.selected)
                Text(
                    "\(sample.candidateEvidenceCount) candidate / \(sample.selectedEvidenceCount) selected · "
                        + "\(sample.sourceWindowEligibility?.numerator ?? sample.sourceWindowCoveredEvidenceCount) source estimates covered"
                )
                .font(.caption)
                .foregroundStyle(BoronPalette.muted)

                Text(selected.first?.title ?? "No evidence selected")
                    .font(.system(size: 9, weight: .medium))
                    .lineLimit(1)
                    .foregroundStyle(BoronPalette.subtle)
            }
            .card()
        }
    }

    private func operationalGrid(_ meter: ContextMeterSummary) -> some View {
        HStack(spacing: 10) {
            metricTile(
                title: "RETRIEVAL",
                value: MetricFormatting.duration(meter.averageRetrievalLatencyMs),
                note: "average latency"
            )
            metricTile(
                title: "BORON LLM",
                value: "\(meter.boronLlm.calls)",
                note: "owned calls"
            )
            metricTile(
                title: "ADAPTERS",
                value: "\(store.health?.adapters.filter(\.ok).count ?? 0)",
                note: adapterNote
            )
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "waveform.path.ecg")
                .font(.system(size: 32))
                .foregroundStyle(BoronPalette.primary)
            Text(store.errorMessage ?? "Waiting for Boron Context metrics…")
                .font(.callout)
                .multilineTextAlignment(.center)
                .foregroundStyle(BoronPalette.muted)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
        .card()
    }

    private var footer: some View {
        VStack(spacing: 5) {
            HStack(spacing: 8) {
                Text(
                    store.lastUpdated.map {
                        "Updated \($0.formatted(date: .omitted, time: .shortened)) · auto 15s"
                    } ?? "Not updated yet"
                )
                .font(.system(size: 9))
                .foregroundStyle(BoronPalette.muted)

                Spacer()

                zoomControls
                    .fixedSize()

                Button("Repository") { store.openRepository() }
                    .buttonStyle(.link)
            }

            Text("Re-explanation reuse and source-window savings are separate; uncovered sources show no savings claim.")
                .font(.system(size: 8))
                .foregroundStyle(BoronPalette.subtle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(2)
        }
    }

    private var zoomControls: some View {
        HStack(spacing: 3) {
            Button { zoom(by: -0.10) } label: {
                Image(systemName: "minus")
            }
            .keyboardShortcut("-", modifiers: .command)
            .disabled(requestedZoom <= PanelZoomPolicy.minimumZoom)
            .accessibilityLabel("Zoom out")
            .help("Zoom out (Command-minus)")

            Button {
                requestedZoom = clampedZoom(PanelZoomPolicy.defaultZoom)
            } label: {
                Text("\(Int((effectiveZoom * 100).rounded()))%")
                    .font(.system(size: 8, weight: .semibold, design: .monospaced))
                    .frame(minWidth: 30)
            }
            .keyboardShortcut("0", modifiers: .command)
            .accessibilityLabel("Reset zoom")
            .help("Reset zoom (Command-0)")

            Button { zoom(by: 0.10) } label: {
                Image(systemName: "plus")
            }
            .keyboardShortcut("+", modifiers: .command)
            .disabled(requestedZoom >= maximumZoom - 0.001)
            .accessibilityLabel("Zoom in")
            .help("Zoom in (Command-plus, max 70% of screen height)")
        }
        .font(.system(size: 8, weight: .semibold))
        .buttonStyle(.plain)
        .foregroundStyle(BoronPalette.muted)
    }

    private var adapterNote: String {
        let adapters = store.health?.adapters.filter(\.ok) ?? []
        let ontology = adapters.filter { $0.sourceType == "ontology" }.count
        let live = adapters.filter { $0.sourceType == "live" }.count
        let snapshots = adapters.filter { $0.sourceType == "snapshot" }.count
        return "O\(ontology) · live\(live) · snap\(snapshots)"
    }

    private func sectionTitle(_ title: String, trailing: String) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 9, weight: .semibold, design: .rounded))
                .tracking(0.8)
                .foregroundStyle(BoronPalette.muted)
            Spacer()
            Text(trailing)
                .font(.system(size: 9, weight: .medium, design: .monospaced))
                .foregroundStyle(.white.opacity(0.74))
        }
    }

    private func metricTile(title: String, value: String, note: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.system(size: 9, weight: .semibold, design: .rounded))
                .foregroundStyle(BoronPalette.muted)
            Text(value)
                .font(.system(size: 15, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            Text(note)
                .font(.system(size: 9))
                .foregroundStyle(BoronPalette.subtle)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(BoronPalette.panel, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(BoronPalette.border, lineWidth: 1)
        }
    }

    private func barColor(_ role: TokenBar.Role) -> Color {
        switch role {
        case .candidate: .white.opacity(0.24)
        case .capsule: BoronPalette.secondary
        case .filtered: BoronPalette.primary
        }
    }
}

private struct PanelHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 607

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private extension View {
    func card() -> some View {
        padding(9)
            .background(BoronPalette.panel, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(BoronPalette.border, lineWidth: 1)
            }
    }
}
