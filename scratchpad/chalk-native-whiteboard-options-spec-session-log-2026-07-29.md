# Chalk Native Whiteboard Options Spec Session Log

## 2026-07-29

- Started a draft specification for the three whiteboard strategies in Hasan's preferred review order: embed Excalidraw, build a Chalk engine, then port Excalidraw to Swift and Kotlin.
- Reused the confirmed product constraints from the native whiteboard research: web/mobile Excalidraw round trips remain lossless, an embedded renderer is acceptable if it feels native, and the work will be agent-driven.
- Read the spec-craft and Reading Room instructions, the prior research memo, the current whiteboard package boundary, the React Native whiteboard hook, and the in-progress `whiteboard-v1` room-action contract.
- Chose one strategy spec with three complete option contracts. The options share a renderer boundary and proof bar, but each has its own activation rule, architecture, acceptance gates, and stop condition.
- Recorded the key structural finding: the order is valid for review, but it cannot be a blind implementation sequence. After an embedded-renderer failure, the next path depends on whether Chalk still requires lossless Excalidraw compatibility.
- Wrote and registered the first Markdown and Reading Room draft.
- Ran two independent critique passes. The product pass found an unresolved legacy-mobile policy, coarse authority, unbounded fallback rules, missing user states, unclear launch consumers, and incomplete decision cards. The system pass found that the legacy React Native hook is inert, the proposed renderer duplicated transport truth, current `whiteboard-v1` limits cannot carry a 1,000-element full sync, the room-actions gate was missing from the dependency graph, and the bundle, files, traces, and core choice needed tighter contracts.
- Reworked the draft around `ChalkSessionStore.whiteboard` and a `ChalkWhiteboardController` that alone owns scene, revision, capabilities, recovery, files, and trace context. The renderer now consumes snapshots and updates under an opaque generation and emits local element outcomes.
- Added an atomic multipart transport prerequisite for updates above 128 elements, an exact Excalidraw compatibility manifest, a fully local embedded artifact, a native file-byte port, neutral native stroke capture, bounded failure remediation, content accessibility, exact capability-loss and close rules, and measured live-call thresholds.
- Made Option 2's legacy limitation explicit: it cannot edit existing Excalidraw documents after the embedded editor fails. The default fallback is a gated read-only viewer, owner-authorized **Create Chalk copy**, or web-only access.
- Added first collaboration rules for `chalk/1`, removed new offline authoring from the first release, added Option 3 text shaping and release-skew policy, expanded the decision set from four to six, and split the execution graph around the real room-actions dependency.
- Added product-parity mobile previews for editable and recovering board states using the existing Chalk React Native theme.
- Rebuilt and republished the draft companion after the critique. The first formatted rebuild exposed a Reading Room parser limitation with split custom closing tags; reported it through `complain` as issue 2936, restored component-safe formatting, and verified the hosted republish.
- Ran the canonical staged documentation gate on an isolated `agents-macmini` copy. Gate routing tests, repository hygiene, staged secret scanning, and formatting passed. Moved the temporary remote copy to Trash after verification.
