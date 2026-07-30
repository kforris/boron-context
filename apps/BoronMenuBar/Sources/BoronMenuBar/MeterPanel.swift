import Charts
import SwiftUI

private enum BoronPalette {
    static let background = Color(red: 0.055, green: 0.063, blue: 0.059)
    static let panel = Color.white.opacity(0.055)
    static let border = Color.white.opacity(0.10)
    static let primary = Color(red: 0.70, green: 1.00, blue: 0.33)
    static let secondary = Color(red: 0.42, green: 0.78, blue: 0.86)
    static let muted = Color.white.opacity(0.56)
}

struct MeterPanel: View {
    @ObservedObject var store: MeterStore

    var body: some View {
        ZStack {
            BoronPalette.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header

                    if let meter = store.meter {
                        hero(meter)
                        tokenChart(meter)
                        compressionCard(meter)
                        operationalGrid(meter)
                    } else {
                        emptyState
                    }

                    footer
                }
                .padding(18)
            }
        }
        .frame(width: 390, height: 570)
        .preferredColorScheme(.dark)
    }

    private var header: some View {
        HStack(spacing: 11) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(BoronPalette.primary)
                    .frame(width: 38, height: 38)
                Image(systemName: "hexagon.fill")
                    .font(.system(size: 19, weight: .bold))
                    .foregroundStyle(BoronPalette.background)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("BORON CONTEXT")
                    .font(.system(size: 14, weight: .bold, design: .rounded))
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
        VStack(alignment: .leading, spacing: 5) {
            Text("CONTEXT REDUCTION · \(meter.windowDays) DAYS")
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundStyle(BoronPalette.muted)
                .tracking(0.9)

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(MetricFormatting.percentage(meter.selectionReductionRatio))
                    .font(.system(size: 46, weight: .bold, design: .rounded))
                    .foregroundStyle(BoronPalette.primary)
                Text("of ranked candidate context filtered")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(BoronPalette.muted)
                    .frame(maxWidth: 150, alignment: .leading)
            }

            Text(
                "\(MetricFormatting.compactTokens(meter.recoveredContextTokens)) tokens recovered from prior work · "
                    + "\(String(format: "%.1f", meter.manualReentryEquivalentMinutes)) min re-entry equivalent"
            )
            .font(.caption)
            .foregroundStyle(.white.opacity(0.82))
        }
    }

    private func tokenChart(_ meter: ContextMeterSummary) -> some View {
        VStack(alignment: .leading, spacing: 12) {
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
            .frame(height: 128)
        }
        .card()
    }

    private func compressionCard(_ meter: ContextMeterSummary) -> some View {
        let ratio = meter.sourceCompressionRatio ?? 0
        return VStack(alignment: .leading, spacing: 10) {
            sectionTitle(
                "SOURCE COMPRESSION",
                trailing: meter.sourceCompressionRatio.map(MetricFormatting.percentage) ?? "not measured"
            )
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.08))
                    Capsule()
                        .fill(BoronPalette.primary)
                        .frame(width: max(5, proxy.size.width * ratio))
                }
            }
            .frame(height: 7)

            Text(
                meter.sourceTokens > 0
                    ? "\(MetricFormatting.compactTokens(meter.sourceTokens)) source → "
                        + "\(MetricFormatting.compactTokens(meter.sourceExcerptTokens)) excerpt tokens"
                    : "Add source-token estimates to measure document-level compression."
            )
            .font(.caption)
            .foregroundStyle(BoronPalette.muted)
        }
        .card()
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
                title: "LAYERS",
                value: "\(store.health?.adapters.filter(\.ok).count ?? 0)/3",
                note: "healthy"
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
        .frame(maxWidth: .infinity, minHeight: 280)
        .card()
    }

    private var footer: some View {
        VStack(spacing: 10) {
            HStack {
                Text(
                    store.lastUpdated.map {
                        "Updated \($0.formatted(date: .omitted, time: .shortened)) · auto 15s"
                    } ?? "Not updated yet"
                )
                .font(.caption2)
                .foregroundStyle(BoronPalette.muted)

                Spacer()

                Button("Repository") { store.openRepository() }
                    .buttonStyle(.link)
            }

            Text("Measured retrieval is shown separately from estimated human re-entry time.")
                .font(.system(size: 9))
                .foregroundStyle(Color.white.opacity(0.34))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func sectionTitle(_ title: String, trailing: String) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .tracking(0.8)
                .foregroundStyle(BoronPalette.muted)
            Spacer()
            Text(trailing)
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .foregroundStyle(.white.opacity(0.74))
        }
    }

    private func metricTile(title: String, value: String, note: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.system(size: 9, weight: .semibold, design: .rounded))
                .foregroundStyle(BoronPalette.muted)
            Text(value)
                .font(.system(size: 17, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            Text(note)
                .font(.system(size: 9))
                .foregroundStyle(Color.white.opacity(0.38))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(11)
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

private extension View {
    func card() -> some View {
        padding(14)
            .background(BoronPalette.panel, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .stroke(BoronPalette.border, lineWidth: 1)
            }
    }
}
