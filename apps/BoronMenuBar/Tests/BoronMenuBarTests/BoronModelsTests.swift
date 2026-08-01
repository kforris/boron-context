import Foundation
import Testing
@testable import BoronMenuBar

@Test func decodesContextMeterSummary() throws {
    let data = Data(
        """
        {
          "windowDays": 30,
          "project": "Boron Context",
          "samples": 3,
          "candidateTokens": 2758,
          "capsuleTokens": 1987,
          "filteredTokens": 771,
          "selectionReductionRatio": 0.2795,
          "reExplanation": {
            "evidenceCount": 7,
            "avoidedTokens": 1447,
            "manualReentryEquivalentMinutes": 27.13,
            "typingWordsPerMinute": 40,
            "basis": "selected_prior_activity_excerpt"
          },
          "sourceWindow": {
            "status": "measured_partial",
            "measuredSamples": 1,
            "selectedEvidenceCount": 12,
            "coveredEvidenceCount": 1,
            "coverageRatio": 0.0833,
            "originalTokens": 2994,
            "capsuleTokens": 62,
            "savingsTokens": 2932,
            "savingsRatio": 0.9793
          },
          "averageRetrievalLatencyMs": 16.67,
          "boronLlm": {
            "provider": "none",
            "model": "none",
            "calls": 0,
            "inputTokens": 0,
            "outputTokens": 0
          },
          "caveats": ["Measured, not billed."]
        }
        """.utf8
    )

    let summary = try JSONDecoder().decode(ContextMeterSummary.self, from: data)
    #expect(summary.samples == 3)
    #expect(summary.filteredTokens == 771)
    #expect(summary.reExplanation.avoidedTokens == 1447)
    #expect(summary.sourceWindow.coveredEvidenceCount == 1)
    #expect(summary.boronLlm.calls == 0)
}

@Test func decodesUncoveredSourceWindow() throws {
    let data = Data(
        """
        {
          "status": "not_covered",
          "measuredSamples": 0,
          "selectedEvidenceCount": 4,
          "coveredEvidenceCount": 0,
          "coverageRatio": 0,
          "originalTokens": null,
          "capsuleTokens": null,
          "savingsTokens": null,
          "savingsRatio": null
        }
        """.utf8
    )

    let source = try JSONDecoder().decode(SourceWindowMetric.self, from: data)
    #expect(source.isCovered == false)
    #expect(source.savingsTokens == nil)
}

@Test func formatsCompactMetrics() {
    #expect(MetricFormatting.compactTokens(999) == "999")
    #expect(MetricFormatting.compactTokens(2_758) == "2.8k")
    #expect(MetricFormatting.percentage(0.2795) == "28%")
    #expect(MetricFormatting.duration(16.67) == "17 ms")
}
