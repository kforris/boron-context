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
    #expect(summary.sourceWindow.netSavingsTokens == nil)
    #expect(summary.sourceWindow.estimatedNetSavingsTokens == 2932)
    #expect(summary.sourceWindow.netEstimateNote.contains("legacy"))
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
    #expect(source.estimatedNetSavingsTokens == nil)
    #expect(source.netSavingsRatio == nil)
    #expect(MetricFormatting.sourceNetChange(source.netSavingsRatio) == "Unmeasured")
}

@Test func displaysExpansionDespitePositiveLegacySavings() throws {
    let source = try decodeSourceWindow(original: 1000, capsule: 1500, net: -500)
    #expect(source.estimatedNetSavingsTokens == -500)
    #expect(source.netSavingsRatio == -0.5)
    #expect(MetricFormatting.sourceNetChange(source.netSavingsRatio) == "50% larger")
    #expect(MetricFormatting.sourceNetChange(source.netSavingsRatio, compact: true) == "↑50%")
}

@Test func derivesHonestExpansionForLegacyServer() throws {
    let source = try decodeSourceWindow(original: 1000, capsule: 1500, net: nil)
    #expect(source.netSavingsTokens == nil)
    #expect(source.netSavingsRatio == -0.5)
    #expect(source.netEstimateNote.contains("legacy"))
    #expect(MetricFormatting.sourceNetChange(source.netSavingsRatio) == "50% larger")
}

@Test func displaysSavingsAndZeroWithoutClampingNetChange() throws {
    let saving = try decodeSourceWindow(original: 1000, capsule: 600, net: 400)
    let unchanged = try decodeSourceWindow(original: 1000, capsule: 1000, net: 0)
    #expect(MetricFormatting.sourceNetChange(saving.netSavingsRatio) == "40% smaller")
    #expect(MetricFormatting.sourceNetChange(saving.netSavingsRatio, compact: true) == "↓40%")
    #expect(MetricFormatting.sourceNetChange(unchanged.netSavingsRatio) == "No change")
    #expect(MetricFormatting.sourceNetChange(unchanged.netSavingsRatio, compact: true) == "0%")
}

@Test func keepsNetRatioUnknownWithoutAPositiveSourceWindow() throws {
    let missing = try decodeSourceWindow(original: nil, capsule: nil, net: nil)
    let zero = try decodeSourceWindow(original: 0, capsule: 50, net: -50)
    #expect(missing.netSavingsRatio == nil)
    #expect(zero.netSavingsRatio == nil)
    #expect(MetricFormatting.sourceNetChange(missing.netSavingsRatio, compact: true) == "—")
}

private func decodeSourceWindow(original: Int?, capsule: Int?, net: Int?) throws -> SourceWindowMetric {
    // Positive legacy fields deliberately disagree with expansion: callers must
    // use the signed field, or derive it from the measured totals when absent.
    var payload: [String: Any] = [
        "status": "measured_partial", "measuredSamples": 2,
        "selectedEvidenceCount": 3, "coveredEvidenceCount": 2, "coverageRatio": 0.6667,
        "savingsTokens": 200, "savingsRatio": 0.2
    ]
    payload["originalTokens"] = original
    payload["capsuleTokens"] = capsule
    payload["netSavingsTokens"] = net
    return try JSONDecoder().decode(SourceWindowMetric.self, from: JSONSerialization.data(withJSONObject: payload))
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

@Test func configuresIsolatedMenuClientFromExplicitEnvironment() {
    let client = BoronClient(environment: [
        "BORON_DAEMON_URL": "http://127.0.0.1:55555",
        "BORON_TOKEN_FILE": "/tmp/boron-test/daemon.token",
        "BORON_DAEMON_TOKEN": "must-not-be-used"
    ])
    #expect(client.baseURL.absoluteString == "http://127.0.0.1:55555")
    #expect(client.tokenURL.path == "/tmp/boron-test/daemon.token")
}

@Test func acceptsOnlyCredentialFreeLoopbackOrigins() {
    for value in ["http://127.0.0.1:55555", "https://localhost:4443/", "http://[::1]:55555"] {
        #expect(BoronClient.isLoopbackOrigin(value))
    }
    for value in [
        "https://example.org", "http://127.0.0.1.example.org", "http://user:secret@localhost",
        "http://localhost/path", "http://localhost?secret=x", "http://localhost#token",
        "file:///tmp/daemon", "http://localhost\n"
    ] {
        #expect(!BoronClient.isLoopbackOrigin(value))
    }
}

@Test func invalidMenuEnvironmentFailsBeforeAnyNetworkOrTokenRead() async {
    let client = BoronClient(environment: [
        "BORON_DAEMON_URL": "https://example.org",
        "BORON_TOKEN_FILE": "/does/not/exist"
    ])
    do {
        _ = try await client.health()
        Issue.record("Invalid configuration must not reach the network")
    } catch BoronClientError.invalidConfiguration {
        // Expected: the default production origin is never used as a fallback.
    } catch {
        Issue.record("Unexpected configuration result: \(error)")
    }
    let relativeToken = BoronClient(environment: ["BORON_TOKEN_FILE": "relative-token"])
    do {
        _ = try await relativeToken.meter()
        Issue.record("Relative token path must be rejected")
    } catch BoronClientError.invalidConfiguration {
    } catch {
        Issue.record("Unexpected token configuration result: \(error)")
    }
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
