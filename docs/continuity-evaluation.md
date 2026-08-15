# Held-out continuity evaluation

Boron Context 0.7.5 adds a deterministic, offline regression gate for the retrieval and project
scope boundaries used by macOS + Codex. The suite is evidence for a release-candidate decision; it
does not authorize a public release.

## Contract

Run the versioned suite with:

```bash
npm run eval:continuity
```

The command reads only
[`eval/fixtures/continuity-held-out.v1.json`](../eval/fixtures/continuity-held-out.v1.json) and
[`eval/baselines/continuity.v1.json`](../eval/baselines/continuity.v1.json). Fixtures are synthetic,
secret-free, explicitly marked as not generated from private data, and never query production
PostgreSQL or a live source.

The contract reports:

- macro `recallAt5`: relevant evidence found in the first five selected excerpts, averaged by case;
- `meanReciprocalRank`: reciprocal rank of the first relevant excerpt, averaged by case;
- `relevantSourceCoverage`: relevant fixture evidence in the first five with a real
  `sourceTokenEstimate`, divided by all relevant fixture evidence;
- wrong-project retrieval and wrong-project writeback violations; and
- stable failure categories for fixture integrity, project resolution, routing, retrieval, rank,
  source coverage, and project scope.

The minimum release-candidate thresholds are recall@5 `0.80`, MRR `0.80`, relevant source coverage
`0.80`, and zero wrong-project retrieval/writeback. CI also rejects a regression below the frozen
0.7.5 baseline. The runner never updates that baseline; a fixture or baseline change requires an
ordinary reviewed code change with an explanation of the semantic difference.

## Boundary

Fixture source coverage is not the live product's source-estimate coverage. Report both numbers
separately. Passing this suite does not prove broad real-world semantic quality, mature adoption,
installer safety, rollback safety, privacy readiness, or product release readiness.
