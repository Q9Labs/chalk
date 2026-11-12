# UI check

The UI check stops visible breakage from reaching master. For a pull request that changes a UI path, it walks the same short journeys on the branch and on the base, and fails only on a problem that the branch adds.

The workflow is `.github/workflows/ui-check.yml`. Its job is named **UI check** and is a required status check. A pull request with no UI path passes it in seconds without walking anything. `ui-paths.mjs` holds the list of UI paths.

## What it walks

The call-state harness (`apps/web/vite.call-states.config.ts`) renders the real call and pre-join screens with fake camera tracks and a stubbed Space client. `journeys.mjs` lists the journeys: pre-join; calls of 1, 2, 4, 9 and 30 Participants; chat, people, details, settings, share, reactions and the phone More sheet; the board; screen share; mute and camera toggles; long names; reconnecting; leave. `capture.mjs` walks each one at phone (390 wide), tablet (820) and desktop (1440), in light and dark (the tablet in dark only). Chalk has no right-to-left language, so there is no right-to-left pass.

Every run walks a static build of the harness (no dev server, so module loading takes no time that varies with load), with a fixed clock, finished animations and loaded fonts. A timer of 2.5 seconds or more never fires, so nothing hides or leaves by itself. The page must stay quiet for 300 ms before a frame is taken, and a screenshot is taken only after two shots a moment apart match. The live microphone meter and the invite QR code are masked, and the remote board cursors, which roam by the clock, are hidden.

## What fails

1. **Layout checks** (`page-checks.mjs`) run in every frame: blank screen, sideways page scroll, element off the screen, child cut off by its parent, text clipped, two controls overlapping, a control with another layer over its center, and a tap target under 24 px (WCAG 2.2, 2.5.8). Journeys add: a click that changes nothing, a control that cannot be found or clicked, a screen that never finishes loading, and a console error.
2. **Baseline diff** (`verdict.mjs`): a finding blocks only when the same frame on the base does not have it. Problems that master already has never block.
3. **Pixel compare** (`compare.mjs`) boxes the regions that differ from the base and writes a before and after strip for each changed frame.
4. **Model review** (`review.mjs`) runs the Claude Code CLI headless (`claude -p`, Claude Opus 5.5 at high effort, only the Read tool) on the Q9 Claude subscription. It reads the changed frames as image files and answers one question per screen: is anything visibly broken. A finding blocks only when its region overlaps a region that the pixel compare found changed. It needs the repository secret `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`); there is no API key and no per-token cost. Without the token (pull requests from forks, or a missing secret) the review is skipped, and the comment says in its title and its review line that the model did NOT review, so a skip is never read as a pass; the layout checks still decide.

The `report` job posts one sticky comment (marked `<!-- chalk-ui-check -->`) with the journeys, the findings and the before and after images. When the check fails it pushes the images to the `ui-check-evidence` branch so the comment can show them. That job holds the write permissions and runs no code from the branch.

## Run it locally

```sh
node scripts/ui-check/run.mjs --base origin/master
```

This checks the base ref out in a temporary worktree, installs it and walks both sides, so it needs about 4 minutes and a machine with 4 cores; use Instabox, not a laptop. `--only chat,call-9` walks the journeys whose id starts with those prefixes. The report goes to the `ui-check-report` folder: the comment text, the full findings as JSON, and the screenshots.

`--base-cache DIR` keeps the base walk in `DIR`. A later run reuses it when the base commit and the check code are the same, which is how the pull request run walks only the branch.

## Change it

Add a journey in `journeys.mjs`. A step is `{ click: name | [names], via?: name, ready?: selector }` or `{ key }`. Use `via` for a control that lives behind the phone More sheet. Run `node --test scripts/ui-check/*.test.mjs` after changing `page-checks.mjs`; the tests build a small page for each check.

## Who can read the Claude token

The workflow runs from the pull request's own branch, so anyone who can push a branch to this repository can edit it and read any repository secret, this one included. That is how GitHub's `pull_request` event works for every secret, and this check does not widen it. What the check does to keep the token away from anyone else:

- Forks get no secret, and the CLI is not installed for them.
- Only `review.mjs` hands the token to a process, and only to the `claude` child. That child runs in a new folder outside the checkout with an empty home, so it finds no `CLAUDE.md`, settings, hook or skill of the pull request, and it can only read the images placed there.
- The `report` job, which can write, runs no code from the branch.

If the owner wants a boundary against people who can push branches, the fix lives in repository settings, not in this code: store the token as a secret of an Environment that needs a reviewer's approval, and add `environment:` to the review step's job.
