<!-- image:  -->

<!-- whats-new -->
## Features

- **Scheduled Classes + Join Links** — Hosts can now create and manage scheduled classes and generate join links directly through Chalk flows.
- **SDK Room Listing + Join Tokens** — Apps can now list rooms and create/exchange join tokens with first-class SDK methods.

## Improvements

- **Participant Color Experience** — Meeting controls, chat, transcription, and participant UI now consistently follow participant-aware color themes.
- **Join-Link Preflight UX** — Early joiners now see a clear waiting state with countdown before auto-entering at meeting time.

## Bug Fixes

- Whiteboard image sync now shows clear progress states so the short sync window feels reliable, not failed.
- Chat alignment is now consistent: your messages stay on the right, incoming stays on the left.
- Reactions and hand raises now sync and sound exactly once across reconnects and peers.
- SDK sound effects now start immediately with less leading delay.
- Browser preflight for R2 uploads/downloads is fixed with proper CORS rules.
- Localhost internal auth callback flows now route back to local app callbacks correctly.
<!-- /whats-new -->

## Technical Notes

- Added SDK client/session APIs: `listRooms`, `createJoinToken`, `exchangeJoinToken`.
- Added multi-status room filtering + participant counts on `GET /api/v1/rooms`.
- Removed deprecated Terraform `prod` environment and standardized on `prod-lean` operations.
- Added whiteboard sync status states (`uploading`, `awaiting remote upload`, `downloading`, `error`) with SDK-React/whiteboard UI wiring.
- Hardened SDK reaction/hand-raise replay and participant-state enrichment during reconnect paths.
