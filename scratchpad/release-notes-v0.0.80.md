<!-- whats-new -->

## Features

- **Debug reports for support** — full client-side reports now bundle the browser, SDK, and network context needed to diagnose room and join issues quickly.
- **Mobile diagnostics for dev builds** — local mobile builds now expose a richer debug sheet with join state, token claims, device info, and recovery actions.

## Improvements

- **Canonical Chalk links** — shared links now standardize on `chalkmeet.com` while preserving the legacy domain.
- **Cleaner meeting controls** — meeting actions and stage handling are clearer and more consistent in the native room UI.

## Bug Fixes

- Debug exports now capture the exact room lookup and join path so `room not found` issues are easier to explain and troubleshoot.
- Clipboard and diagnostics flows now avoid the stale or misleading behaviors that made support copies unreliable.
- Screen-share and room-scoped auth behavior now line up more closely with the active session and room state.
<!-- /whats-new -->

## Technical Notes

- Added a diagnosis-first structured debug report builder shared by SDK React and web exports.
- Reworked mobile and RN runtime compatibility patches, plus related diagnostics plumbing and package version bumps.
