<!-- image:  -->

<!-- whats-new -->
## Features

- **Lean infrastructure + deploy pipeline** — production now runs on a lower-cost lean stack with automated API/web deployment workflows.
- **Client incident reporting** — apps can now send support incidents directly so failures are easier to trace and resolve.

## Improvements

- **Faster, more resilient joins** — join flow now includes better retry behavior, richer diagnostics, and improved recovery from transient failures.
- **Session replay support** — optional PostHog replay lifecycle events now wire through SDK flows for easier debugging.

## Bug Fixes

- Room join race conditions and stale participant sync paths now recover more reliably.
- WebSocket and whiteboard v2 contracts are now stricter and consistent across SDK/API.
- Mobile pre-join device selection and in-meeting audio routing edge cases are fixed.
<!-- /whats-new -->

## Technical Notes

- SDK packages bumped to `0.0.69`: `@q9labs/chalk-core`, `@q9labs/chalk-react`, `@q9labs/chalk-react-native`, `@q9labs/chalk-ui`, `@q9labs/chalk-whiteboard`.
- Changelog rolled: `Unreleased` promoted into `0.0.69` on `2026-03-07`.
- This release includes breaking contract/name changes already documented in `CHANGELOG.md`; consumers should review before upgrade.
