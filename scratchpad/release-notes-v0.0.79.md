<!-- whats-new -->

## Features

- **Invite-link joins for SDK apps** — apps using Chalk can now join meetings directly from signed invite links or join tokens instead of forcing guests through custom room-code plumbing.

## Improvements

- **Safer room identity across products** — Chalk now preserves canonical room UUIDs through more of the join flow, reducing room-scope mismatches between app surfaces.
- **Faster mobile meeting entry** — the mobile app can spot a copied Chalk invite link on the clipboard and offer a one-tap join shortcut.

## Bug Fixes

- Dashboard-created first-party meetings no longer split guests into different backend rooms when they arrive through different auth contexts.
- Mobile-hosted meetings now create a real backend room before entering the lobby, avoiding dead client-only meeting ids.
<!-- /whats-new -->

## Technical Notes

- Added `createJoinTokenProvider`, `ConferenceClient.joinWithJoinToken`, and `ConferenceClient.joinWithInviteLink` in `@q9labs/chalk-core`.
- Added `joinToken` / `inviteLink` support to `VideoConference`, `ChalkProvider`, and `useConnection` in `@q9labs/chalk-react`.
- Updated docs/examples away from friendly string room ids toward canonical room UUIDs and invite-link joins.
