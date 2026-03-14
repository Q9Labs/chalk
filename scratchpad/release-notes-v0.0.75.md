<!-- image:  -->

<!-- whats-new -->

## Features

- **Install Chalk like an app** — Chalk on the web now supports install prompts, home screen shortcuts, and update guidance so joining from desktop and mobile feels more app-like.
- **Native meeting kit for mobile apps** — Teams integrating Chalk on mobile now get a package-first native meeting flow with ready-made lobby, room, panel, and end-screen building blocks.

## Improvements

- **More consistent meeting setup on phones** — mobile pre-join behavior is steadier, especially around camera and microphone setup during first entry.
- **Sharper design-system guidance** — the product now includes clearer design-system docs and reference assets to keep future UI work aligned.

## Bug Fixes

- Chalk better recovers when saved mobile camera selections are stale, reducing camera-toggle flicker before joining.
- Web install/update behavior is safer around caching and browser theme handling.
<!-- /whats-new -->

## Technical Notes

- Added PWA manifest, service worker shell, install/update hooks, and cache-safety handling in `apps/web` and `packages/sdk-react`.
- Added `@q9labs/chalk-react-native`, React Native runtime shims in `sdk-core`, and package-first native meeting surfaces used by `apps/mobile`.
- Refreshed internal auth, dashboard shell, docs theming, and web build env handling.
- Hardened whisper worker recovery, lock heartbeats, packaging, and singleton spot replacement behavior.
