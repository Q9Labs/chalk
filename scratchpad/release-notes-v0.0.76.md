## v0.0.76 - Nexus Serena

<!-- whats-new -->

## Improvements

- **Chalk stays visually consistent inside partner apps** — settings, dropdowns, dialogs, and tooltips now keep Chalk styling more reliably instead of inheriting a consumer app's global styles.
- **Background images apply more reliably** — custom virtual background images now load more consistently when classrooms or portals provide them from external URLs.
- **Avatars and theme polish got stronger test coverage** — the web SDK now has deeper automated checks around avatar gradients and related UI state so regressions are less likely to slip through.

## Bug Fixes

- Mobile prejoin and Expo startup paths were hardened so the native experience is more stable during launch and setup.

<!-- /whats-new -->

## Technical Notes

- Portaled UI surfaces now carry explicit Chalk theme scope.
- Background image URLs are normalized through object URLs before the virtual background transformer consumes them.
- Added local mutation testing coverage around avatar gradient logic in `apps/web`.
