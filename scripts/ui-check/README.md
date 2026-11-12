# UI check

The UI check stops visible breakage from reaching master. For a pull request that changes a UI path, it walks the same short journeys on the branch and on the base, and fails only on a problem that the branch adds.

The workflow is `.github/workflows/ui-check.yml`. Its job is named **UI check** and is a required status check. A pull request with no UI path passes it in seconds without walking anything. `ui-paths.mjs` holds the list of UI paths.

## What it walks

The call-state harness (`apps/web/vite.call-states.config.ts`) renders the real call and pre-join screens with fake camera tracks and a stubbed Space client. `journeys.mjs` lists the journeys: pre-join; calls of 1, 2, 4, 9 and 30 Participants; chat, people, details, settings, share, reactions and the phone More sheet; the board; screen share; mute and camera toggles; long names; reconnecting; leave. `capture.mjs` walks each one at phone (390 wide), tablet (820) and desktop (1440), in light and dark (the tablet in dark only). Chalk has no right-to-left language, so there is no right-to-left pass.

Every run uses a fixed clock, reduced motion, finished animations and loaded fonts. A screenshot is taken only after two shots a moment apart match, and the live microphone meter and the invite QR code are masked.

## What fails

1. **Layout checks** (`page-checks.mjs`) run in every frame: blank screen, sideways page scroll, element off the screen, child cut off by its parent, text clipped, two controls overlapping, a control with another layer over its center, and a tap target under 24 px (WCAG 2.2, 2.5.8). Journeys add: a click that changes nothing, a control that cannot be found or clicked, a screen that never finishes loading, and a console error.
2. **Baseline diff** (`verdict.mjs`): a finding blocks only when the same frame on the base does not have it. Problems that master already has never block.
3. **Pixel compare** (`compare.mjs`) boxes the regions that differ from the base and writes a before and after strip for each changed frame.
4. **Vision review** (`review.mjs`) sends the changed frames to a Claude model with one question per screen: is anything visibly broken. A finding blocks only when its region overlaps a region that the pixel compare found changed. It needs `ANTHROPIC_API_KEY`; without the key (pull requests from forks) it is skipped and the layout checks still decide.

The `report` job posts one sticky comment (marked `<!-- chalk-ui-check -->`) with the journeys, the findings and the before and after images. When the check fails it pushes the images to the `ui-check-evidence` branch so the comment can show them. That job holds the write permissions and runs no code from the branch.

## Run it locally

```sh
node scripts/ui-check/run.mjs --base origin/master
```

This checks the base ref out in a temporary worktree, installs it and walks both sides, so it needs about 6 minutes and a machine with 4 cores; use Instabox, not a laptop. `--only chat,call-9` walks the journeys whose id starts with those prefixes. The report goes to the `ui-check-report` folder: the comment text, the full findings as JSON, and the screenshots.

`--base-cache DIR` keeps the base walk in `DIR`. A later run reuses it when the base commit and the check code are the same, which is how the pull request run walks only the branch.

## Change it

Add a journey in `journeys.mjs`. A step is `{ click: name | [names], via?: name, ready?: selector }` or `{ key }`. Use `via` for a control that lives behind the phone More sheet. Run `node --test scripts/ui-check/*.test.mjs` after changing `page-checks.mjs`; the tests build a small page for each check.
