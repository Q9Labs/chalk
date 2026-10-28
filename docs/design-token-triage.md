# React design-token triage

Audit of all 82 findings in 13 files recorded by PR #595 at `a7f46229c`. Line numbers below refer to that revision.

| Classification | Findings | Action |
| --- | ---: | --- |
| Real styling issues | 69 | Reuse existing semantic or media-overlay tokens. |
| Justified exceptions | 8 | Keep fixed QR contrast and labeled file-extension colors, with exact single-use snippets. |
| False positives | 5 | Retain valid Tailwind 4 token-opacity classes. |

The six existing confetti colors were outside the old baseline. Their broad declaration exemption is now an exact single-use snippet with a reason.

## Every baseline occurrence

| Component | Original line | Rule / value | Disposition |
| --- | ---: | --- | --- |
| call-card/CallCardStyles.tsx | 402 | literal: `#fff` | fixed |
| call-card/CallCardStyles.tsx | 466 | literal: `rgba(` | fixed |
| call-card/CallCardStyles.tsx | 574 | literal: `#dcb740` | fixed |
| call-card/CallCardStyles.tsx | 575 | literal: `#16140c` | fixed |
| call-card/CallCardStyles.tsx | 612 | literal: `rgba(` | fixed |
| call-card/CallCardStyles.tsx | 612 | literal: `#fff` | fixed |
| call-card/CallCardStyles.tsx | 632 | literal: `#5c5d65` | exception |
| call-card/CallCardStyles.tsx | 633 | literal: `#c42b2b` | exception |
| call-card/CallCardStyles.tsx | 634 | literal: `#2f5fb3` | exception |
| call-card/CallCardStyles.tsx | 635 | literal: `#1e7a46` | exception |
| call-card/CallCardStyles.tsx | 636 | literal: `#b8481e` | exception |
| call-card/CallCardStyles.tsx | 772 | literal: `rgba(` | fixed |
| call-card/CallCardStyles.tsx | 773 | literal: `#ececee` | fixed |
| call-card/CallCardStyles.tsx | 780 | literal: `#ececee` | fixed |
| call-card/CallCardStyles.tsx | 784 | literal: `#a1a2a9` | fixed |
| call-card/CallCardStyles.tsx | 785 | literal: `#ececee` | fixed |
| call-card/CallCardStyles.tsx | 785 | literal: `rgba(` | fixed |
| call-card/CallCardStyles.tsx | 787 | literal: `rgba(` | fixed |
| call-limbo/CallReady.tsx | 82 | literal: `#000` | exception |
| call-limbo/CallReady.tsx | 81 | palette-utility: `bg-white` | exception |
| composite/ChatPanel.tsx | 375 | token-opacity: `bg-[var(--chalk-app-danger)]/10` | false-positive |
| composite/ScreenShareView.tsx | 140 | literal: `rgba(` | fixed |
| composite/ScreenShareView.tsx | 143 | literal: `rgba(` | fixed |
| composite/ScreenShareView.tsx | 147 | literal: `rgba(` | fixed |
| composite/ScreenShareView.tsx | 154 | literal: `rgba(` | fixed |
| composite/ScreenShareView.tsx | 157 | literal: `#c9cbd1` | fixed |
| composite/ScreenShareView.tsx | 204 | literal: `rgba(` | fixed |
| composite/ScreenShareView.tsx | 219 | literal: `rgba(` | fixed |
| composite/ScreenShareView.tsx | 219 | literal: `rgba(` | fixed |
| composite/ScreenShareView.tsx | 219 | literal: `#0b0c0e` | fixed |
| composite/ScreenShareView.tsx | 139 | palette-utility: `text-white` | fixed |
| composite/ScreenShareView.tsx | 147 | palette-utility: `text-white` | fixed |
| composite/ScreenShareView.tsx | 154 | palette-utility: `text-white` | fixed |
| composite/ScreenShareView.tsx | 162 | palette-utility: `!bg-white` | fixed |
| composite/ScreenShareView.tsx | 162 | palette-utility: `!text-white` | fixed |
| composite/ScreenShareView.tsx | 162 | palette-utility: `hover:!bg-white` | fixed |
| composite/ScreenShareView.tsx | 181 | palette-utility: `!text-white` | fixed |
| composite/ScreenShareView.tsx | 204 | palette-utility: `text-white` | fixed |
| composite/ScreenShareView.tsx | 219 | palette-utility: `text-white` | fixed |
| composite/ScreenShareView.tsx | 219 | palette-utility: `aria-pressed:bg-white` | fixed |
| control-bar/ShellStyles.tsx | 81 | literal: `#dcb740` | fixed |
| control-bar/ShellStyles.tsx | 82 | literal: `#16140c` | fixed |
| control-bar/ShellStyles.tsx | 112 | literal: `#dcb740` | fixed |
| control-bar/ShellStyles.tsx | 149 | literal: `rgba(` | fixed |
| control-bar/ShellStyles.tsx | 153 | literal: `#fff` | fixed |
| control-bar/ShellStyles.tsx | 235 | literal: `#111` | exception |
| control-bar/ShellStyles.tsx | 294 | literal: `#dcb740` | fixed |
| control-bar/ShellStyles.tsx | 314 | literal: `rgba(` | fixed |
| control-bar/ShellStyles.tsx | 320 | literal: `rgba(` | fixed |
| control-bar/ShellStyles.tsx | 357 | literal: `rgba(` | fixed |
| control-bar/ShellStyles.tsx | 396 | literal: `rgba(` | fixed |
| control-bar/ShellStyles.tsx | 514 | literal: `rgba(` | fixed |
| control-bar/ShellStyles.tsx | 549 | literal: `#16140c` | fixed |
| control-bar/ShellStyles.tsx | 551 | literal: `#dcb740` | fixed |
| control-bar/ShellStyles.tsx | 552 | literal: `#16140c` | fixed |
| control-bar/control-bar-button.tsx | 66 | palette-utility: `text-white` | fixed |
| media-request-dialog/MediaRequestDialog.tsx | 45 | token-opacity: `border-[var(--chalk-app-danger)]/35` | false-positive |
| media-request-dialog/MediaRequestDialog.tsx | 45 | token-opacity: `bg-[var(--chalk-app-danger)]/10` | false-positive |
| media-request-dialog/MediaRequestDialog.tsx | 55 | palette-utility: `text-white` | fixed |
| participant-tile/ParticipantTile.tsx | 125 | literal: `rgba(` | fixed |
| participant-tile/ParticipantTile.tsx | 133 | literal: `rgba(` | fixed |
| participant-tile/ParticipantTile.tsx | 133 | literal: `rgba(` | fixed |
| participant-tile/ParticipantTile.tsx | 165 | literal: `#ff6b6b` | fixed |
| participant-tile/ParticipantTile.tsx | 167 | literal: `#e2bd3a` | fixed |
| participant-tile/ParticipantTile.tsx | 218 | literal: `#e2bd3a` | fixed |
| participant-tile/ParticipantTile.tsx | 218 | literal: `rgba(` | fixed |
| participant-tile/ParticipantTile.tsx | 133 | palette-utility: `text-white` | fixed |
| participant-tile/ParticipantTile.tsx | 153 | palette-utility: `text-white` | fixed |
| participant-tile/TileShell.tsx | 62 | literal: `rgba(` | fixed |
| participant-tile/TileShell.tsx | 62 | literal: `rgba(` | fixed |
| participant-tile/TileShell.tsx | 67 | literal: `rgba(` | fixed |
| participant-tile/TileShell.tsx | 55 | palette-utility: `hover:bg-white` | fixed |
| participant-tile/TileShell.tsx | 55 | palette-utility: `active:bg-white` | fixed |
| participant-tile/TileShell.tsx | 67 | palette-utility: `text-white` | fixed |
| participants-panel/participant-options-menu.tsx | 141 | token-opacity: `bg-[var(--chalk-app-danger)]/10` | false-positive |
| participants-panel/participant-row.tsx | 91 | token-opacity: `border-[var(--chalk-app-control-active-line)]/30` | false-positive |
| space-header/SpaceHeader.tsx | 18 | literal: `#dcb740` | fixed |
| stage/SpaceStage.tsx | 80 | literal: `rgba(` | fixed |
| stage/SpaceStage.tsx | 90 | literal: `#d4d5d9` | fixed |
| stage/SpaceStage.tsx | 90 | literal: `#0b0c0e` | fixed |
| stage/SpaceStage.tsx | 90 | palette-utility: `hover:bg-white/10` | fixed |
| stage/SpaceStage.tsx | 90 | palette-utility: `aria-pressed:bg-white` | fixed |

## Enforcement and limits

React scans `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs` and CSS under `sdks/typescript/react/src/components`, excluding test/spec files and `node_modules`. It catches hex and color functions, named colors in common style/JSX properties, legacy theme variables, and static palette utilities (including gradients, outlines, shadows, directional borders and ring offsets). Transparent, currentColor, token fallbacks and Tailwind 4 opacity modifiers are valid. Comments, regex literals, URLs and JSX href/id fragments are masked without changing source locations.

React Native scans TypeScript under its `src`, excluding test/spec files and the authoritative `theme/tokens.ts`. It checks common color properties/attributes and box shadows, including quoted properties and JSX literal expressions. It allows transparent, currentColor and none.

These are static checks, not a CSS evaluator or a design/accessibility audit. They do not follow imported constants, concatenated class names, runtime prop values, arbitrary property names or computed/conditional style values. React files outside the component root and colors generated by dependencies are not covered. A token reference need not name a defined token. Theme declarations remain authoritative and are not scanned for token usage. Browser evidence covers representative states, not every affected state.

The gate planner puts both checks in the always-scheduled CI `checks` group. SDK source, scripts, baseline and exception inputs select their scanner; shared scanner, gate tests/configuration and workflow inputs fail closed to the full plan. Focused routing tests exercise those paths. No workflow change is needed.

## Updating an exception

Keep each exception limited to an exact snippet in one file, with a product reason. It must occur exactly once. Removing, duplicating or changing it fails the check rather than silently widening permission. A deleted exception file also fails the default React scan. Baseline updates remain count-sensitive and must be reviewed; the accepted styling-debt baseline is empty.
