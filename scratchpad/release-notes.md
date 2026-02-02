<!-- image:  -->

<!-- whats-new -->
## Features

- **Participant volume controls** — Dragging the slider now changes volume immediately, and the mute icon sets volume to zero.

## Improvements

- **Recording reliability** — Recordings now wait until they are ready before download and stop automatically when rooms end.
- **Webhook processing stability** — Recording uploads continue even if a request times out, so deliveries complete more consistently.
- **Screen share on iPadOS/Safari** — Sharing is more reliable on Apple tablets and Safari-based browsers.

## Bug Fixes

- Silent or near‑silent recordings no longer fail transcription.
- Webhooks now accept camelCase fields, preventing missing download links.
- Whiteboard no longer breaks in production due to duplicate React instances.
<!-- /whats-new -->

## Technical Notes

- CI/CD migrated to Depot runners with cached builds and full‑SHA image tags.
- Added startup warnings and stricter R2 credential requirements in production.
- Added WebSocket backpressure metrics and CloudWatch alarms for drops/errors.
- Externalized Excalidraw from sdk-react builds to reduce bundle size.
