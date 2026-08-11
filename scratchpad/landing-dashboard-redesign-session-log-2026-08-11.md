# Landing and dashboard redesign session log

## 2026-08-11 — Audit and interaction model

- The production landing page had no primary product CTA because SDK preview links were development-only. The redesign exposes Account creation, dashboard sign-in, and invite-link joining as permanent paths.
- Dashboard Space cards and rows only linked from small nested controls. The new model separates `View details` from `Join Space`; details manage the durable Space, while join enters the participant-facing Space.
- Episode history used a list-plus-drawer with raw configuration JSON. The redesign uses a readable table, structured frozen configuration, and collapsed advanced data.
- Unfinished Artifacts, People, and Activity previews were removed from the main navigation. Their routes remain available, but the primary shell now points to working surfaces.
- The Episode Debugger keeps its diagnostic behavior and security boundary, but its hierarchy and entry labels are being rebuilt around an operations-dashboard pattern.
- Existing user edits to the landing chalk-stroke treatment and asset are preserved.

## 2026-08-11 — Browser integration pass

- The Account fixture confirms the Overview, Spaces, Episodes, Space details, and native New Space dialog work as one flow on desktop and mobile.
- Browser testing caught the first Space detail route nested under the Spaces index. The route is now a pathless sibling, so `/spaces/:spaceId` renders the detail page instead of the inventory.
- The mobile navigation is visually hidden and removed from the accessibility tree until opened. The Space detail loading and error surfaces also avoid nested `main` landmarks.
- Episode configuration now presents provider names and durations as plain language while preserving the raw immutable snapshot behind a disclosure.
