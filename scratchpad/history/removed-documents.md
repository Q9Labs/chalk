# Removed scratchpad documents

Round 2 of the scratchpad sweep removed the long-form planning documents,
their duplicate HTML renderings, and the binary artifacts nobody consumed.
The weekly digests in this directory carry the durable conclusions; the
documents themselves stay in git history.

Recover one file:

```sh
git log --diff-filter=D --name-only -- 'scratchpad/<name>'
git show <commit>^:scratchpad/<name> > /tmp/<name>
```

Recover the whole set at once:

```sh
git checkout <commit>^ -- scratchpad/
```

`<commit>` is the squash commit for the round-2 sweep. Each entry below gives
the document's first heading, so you can find one by subject rather than by
filename.

## Planning documents and specs

- `api-performance-pool-sweep-20260630.md` — API Performance Pool Sweep - 2026-06-30
- `api-performance-report-20260724T071141Z.md` — Chalk API Local Performance Report
- `api-route-service-trace-map-2026-07-06.md` — API Route, Service, Adapter, And Harness Map - 2026-07-06
- `architecture-and-sdk-decisions.md` — Architecture And SDK Decisions
- `chalk-account-boundary-naming-2026-05-16.md` — Chalk Account Boundary Naming
- `chalk-actor-flows-2026-05-14.md` — Chalk Actor Flows
- `chalk-api-staging-readiness-spec-2026-07-13.md` — Chalk API Staging Readiness Spec
- `chalk-architecture-decision-2026-06-16.md` — Chalk Architecture Decision Note
- `chalk-convex-architecture-lessons-2026-05-13.md` — Chalk Convex Architecture Lessons
- `chalk-dashboard-spec-2026-08-04.md` — Chalk dashboard
- `chalk-docs-site-spec-2026-08-19.md` — Chalk docs site
- `chalk-domain-model-2026-05-14.md` — Chalk Domain Model
- `chalk-infra-cost-model-2026-07-12.md` — Chalk Infrastructure Cost Model
- `chalk-infra-execution-strategy-2026-07-12.md` — Chalk Infrastructure Execution Strategy
- `chalk-infrastructure-readiness-spec-2026-07-11.md` — Chalk Infrastructure Readiness Spec
- `chalk-join-path-observability-concept.md` — Chalk join-path observability
- `chalk-media-cost-model-2026-06-15.md` — Chalk Media and Recording Cost Model
- `chalk-native-whiteboard-options-spec-2026-07-29.md` — Chalk Native Whiteboard Options
- `chalk-observability-uptime-spec-2026-07-12.md` — Chalk Observability, Uptime, and Status Spec
- `chalk-outbound-webhooks-spec-2026-07-12.md` — Chalk Outbound Webhooks Spec
- `chalk-pre-staging-readiness-spec-2026-07-13.md` — Chalk Pre-Staging Readiness Spec
- `chalk-recorder-cloudflare-capture-worker-spec-2026-07-13.md` — Chalk Cloudflare Capture Worker Spec
- `chalk-recorder-control-plane-spec-2026-07-13.md` — Chalk Recorder Control Plane Spec
- `chalk-recorder-pipeline-spec-2026-07-12.md` — Chalk Recorder and Artifact Pipeline Spec
- `chalk-recorder-render-finalization-worker-spec-2026-07-13.md` — Chalk Recorder Render and Finalization Worker Spec
- `chalk-recorder-staging-qualification-spec-2026-07-13.md` — Chalk Recorder Staging Qualification Spec
- `chalk-recorder-system-guided-spec-2026-07-14.md` — Chalk Meeting Recording Sidelining
- `chalk-room-actions-spec-2026-07-29.md` — Chalk Room Actions Implementation Specification
- `chalk-session-lifecycle-2026-05-15.md` — Chalk Session Lifecycle
- `chalk-top-level-actors-2026-05-14.md` — Chalk Top-Level Actors
- `chalk-transcription-execution-ledger-2026-07-13.md` — Chalk transcription execution ledger
- `chalk-transcription-spec-2026-07-12.md` — Chalk Track-aware Transcription Spec
- `client-sdk-split-design-2026-08-03.md` — Client SDK split design — client wave — 2026-08-03
- `cloudflare-sfu-vs-mediasoup-capabilities.md` — Cloudflare SFU vs mediasoup Capabilities
- `codex-client-presence-lane-2026-08-18.md` — Client Participant presence lane
- `codex-stage-layout-code-map-2026-08-18.md` — Chalk Space-stage layout and rendering map
- `codex-stage-layout-issues-and-intent-2026-08-18.md` — Participant-tile stage: evidence, intent, and open questions
- `composio-integration-db-implementation-log-2026-07-06.md` — Composio Integration DB Implementation Log
- `composio-integration-db-spec-2026-07-06.md` — Composio Integration DB Spec
- `contextual-sdk-gate-spec-2026-08-18.md` — Contextual SDK gate
- `debrief-chalk-transcription-2026-07-13.md` — Chalk track-aware transcription debrief
- `debrief-outbound-webhooks-2026-07-13.md` — Outbound webhooks debrief
- `debrief-recorder-pipeline-2026-07-13.md` — Recorder pipeline debrief
- `debrief-sync-breaker-2026-07-11.md` — Sync Breaker Debrief
- `debrief-sync-orientation-2026-07-08.md` — Getting oriented in `apps/sync` — 2026-07-08
- `debrief-tenant-endpoint-wrapper-2026-07-07.md` — Tenant Endpoint Wrapper Debrief - 2026-07-07
- `debugging-lessons.md` — Debugging And RCA Lessons
- `declarative-sync-engine-v3-spec-2026-07-12.md` — Declarative core-conference sync v3
- `deployment-notes.md` — Deployment Notes
- `docmost-positioning-notes-2026-07-27.md` — Docmost positioning notes
- `README.md` — ElevenLabs sound set — 2026-07-05
- `execution-strategy-map-2026-08-03.md` — Execution strategy map — 2026-08-03
- `full-local-dev-experience-spec-2026-08-03.md` — Chalk Full Local Dev Experience
- `live-episode-debugger-spec-2026-08-03.md` — Live Episode Debugger
- `managed-deployment-dogfood-2026-08-18.md` — Managed deployment dogfood — 2026-08-18
- `meeting-lifecycle-control-plane-deep-dive-2026-05-30.md` — Meeting Lifecycle / Room Control Plane Deep Dive
- `mobile-app-store-product-brief.md` — Chalk mobile app: factual store-research brief
- `native-whiteboard-strategy-2026-07-29.md` — Native Whiteboard Strategy
- `observability-plan-2026-07-11.md` — Chalk full-stack observability plan
- `overnight-rulings-2026-08-03.md` — Overnight rulings — 2026-08-03
- `permissions-trust-moderation-deep-dive-2026-05-30.md` — Permissions, Trust, and Moderation Deep Dive
- `product-and-integration-lessons.md` — Product And Integration Lessons
- `public-surface-design-2026-08-03.md` — Public surface design — the developer-facing API — 2026-08-03
- `realtime-api-architecture-inspiration-2026-05-13.md` — Realtime API Architecture Inspiration
- `realtime-conference-hard-problems-brief-2026-05-30.md` — Realtime Conference Hard Problems Brief
- `realtime-room-rebuild-lessons-2026-05-31.md` — Realtime Room Rebuild Lessons
- `sdk-consumer-launch-audit-2026-07-20.md` — SDK consumer launch audit — 2026-07-20
- `sdk-preview-parity-spec-2026-08-20.md` — SDK Preview Parity
- `sdk-state-machines-deep-dive-2026-05-30.md` — SDK State Machines Deep Dive
- `sdk-web-launch-implementation-board-2026-07-20.md` — Chalk web SDK launch implementation board
- `sdk-web-launch-p0-spec-2026-07-21.md` — Managed web SDK launch P0 specification
- `space-episode-schema-design-2026-08-03.md` — Space/Episode schema design — contract wave — 2026-08-03
- `sync-breaker-findings-2026-07-11.md` — Chalk Sync Breaker Findings
- `sync-breaker-harness-plan-2026-07-11.md` — Chalk Sync Breaker
- `sync-engine-architecture-brief-2026-05-30.md` — Chalk Sync Engine Architecture Brief
- `sync-engine-deep-dive-2026-05-30.md` — Chalk Sync Engine Deep Dive
- `sync-production-readiness-report-2026-07-12.md` — Chalk Sync Production Readiness Report
- `sync-production-readiness-spec-2026-07-11.md` — Chalk Sync Engine Production Overhaul Specification
- `sync-remaining-readiness-spec-2026-07-12.md` — Chalk Sync Remaining Production Readiness Specification
- `sync-renumber-final-report-2026-08-03.md` — Sync v1 renumber final report
- `version-archaeology-codex-2026-08-03.md` — Chalk version archaeology report
- `wave-1-contract-prompt-2026-08-03.md` — Wave 1 prompt — contract, database, and server adoption
- `wave-2-client-sdk-prompt-2026-08-03.md` — Wave 2 prompt — client SDK split
- `wave-3-react-prompt-2026-08-03.md` — Wave 3 prompt — React and React Native
- `wave-4-apps-prompt-2026-08-03.md` — Wave 4 prompt — apps
- `wave-5-infra-prompt-2026-08-03.md` — Wave 5 prompt — infrastructure and broker
- `wave-6-observability-prompt-2026-08-03.md` — Wave 6 prompt — observability
- `wave-7-docs-marketing-prompt-2026-08-05.md` — Wave 7 prompt — docs and marketing
- `wave-8-reconciliation-prompt-2026-08-04.md` — Wave 8 prompt — master, dashboard, and live Episode debugger reconciliation
- `wave-execution-brief-2026-08-03.md` — Wave execution brief — 2026-08-03
- `webrtc-media-reconnect-deep-dive-2026-05-30.md` — WebRTC Media and Reconnect Deep Dive

## Duplicate HTML renderings

Each of these rendered a Markdown document of the same name that is also
removed above. The HTML carried no content the Markdown lacked.

- `api-performance-report-20260724T071141Z.html`
- `chalk-dashboard-spec-2026-08-04.html`
- `chalk-native-whiteboard-options-spec-2026-07-29.html`
- `chalk-recorder-system-guided-spec-2026-07-14.html`
- `chalk-room-actions-spec-2026-07-29.html`
- `full-local-dev-experience-spec-2026-08-03.html`
- `live-episode-debugger-spec-2026-08-03.html`
- `sdk-web-launch-implementation-board-2026-07-20.html`
- `sdk-web-launch-p0-spec-2026-07-21.html`

## Binary artifacts

- `elevenlabs-sounds-2026-07-05/` — 240 candidate sound takes across four
  voices, plus the manifest recording each take's ElevenLabs `historyId`.
  Nothing in the product consumed them: `docs/redesign/sound-design.md` is the
  durable sound specification.
- `assets/recorder-pipeline-debrief/`, `assets/transcription-debrief/`,
  `assets/chalk-recorder-system/` — diagrams whose only referrers were the
  debriefs removed above.
- `chalk-observability-uptime-architecture.png` — no referrers.

## Standalone HTML documents

Guides, debriefs, and boards written directly as HTML, with no Markdown
source. Their conclusions are in the weekly digests.

- `chalk-logo-motion-study.html` — Chalk logo motion study
- `debrief-chalk-room-actions-2026-07-29.html` — Chalk room actions — implementation debrief
- `debrief-chalk-room-receipts-attachments-2026-07-30.html` — Chalk room chat — implementation debrief
- `july-12-14-control-room-2026-07-14.html` — July 12 14 Control Room
- `recorder-contract-flow-guide-2026-07-14.html` — Recorder Contract Flow
- `recorder-shared-contracts-guide-2026-07-14.html` — Recorder Shared Contracts
- `room-join-lifecycle-atlas-2026-08-01.html` — Chalk — the meeting, traced
- `sync-codewalk.html` — apps/sync — code walk
- `sync-orientation.html` — apps/sync — orientation

## Follow-up sweep

The follow-up sweep removed three unreferenced entrance-animation prototypes,
the root favicon duplicated by the web public favicon, unused legacy and
third-party brand exports, and the superseded marketing image set. Current
landing images, technology marks, platform icons, product logos, and design
reference galleries remain because code or durable documentation consumes them.

- `entrance-animations/index.html`, `entrance-animations/blinds.html`, and
  `entrance-animations/curtains.html` — unreferenced animation prototypes
- `favicon.ico` — duplicate of `apps/web/public/favicon.ico`
- `apps/web/public/brand/legacy/logo192.png` and `logo512.png` — unused legacy
  web-app icons
- `apps/web/public/brand/q9labs/` — unused third-party brand exports
- `apps/web/public/brand/tanstack/` — unused third-party brand exports
- `apps/web/public/images/marketing/hero-1*`, `hero-2.png`,
  `devices-with-video.png`, `chalk-speaker-view-20260801.webp`, and
  `chalk-stroke-blue-20260807.webp` — superseded marketing drafts with no
  current code or documentation consumers
