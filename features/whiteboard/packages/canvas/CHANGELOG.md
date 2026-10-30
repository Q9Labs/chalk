# Changelog

## 5.2.0

### follow-view-owner

Converge Follow views on one Episode owner, recover from its canonical snapshot,
and preserve real camera moves during recovery and tab switches. Zoom controls
and keyboard moves now consistently leave Follow and lead the person's view.

Keep all 500 active people's views using internal schema-generated limits in the client and React caches. The client's public bounds, event unions and decoded-frame unions are unchanged. The client now exports `ChalkWhiteboardViewVersions`, which the React SDK uses to order view moves, and whiteboard view events now carry `ownerId`, `ownerSequence` and `originEpoch`, so both releases are minor.

## 5.1.0

- Add headless mode for hosts that draw their own board controls: `WhiteboardCanvas` accepts `headless`, `inkColor` and `onEngineReady`, and the React entry exports `WhiteboardEngineHandle` (clear, clear with undo, place math), `CANONICAL_INK`, and `observeEngineHistory` with `EngineHistoryState`.
- Add shared board view events, so collaborators can follow a person's view or bring everyone to theirs.
- Keep Clear and Undo bound to the scene they were taken from. Redo brings back undone text, and small drawings open at 100% zoom at most.

See the [project changelog](../../CHANGELOG.md) for the coordinated v5.1 release.

## 5.0.0

- Export `preloadWhiteboardStylesheet` from the React entry point.
- Keep element order stable across board loads and reconnects.
- Keep the rest of a board syncing when an element exceeds the wire size limit.
- BREAKING: remove the retired local image-upload queue and import path. Remote file downloads remain available.

See the [project changelog](../../CHANGELOG.md) for the coordinated v5 release.
