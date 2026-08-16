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
            "savingsRatio": 0.9793,
            "eligibility": {
              "contractVersion": 2,
              "numerator": 1,
              "eligibleDenominator": 1,
              "ratio": 1,
              "ineligible": 9,
              "unobservable": 2,
              "reasons": {
                "eligible": {"live_source_measured": 1},
                "ineligible": {"ontology_derived": 9},
                "unobservable": {"legacy_unknown_size": 2}
              }
            }
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
    #expect(summary.sourceWindow.eligibility?.eligibleDenominator == 1)
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

@Test func decodesInspectorTicket() throws {
    let data = Data(
        """
        {
          "ticket": "00000000-0000-4000-8000-000000000000",
          "url": "/inspector?launch=11111111-1111-4111-8111-111111111111#ticket=00000000-0000-4000-8000-000000000000",
          "expiresAt": "2026-08-02T06:00:00.000Z"
        }
        """.utf8
    )
    let ticket = try BoronJSONDecoder.make().decode(InspectorTicket.self, from: data)
    #expect(ticket.url.hasPrefix("/inspector?launch="))
}

@Test func capsPanelZoomAtSeventyPercentOfVisibleHeight() {
    let maximum = PanelZoomPolicy.maximumZoom(visibleHeight: 1_020, contentHeight: 607)
    #expect(abs(maximum - 1.176_276_771) < 0.000_001)
    #expect(abs((607 * maximum) - 714) < 0.001)
    #expect(PanelZoomPolicy.clampedZoom(2, maximumZoom: maximum) == maximum)
    #expect(
        PanelZoomPolicy.clampedZoom(0.5, maximumZoom: maximum)
            == PanelZoomPolicy.minimumZoom
    )
}
