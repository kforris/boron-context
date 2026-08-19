# Boron Context operating manual

[简体中文](operating-manual.zh-CN.md)

This manual is the operational contract for installing, upgrading, and using Boron Context. The
daemon is a local context substrate; the client agent remains responsible for reasoning,
permissions, execution, and presentation.

## 1. What the system owns

| Component            | Owns                                                                                     | Does not own                                                            |
| -------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Boron daemon         | Project and entity location, sourced capsules, retrieval audit, semantic activity ledger | Agent reasoning, tool permissions, action approval, raw source archives |
| Client agent         | Current verification, scoped execution, milestone selection, user handoff                | Treating old context as current truth                                   |
| PostgreSQL           | Ontology, selected evidence snapshots, sessions, activities, relations, meter audit      | Large files, secrets, raw transcripts                                   |
| Live source adapters | A bounded query to a configured source                                                   | Authority merely because an adapter is connected                        |
| Menu-bar meter       | Read-only local health, metrics, and audit preview                                       | Runtime control or an independent product UI                            |

The current release performs **0 Boron-owned LLM calls**. Retrieval uses deterministic PostgreSQL
search and routing. A normal project session uses a 2,000–4,000 token capsule budget; the hard
request limit is 16,000 estimated tokens.

## 2. Install on macOS

Requirements: Apple Silicon macOS 14 or newer, Node.js 20.19 or newer, and PostgreSQL 15 or newer.

```bash
git clone https://github.com/kforris/boron-context.git
cd boron-context
npm install

createdb boron_context
export BORON_DATABASE_URL='postgresql://127.0.0.1/boron_context'
npm run db:migrate
npm run build
npm run service:install

codex plugin marketplace add .
codex plugin add boron-context@boron-context
python3 scripts/install_menubar.py
```

### Optional menu-bar Meter

The final command builds the native Swift app, installs it at
`~/Applications/Boron Meter.app`, and registers
`~/Library/LaunchAgents/dev.boroncontext.menubar.plist` so it starts for the current macOS user at
login. A Boron hexagon and health status then appear in the menu bar; click the item to open the
read-only Context Meter.

<p align="center">
  <a href="assets/screenshots/v0.7.1/boron-menubar-finished-state.png">
    <img src="assets/screenshots/v0.7.1/boron-menubar-finished-state.png" alt="Finished Boron Context Meter in the macOS menu bar" width="620" />
  </a>
</p>

<p align="center"><sub>Real example from a populated local installation; metrics vary with each machine's projects and usage.</sub></p>

After installing or upgrading, inspect the exact `SessionStart` and `SessionEnd` commands once in a
Codex surface that exposes hook review (`/hooks` in the CLI), then start a new task. Codex skips new
or changed command hooks until this review. A desktop build without `/hooks` can use the same local
trust decision; verify a fresh task contains `Boron automatic project context`. The startup hook
injects bounded project context and performs a content-free ownership sync; it never sends titles,
prompts, previews, transcripts, or working directories in that history-sync payload.

## 3. Upgrade an existing local installation

Preserve your database and token file. Migrations are additive and idempotent. Create a backup before
changing the checkout or applying a migration:

```bash
npm run lifecycle:backup -- \
  --database-url 'postgresql://127.0.0.1/boron_context' \
  --output '/absolute/private/path/boron-before-upgrade.dump'
```

The command refuses to overwrite an existing artifact, sets mode `0600`, and writes a neighbouring
JSON receipt with its SHA-256. Database passwords are not written to arguments or receipts.

```bash
git pull --ff-only
npm ci
export BORON_DATABASE_URL='postgresql://127.0.0.1/boron_context'
npm run db:migrate
npm run check
npm run service:install
python3 scripts/install_menubar.py
codex plugin add boron-context@boron-context
```

Then repeat hook review in a surface that exposes it because changed hook definitions receive a new
trust hash, and start a new task. Do not judge the upgrade from a task that loaded the previous
plugin version.

The plugin version includes a deterministic 12-hex payload digest. `npm run check` verifies that the
digest covers the complete bundled plugin, so a source change cannot silently reuse an old Codex
cache key. Do not edit files under `~/.codex/plugins/cache` or hard-code that directory. Codex owns
the versioned `<marketplace>/<plugin>/<version>` layout; for this local marketplace, the repeated
`boron-context/boron-context` path segment is expected rather than evidence of folder drift.

To diagnose an installation, use the plugin registry first:

```bash
codex plugin list --marketplace boron-context --json
rg --files "${CODEX_HOME:-$HOME/.codex}/plugins/cache/boron-context" \
  | rg '/context-continuity/SKILL\.md$'
```

Only report source/cache drift when the registry-selected installed artifact differs from the
current marketplace payload. A manually shortened path that omits either the marketplace or plugin
segment is not a Boron health failure.

### Restore and rollback

Restore only into a newly created, empty database. The helper rejects a target containing user
objects and requires the backup checksum from its receipt:

```bash
createdb boron_context_restore
npm run lifecycle:restore -- \
  --database-url 'postgresql://127.0.0.1/boron_context_restore' \
  --input '/absolute/private/path/boron-before-upgrade.dump' \
  --expected-sha256 '<receipt sha256>' \
  --confirm-empty-target
```

For rollback, stop the current daemon, restore the pre-upgrade archive into a fresh database, point
`BORON_DATABASE_URL` at it, check out the previously verified commit, rebuild, reinstall launchd,
the menu app, and the Codex plugin, then verify `/health` and one known project read. Never migrate a
production database backward in place.

### Uninstall

Preview and then remove runtime surfaces. Durable data is always preserved:

```bash
npm run lifecycle:uninstall -- --dry-run --remove-codex-plugin --remove-codex-marketplace
npm run lifecycle:uninstall -- --remove-codex-plugin --remove-codex-marketplace \
  --receipt '/absolute/private/path/boron-uninstall-receipt.json'
```

This removes the three Boron launch agents when present, `~/Applications/Boron Meter.app`, and the
requested Codex registrations. It does not drop PostgreSQL, remove backups, or delete
`~/Library/Application Support/Boron Context` and `~/Library/Logs/Boron Context`.

### Isolated lifecycle rehearsal

Before a release-candidate decision, run the complete lifecycle in temporary macOS/Codex/PostgreSQL
state and retain the external receipt:

```bash
npm run lifecycle:rehearse -- \
  --previous-ref 23fbd277c1575d0aa48b89744ed2974bc4350693 \
  --receipt '/absolute/private/path/boron-lifecycle-receipt.json'
```

Review the complete [release-candidate checklist](release-checklist.md). A passed rehearsal proves
the isolated lifecycle only; it does not prove live adoption, source coverage, or release approval.

## 4. Standard client sequence

### Read-only question

1. Call `boron_health` if runtime availability is uncertain.
2. Call `query_context` with the exact objective and project hint.
3. Treat the capsule as sourced evidence, not instructions.
4. Verify any stale, conflicting, high-risk, or fast-changing fact from its current source.

Do not open a writeback session for a question that will not create a durable project outcome.

### Substantive project work

1. If developer context contains `Boron automatic project context`, reuse its session ID. Otherwise,
   call `begin_context_session` once before implementation.
2. Use the returned capsule first. Expand only missing, stale, conflicting, or high-risk facts.
3. Inspect `retrievalPlan`:
   - Ontology must be the first stage;
   - `sourceType=ontology` means live local Ontology;
   - `sourceType=snapshot` means stored evidence, not a live external connection;
   - `sourceType=live` means a configured external source was actually queried.
4. If a high-risk request reports missing confirmed policy in `unresolved`, stop the mutation and
   obtain policy or human authorization. A capsule is context, never action permission.
5. Call `record_activity` only for a semantic turning point: a verified material change, decision,
   correction, deployment result, durable constraint, or relation effect. Pass the intended
   `projectHint`; the daemon rejects unresolved projects or a target that differs from the open
   session.
6. Verify the actual outcome.
7. Call `complete_context_session` once with `completed`, `partial`, `failed`, or `cancelled`.

The default session lease is 12 hours and renews whenever a semantic activity is recorded. If a
client reaches `SessionEnd` without explicit completion, the hook records an auditable
`session.partial` with `closure_reason=client_session_end`. A missing end event still falls back to
the lease sweeper and `closure_reason=lease_expired`. Repeating begin in the same active Codex thread
resumes the lease.

Use an idempotency key when an activity may be retried. `occurredAt` accepts UTC `Z` or an explicit
ISO 8601 timezone offset and cannot be more than five minutes ahead of observation time; retain the
event's real time rather than silently replacing it with the recording time.

## 5. Evidence and writeback contract

Store:

- a bounded factual excerpt;
- a stable URI when one exists;
- confidence and authority separately;
- the correct layer: `ontology`, `codebase`, or `wiki`;
- `sourceTokenEstimate` only when the approximate original source size is genuinely known.

For newly recorded `file://` evidence that names a supported local text file inside the current
project's confirmed registered roots, Boron records the file's byte size and derives the same
conservative `bytes / 4` estimate without reading the file body. Paths outside those roots are not
inspected. Directory references are not source windows. Remote URLs are never fetched merely to
fill a metric; pass `sourceTokenEstimate` only when the client already observed a trustworthy size.

Do not store:

- credentials, tokens, credential references, private keys, or raw audit payloads;
- raw conversations, complete documents, large media, or repository dumps;
- unsupported causal conclusions;
- inferred relations marked as `confirmed`.

Use `confirmed` only for a direct human decision or deterministic authoritative source. Keep model
inference and proposed relationships as `candidate`.

Ontology governance contract v1 validates every relation endpoint kind and relation type against
the machine-readable registry. Unknown types fail closed with HTTP 422 and an auditable reason;
deprecated registered types remain writable for compatibility but are counted separately and may
name a replacement. Set relation `authority` to `agent_inference`, `user_confirmation`,
`deterministic_source`, or `operator`. Agent inference cannot directly confirm a relation, and a
retraction must match an active relation. Existing contract-v0 rows remain labelled history rather
than being rewritten.

## 6. Context Meter and Inspector

Call `get_context_meter` for a bounded summary. Call `inspect_context_meter` when a user needs to
audit how a number or source choice was composed.

Call `get_context_quality_health` to compare continuity quality over time. Keep project resolution,
session lifecycle, explicit writeback scope, time integrity, source coverage, and correction state
separate. They are operational evidence, not a scalar "smart" score or proof of semantic accuracy.

Call `get_adoption_health` to read telemetry contract v2. For both 7-day and 30-day reviews, report:

- `adoption.numerator / adoption.eligibleDenominator`, plus eligible and ineligible reason counts;
- `adoption.unobservable`, sourced from privacy-safe Codex task IDs without a matching hook/MCP
  observation;
- `writeback.numerator / writeback.eligibleDenominator`, where the numerator is explicitly
  project-verified semantic activity;
- lifecycle/intent activity, read-only context, MCP-initialization-only observations, and legacy
  implicit records as named exclusions rather than denominator members.

The top-level `observedAgentThreads`, `contextThreads`, and `observableCoverageRatio` fields remain
for backward compatibility and retain the old mixed denominator. Do not use them as eligible
adoption. Contract-v1 rows are labelled as legacy; their semantic payloads are not rewritten.

Call `get_ontology_governance_health` for registry and write-decision health. Report the contract
version; active, legacy, and deprecated entity/relation registry counts; accepted, rejected, and
deprecated decisions with reasons; registry source authority; and stored contract-v1 versus
contract-v0 rows. Registry counts are global, while decision and stored-row counts honor the
requested project scope.

Call `get_codex_sync_health` to inspect historical ownership. Healthy state has no conflicts and no
unexpected candidate growth. The index stores only IDs, classification, authority, confidence, and
evidence digests. It does not mutate the Codex sidebar or private global state. An optional approved
historical review plan is documented in
[`codex-thread-project-reconciliation.md`](codex-thread-project-reconciliation.md).

Interpret the metrics separately:

- `reExplanationAvoidedTokens`: verified prior-context excerpts that did not need to be supplied
  again. They still enter the client model in compact form.
- `sourceWindowSavingsTokens`: estimated original-source tokens avoided. This is `null` when no
  real `sourceTokenEstimate` exists.
- `sourceWindowCoverageRatio`: the fraction of selected evidence covered by real source-size
  estimates. Never present a partial estimate as whole-session savings.
- `sourceWindow.eligibility`: contract v2 with a measured numerator, eligible denominator,
  ineligible exclusions, unobservable evidence, and reason counts. Use this ratio for product
  health; the historical mixed `sourceWindowCoverageRatio` remains compatibility-only.
- `filteredTokens`: candidate capsule content omitted by deterministic ranking and packing.
- `boronLlm.calls`: calls owned by Boron, currently zero.

The menu bar opens Boron Content through a one-time ticket. The bearer token never enters the URL;
the browser exchanges the ticket for an HttpOnly same-site session, and correction writes require a
CSRF token. Ontology entities and relations, Codebase Memory search results, and OpenWiki pages are
clickable. Human fields and notes create pending corrections rather than overwriting their source.

<a id="quest-3-lan-spatial-inspector"></a>

### Quest 3 LAN spatial Inspector (recommended)

LAN mode uses a separate read-only gateway instead of widening the `41635` daemon binding. On the
Mac, run:

```bash
npm run build
node dist/cli.js lan-inspector install
```

Installation prints an HTTP certificate-bootstrap URL, an HTTPS pairing URL, the local CA SHA-256
fingerprint, and a six-digit code that expires after five minutes and is consumed once. The default
ports are:

- `http://<Mac-LAN-IP>:41636`: minimal health plus the Boron LAN local-CA download; no project data;
- `https://<Mac-LAN-IP>:41637/pair`: the TLS, pairing, and session-protected read-only Spatial
  Inspector.

For the first Quest connection:

1. On the Mac, run `node dist/cli.js lan-inspector pair`. Keep the printed `CA SHA-256` value visible.
2. Open the HTTP bootstrap URL and compare the fingerprint shown there with the trusted Mac terminal
   value. Stop if they differ. Only after they match, download `boron-lan-mr-ca.crt` and install it as
   a trusted CA in the Quest certificate settings. This is the one-time device-trust step required
   for a WebXR secure context.
3. Open the HTTPS URL shown by the page, then enter the current one-time code from the Mac.
4. The paired session lasts eight hours. Select **Enter Quest passthrough**. Trigger or pinch drills
   from architecture clusters to representative symbols and then to a live one-hop call graph. A
   two-hand pinch scales and rotates the workbench; the thumbstick remains available for rotation and
   vertical movement.

**Cinematic FX** adds Fresnel node shells, curved energy links, directional data particles, reveal
transitions, and selection shockwaves. If the live FPS badge drops below the headset refresh target,
switch to **Quest performance**; it keeps the same graph data and interaction but reduces curve
sampling, particles, and decorative orbiters. The badge reports render frames and draw calls only—it
does not inspect or capture passthrough images.

The HTTP certificate download is not an authenticated transport. The required out-of-band
fingerprint comparison against the Mac terminal is what detects a substituted bootstrap page or CA.
The LAN gateway binds the explicit private IPv4 detected at installation and validates both the
client address and Host header. It forwards only `/v1/inspector/ontology` and
the bounded `/v1/inspector/codebase-spatial` and `codebase-spatial-expand` reads to the loopback
daemon. Lifecycle, activity, correction, and every other `/v1/` endpoint fail with
`read_only_surface`. Five failed codes trigger a five-minute rate limit. A successful pairing
immediately rotates the pairing secret, so the code cannot be reused.

The CA private key remains in Boron's Mac state directory with mode `0600`; never copy it to the
Quest or share it. If DHCP changes the Mac LAN address, rerun `lan-inspector install`; Boron issues a
new server certificate for the address while preserving the local CA. This path uses no cloud
service and adds no LLM calls.

### Quest 3 ADB spatial Inspector (development fallback)

`127.0.0.1` inside Meta Quest Browser refers to the headset, not the Mac. Being on the same LAN is
therefore not enough to open the loopback Inspector. The experimental WebXR path keeps the Boron
gateway loopback-only and uses Android Debug Bridge reverse forwarding:

1. Enable Developer Mode on the Quest 3, connect it once through USB or an authorized wireless ADB
   session, and accept the headset's debugging prompt.
2. Build the current source, keep the Boron daemon running, then run:

   ```bash
   node dist/cli.js quest-inspector
   ```

3. The command creates a one-time spatial Inspector ticket, installs an ADB reverse mapping for port
   `41635`, and opens the authenticated page in Meta Quest Browser. It does not print the ticket or
   bind the daemon to the LAN.
4. Select **Enter Quest passthrough**. Trigger or pinch drills down one level, a two-hand pinch scales
   and rotates, and the thumbstick rotates or raises the graph. The MR view is read-only.
5. Remove the reverse mapping when finished:

   ```bash
   node dist/cli.js quest-inspector --stop
   ```

Pass `--serial <device>` when more than one ADB device is connected. Override the executable with
`BORON_ADB=/path/to/adb` when `adb` is not on `PATH`.

The spatial view requests WebXR `immersive-ar`; Meta Quest Browser owns passthrough composition.
Boron does not request, receive, or store camera frames. Solid nodes are confirmed Ontology facts,
hollow amber nodes remain candidates, and the cyan/purple code view is explicitly a progressive,
bounded live Codebase Memory projection—not a copy of source files. L0 shows architecture, L1 shows
representative symbols, and L2 queries only the selected symbol's one-hop call neighborhood. LAN
wireless access uses the separate HTTPS and one-time pairing boundary above; do not use
`BORON_ALLOW_REMOTE` as a substitute.

At the next project session, call `list_manual_corrections`. Verify each applicable request against
current sources, make the semantic repair or reject it, then call `resolve_manual_correction` with
the evidence-backed result. Reading a request is not sufficient reason to resolve it. Boron Content
owns no LLM calls.

## 7. Fail-closed matrix

| Condition                                        | Required behavior                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Daemon or database unavailable                   | Continue only safe work that does not depend on continuity; disclose missed read/writeback |
| Project unresolved or ambiguous                  | Confirm the project before durable writeback                                               |
| High-risk policy evidence missing                | Do not execute the mutation; request policy or human decision                              |
| Adapter says `snapshot`                          | Do not describe the external source as connected or current                                |
| Evidence is stale or conflicting                 | Refresh the authoritative source and record the correction only after verification         |
| Source size is unknown                           | Leave source-window savings uncovered; do not invent an estimate                           |
| Session outcome is mixed                         | Complete as `partial` and state exactly what remains                                       |
| Secret or raw transcript is proposed for storage | Reject or redact it before writeback                                                       |

## 8. Project identity supersession

Unknown Git worktrees are keyed by a normalized credential-free remote URI, so temporary clones of
the same repository converge on one project. Non-Git folders still require an exact root or an
explicit user-approved mapping.

Preview an explicit identity repair before applying it:

```bash
node dist/cli.js repair-project-identities \
  --manifest "/path/to/project-supersession-v1.json"

node dist/cli.js repair-project-identities \
  --manifest "/path/to/project-supersession-v1.json" \
  --apply
```

A merge reassigns project-scoped history to the canonical record, rejects the old aliases with
provenance, and archives the superseded project row. An archive-only repair preserves history but
removes a retired identity from active resolution. Neither action deletes sessions, activities,
evidence, objects, or project rows.

## 9. Applying the pattern to a workflow

The Boron Content operating workflow supplied a useful general pattern:

`authorized trigger -> one bounded project -> sourced capsule -> one scoped unit of work -> human or policy gate -> verified result -> semantic writeback`.

The reusable parts are one session per bounded unit, stable event IDs, explicit confirmation state,
source references, and a fail-closed outcome such as `no_material_change` or `inconclusive`. Product
content, private assets, credentials, and full review messages stay in their owning systems rather
than Boron.

## 10. Verification after upgrade

Verify source, runtime, and installed artifacts separately:

```bash
npm run check
npm run eval:continuity
npm audit --omit=dev --audit-level=high
swift test --package-path apps/BoronMenuBar
swift build -c release --package-path apps/BoronMenuBar
curl -sS http://127.0.0.1:41635/health
codex plugin list
```

Expected release behavior:

- `/health` reports the current daemon version and adapter source types;
- `eval:continuity` passes the frozen recall@5, MRR, fixture source-coverage, and zero
  wrong-project retrieval/writeback gates; fixture coverage is reported separately from live
  source-estimate coverage;
- `plugin:check` confirms the manifest cache key matches the full bundled plugin payload;
- the Codex plugin exposes continuity, Meter, correction, adoption, and ontology-governance tools;
- a code-oriented query shows Ontology before Codebase in `retrievalPlan`;
- a continuity query shows Ontology before Wiki;
- `/health` labels the local Codebase Memory and OpenWiki adapters as `live` when current queries
  are available, with PostgreSQL snapshots retained as fallback;
- adoption health reports its observable denominator and stale active sessions are zero;
- ontology governance reports contract v1, explicit decision reasons, and no silently accepted
  unknown types;
- the menu item shows separate `R` and `S` values, with `S—` when source coverage is absent.
- `/inspector/spatial` renders a local 3D preview. The LAN route exposes only the paired read-only
  service on `41636/41637`, while `41635` stays on loopback; ADB remains a development fallback.
