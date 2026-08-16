import Foundation

enum BoronJSONDecoder {
    static func make() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)

            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fractional.date(from: value) {
                return date
            }

            let standard = ISO8601DateFormatter()
            standard.formatOptions = [.withInternetDateTime]
            if let date = standard.date(from: value) {
                return date
            }

            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Expected an ISO 8601 date with optional fractional seconds."
            )
        }
        return decoder
    }
}

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
    let sourceType: String
    let ok: Bool
    let detail: String?

    var id: String { "\(layer):\(name)" }
}

struct ContextMeterSummary: Decodable, Sendable {
    let windowDays: Int
    let project: String?
    let samples: Int
    let candidateTokens: Int
    let capsuleTokens: Int
    let filteredTokens: Int
    let selectionReductionRatio: Double
    let reExplanation: ReExplanationMetric
    let sourceWindow: SourceWindowMetric
    let averageRetrievalLatencyMs: Double
    let boronLlm: BoronLLMUsage
    let caveats: [String]
}

struct ReExplanationMetric: Decodable, Sendable {
    let evidenceCount: Int
    let avoidedTokens: Int
    let manualReentryEquivalentMinutes: Double
    let typingWordsPerMinute: Double
    let basis: String
}

struct SourceWindowMetric: Decodable, Sendable {
    let status: String
    let measuredSamples: Int
    let selectedEvidenceCount: Int
    let coveredEvidenceCount: Int
    let coverageRatio: Double
    let originalTokens: Int?
    let capsuleTokens: Int?
    let savingsTokens: Int?
    let savingsRatio: Double?
    let eligibility: SourceCoverageEligibility?

    var isCovered: Bool { status != "not_covered" }
}

struct SourceCoverageEligibility: Decodable, Sendable {
    let contractVersion: Int
    let numerator: Int
    let eligibleDenominator: Int
    let ratio: Double
    let ineligible: Int
    let unobservable: Int
    let reasons: SourceCoverageReasonGroups
}

struct SourceCoverageReasonGroups: Decodable, Sendable {
    let eligible: [String: Int]
    let ineligible: [String: Int]
    let unobservable: [String: Int]
}

struct ContextMeterAudit: Decodable, Sendable {
    let summary: ContextMeterSummary
    let samples: [ContextMeterAuditSample]
}

struct ContextMeterAuditSample: Decodable, Identifiable, Sendable {
    let id: String
    let capsuleId: String
    let traceId: String
    let project: String?
    let client: String
    let createdAt: Date
    let retrievalPlan: RetrievalPlanPreview
    let candidateEvidenceCount: Int
    let selectedEvidenceCount: Int
    let candidateTokens: Int
    let capsuleTokens: Int
    let filteredTokens: Int
    let reExplanationAvoidedTokens: Int
    let sourceWindowStatus: String
    let sourceWindowCoveredEvidenceCount: Int
    let sourceWindowOriginalTokens: Int?
    let sourceWindowCapsuleTokens: Int?
    let sourceWindowSavingsTokens: Int?
    let sourceWindowEligibility: SourceCoverageEligibility?
    let retrievalLatencyMs: Int
    let evidence: [EvidenceAuditPreview]
}

struct RetrievalPlanPreview: Decodable, Sendable {
    let version: Int
    let strategy: String
    let riskClass: String
    let signals: [String]
    let sourceAnchors: [String]
    let stages: [RetrievalStagePreview]
}

struct RetrievalStagePreview: Decodable, Identifiable, Sendable {
    let id: String
    let order: Int
    let layer: String
    let purpose: String
    let reason: String
    let trigger: String
    let status: String
    let adapters: [RetrievalAdapterPreview]
    let candidateEvidenceCount: Int
    let latencyMs: Int
}

struct RetrievalAdapterPreview: Decodable, Sendable {
    let name: String
    let sourceType: String
    let status: String
    let detail: String?
}

struct EvidenceAuditPreview: Decodable, Identifiable, Sendable {
    let evidenceId: String
    let layer: String
    let title: String
    let uri: String
    let adapter: String
    let sourceType: String
    let stageId: String
    let candidateTokens: Int
    let selected: Bool
    let score: Double
    let sourceTokenEstimate: Int?
    let sourceCoverageStatus: String?
    let sourceCoverageReason: String?

    var id: String { "\(evidenceId):\(stageId):\(adapter)" }
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

struct MeterAuditRequest: Encodable, Sendable {
    let projectHint: String
    let windowDays: Int
    let typingWordsPerMinute: Double
    let limit: Int
}

struct InspectorTicket: Decodable, Sendable {
    let ticket: String
    let url: String
    let expiresAt: Date
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
