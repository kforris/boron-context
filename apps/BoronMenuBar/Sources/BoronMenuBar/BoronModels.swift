import Foundation

struct BoronHealth: Decodable, Sendable {
    let ok: Bool
    let service: String
    let version: String
    let database: ComponentHealth
    let adapters: [AdapterHealth]
}

struct ComponentHealth: Decodable, Sendable {
    let ok: Bool
    let detail: String?
}

struct AdapterHealth: Decodable, Identifiable, Sendable {
    let name: String
    let layer: String
    let ok: Bool
    let detail: String?

    var id: String { layer }
}

struct ContextMeterSummary: Decodable, Sendable {
    let windowDays: Int
    let project: String?
    let samples: Int
    let candidateTokens: Int
    let capsuleTokens: Int
    let filteredTokens: Int
    let selectionReductionRatio: Double
    let recoveredContextTokens: Int
    let manualReentryEquivalentMinutes: Double
    let typingWordsPerMinute: Double
    let sourceEstimateCoveredEvidence: Int
    let sourceTokens: Int
    let sourceExcerptTokens: Int
    let sourceCompressionTokens: Int
    let sourceCompressionRatio: Double?
    let averageRetrievalLatencyMs: Double
    let boronLlm: BoronLLMUsage
    let caveats: [String]
}

struct BoronLLMUsage: Decodable, Sendable {
    let provider: String
    let model: String
    let calls: Int
    let inputTokens: Int
    let outputTokens: Int
}

struct MeterRequest: Encodable, Sendable {
    let projectHint: String
    let windowDays: Int
    let typingWordsPerMinute: Double
}

struct TokenBar: Identifiable, Sendable {
    let label: String
    let value: Int
    let role: Role

    var id: String { label }

    enum Role: Sendable {
        case candidate
        case capsule
        case filtered
    }
}

enum MetricFormatting {
    static func compactTokens(_ value: Int) -> String {
        if value >= 1_000_000 {
            return String(format: "%.1fM", Double(value) / 1_000_000)
        }
        if value >= 1_000 {
            return String(format: "%.1fk", Double(value) / 1_000)
        }
        return "\(value)"
    }

    static func percentage(_ ratio: Double) -> String {
        "\(Int((ratio * 100).rounded()))%"
    }

    static func duration(_ milliseconds: Double) -> String {
        if milliseconds < 1 {
            return "<1 ms"
        }
        return "\(Int(milliseconds.rounded())) ms"
    }
}
