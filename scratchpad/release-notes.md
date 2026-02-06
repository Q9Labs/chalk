<!-- image:  -->

<!-- whats-new -->
## Features

- **New whiteboard sync engine** — Whiteboards now stay in sync more reliably during fast drawing and multi-person edits.
- **Whiteboard image uploads** — Upload and share images on the whiteboard via secure, direct-to-storage transfers.

## Improvements

- **More stable whiteboard sessions** — Better handling for backpressure and recovery keeps sessions responsive when activity spikes.
- **Cleaner production logging** — Production services run with less noisy logs, making issues easier to spot.

## Bug Fixes

- Fixed an issue where multilingual speech could be missed later in a recording.
- Fixed occasional worker crashes during temporary file cleanup.
- Reduced transcription worker timeouts when Redis is slow or transiently unavailable.
- Prevented analytics logging from spamming errors when the dataset is misconfigured.
<!-- /whats-new -->

## Technical Notes

- Whiteboard v2 sync: Excalidraw-native reconcile/restore, snapshot healing, cursor presence forwarding.
- sdk-core: schema-first WS client refactor; runtime payload validation; event rename `room-sync` -> `room.sync`.
- API: whiteboard websocket hub backpressure; R2 presign endpoints; Axiom ingest guardrails.
- CI: move workflows back to GitHub-hosted runners + Buildx when Depot is unavailable.
