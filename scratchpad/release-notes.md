## Features

- **More control inside meetings** — desktop meetings now include inline device switching, a searchable settings dialog, keyboard shortcuts for settings, browser haptics on supported devices, Document Picture-in-Picture, and local profile gradient controls.
- **Richer visual setup** — meetings now support local background effects with blur, presets, and custom uploads so participants can personalize their camera feed more easily.
- **Dashboard avatar styling** — the web dashboard now lets users keep an automatic name-based avatar gradient or choose from preset blends with live preview updates.

## Improvements

- **Smoother joining and PiP layouts** — join loading states feel more reassuring, Picture-in-Picture uses more of the window, and compact room layouts adapt better to screen share, whiteboard, and multi-participant views.
- **Leaned-down workspace** — the repo now focuses on active web, API, and package surfaces after removing legacy native, admin, demo, and stress-testing surfaces.

## Bug Fixes

- **Room access stays on target** — scheduled dashboard joins and localhost room entry are more reliable about landing users in the correct workspace and room.
- **Settings and media flows are steadier** — saved room preferences, device discovery, speaker tests, and desktop dock controls now behave more consistently during active meetings.
- **Picture-in-Picture is more stable** — shared PiP no longer loops into render-depth crashes, compact layouts avoid duplicate-key warnings, and local identity visuals stay in sync.
- **Backgrounds and screen share behave better** — background support state now syncs correctly, preset image loading is more reliable on localhost, screen-share cancel no longer gets stuck, and supported browsers restore system-audio capture by default.
- **Annotation and local-dev regressions are resolved** — local sharers see annotation controls sooner, startup/sync races are handled more cleanly, and localhost auth/router issues no longer break common dashboard and room flows.

## Technical Notes

- Cut release `v0.0.73` on `2026-03-12`.
- Updated package versions for `@q9labs/chalk-core`, `@q9labs/chalk-react`, `@q9labs/chalk-ui`, and `@q9labs/chalk-whiteboard`.
- Refreshed the changelog and release metadata for the latest publish cycle.
