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
          "recoveredContextTokens": 1447,
          "manualReentryEquivalentMinutes": 27.13,
          "typingWordsPerMinute": 40,
          "sourceEstimateCoveredEvidence": 1,
          "sourceTokens": 2994,
          "sourceExcerptTokens": 62,
          "sourceCompressionTokens": 2932,
          "sourceCompressionRatio": 0.9793,
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
    #expect(summary.boronLlm.calls == 0)
}

@Test func formatsCompactMetrics() {
    #expect(MetricFormatting.compactTokens(999) == "999")
    #expect(MetricFormatting.compactTokens(2_758) == "2.8k")
    #expect(MetricFormatting.percentage(0.2795) == "28%")
    #expect(MetricFormatting.duration(16.67) == "17 ms")
}
