# Recorder seam specs session log

## 2026-07-13 18:05 PKT

- Started four dedicated recorder specifications: control plane, Cloudflare RealtimeKit native capture worker, GPU render/finalization worker, and staging qualification.
- Confirmed the intended boundary: Cloudflare RealtimeKit remains the SFU; a native WebRTC library such as Pion would only implement the capture worker's client-side media transport if Cloudflare exposes a compatible, supported signaling contract.
- Began official RealtimeKit capability research and repository contract inventories. Unresolved questions will be collected at the end of the completed spec set rather than interrupting the initial drafts.

## 2026-07-13 18:13 PKT

- Wrote the four dedicated seam specs and linked them from the ratified recorder umbrella.
- Used official Cloudflare documentation to settle direct Cloudflare Realtime SFU as the native capture transport; Pion is the worker WebRTC client, RealtimeKit remains transitional, and workers never receive the SFU application secret.
- Folded a cross-spec critique into the drafts: server-owned object intents, reconciler-owned pool health, transactional artifact/transcription finalization with one job per chunk, evidence-driven capture density, pinned GPU contract gates, exact monitoring envelopes, staging-only mutation language, and explicit fixed-versus-usage cost guards.
- Verified formatting, whitespace, local references, and that every spec ends with its unresolved questions.
