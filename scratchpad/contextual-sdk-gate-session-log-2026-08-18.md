# Contextual SDK gate session log

## 2026-08-18

- Mapped the current smart gate, workspace graph, release entry points, CI contract, and timing evidence. Confirmed that app-only and platform-SDK-only changes are already contextual, while shared SDK changes fan out to both platform consumer lanes.
- Chose a shipment-target layer as the draft direction. The target intersects affected consumers with a manifest-derived web or mobile universe, but it cannot suppress directly changed incompatible code or fail-closed repository changes.
- Drafted `scratchpad/contextual-sdk-gate-spec-2026-08-18.md` with behavior, safety invariants, acceptance checks, execution seams, and explicit out-of-scope work. No gate implementation or production state changed.
- Critique found that a simple target-universe intersection would also drop non-platform dependents. Replaced it with opposite-platform-only subtraction, so shared and non-platform checks remain selected.
- Added snapshot-consistent manifest discovery, explicit-path canonicalization, stable plan output, release-mode mapping, and exact planning-error behavior after reviewers proved gaps in the first draft against the current gate.
