# Helper permission onboarding

Helper asks for one permission, and only when the sharer chooses **Follow captured window**: macOS Screen Recording, so Helper can sample the shared window and keep marks on it. Windows needs no permission. Everything else here is about making that one grant short and hard to get wrong.

## macOS flow

1. The sharer chooses **Follow captured window**. If Screen Recording is already on, follow starts. If not, Settings shows **Allow Screen Recording** and nothing else happens: Helper never triggers the system prompt, so the sharer is never surprised by a dialog mid-call.
2. **Open System Settings** opens the Screen & System Audio Recording pane and shows a small floating tile with Chalk Helper's icon below the Settings window. The sharer drags the tile into the list, or switches Chalk Helper on if it is already there. The tile follows the Settings window, never takes focus, and is excluded from capture like every Helper window. A **Show Chalk Helper in Finder** link covers the case where the drag fails.
3. Helper watches for the grant once a second while the panel is open. macOS applies a new grant only to processes that start after it, so the check runs in a short child process (`--check-screen-recording`). When that child reports access, Helper closes the panel and starts following the window. **Not now** leaves marks in the call preview and offers **Turn on window follow** later.

## No restart

Helper never relaunches itself for a grant, so the pairing and the Sync attachment survive it. A running process keeps its old answer about Screen Recording, so window pixels come from a long-lived child (`chalk-helper --window-sampler`, in `src/sampler.rs`) that starts after the grant and therefore has it. Helper writes `window <id>` lines to the child's stdin and reads back one status byte and, on success, one 72 by 72 RGBA frame, the same buffer the landmark match always read. Window bounds and identity stay in Helper: they need no permission and depend on Helper's own overlay window.

- The child starts when follow is enabled without in-process access and stops when the window share ends. It also exits when Helper's pipe closes, so a crashed Helper leaves no orphan.
- A dead or silent child is killed and replaced once per request. If the replacement fails too, the next attempt waits a second.
- When the grant arrives, macOS may offer to quit Helper. The panel tells the sharer to choose **Later**, because Helper doesn't need it. If they quit anyway, Helper reopens normally and the call offers pairing again.

## What came from where

- **Hex** (open source dictation app) shows the pattern: read access without prompting, deep-link into the right Settings pane, and re-check when the app becomes active. Hex has no drag tile.
- **PermissionFlow** (MIT, Swift package) shows the drag tile: a non-activating floating panel that follows the System Settings window and a drag source carrying the app bundle. Helper is Rust and Objective-C, so it does not depend on the package. The roughly 150 lines in `native/permission_mac.m` find the Settings window by bundle id through the window list, which needs no Accessibility permission.

## Limits

- Quitting Helper after the grant loses the pairing, because a pairing needs a fresh signed ticket, a native **Allow** click and a typed confirmation code. Making a known device pair in one click is a pairing protocol change and is not part of this.
- The grant click itself cannot be automated or skipped, and nothing here tries to.
- Preview builds (`--features fixture`) can open any onboarding state with `--preview=<first_run|needed|settings|later>` and save PNGs of their own windows with `--snapshot=<dir>`. Real Helper windows are excluded from capture, so the preview window is not. `--preview=sampler` writes `sampler.txt`, a timeline of a simulated grant and a killed capture child with Helper's process ID on every line.

## Windows

Nothing to grant. Helper listens on `127.0.0.1:47361` only (a unit test pins this), so Windows Firewall does not prompt. The installer installs per user (`installMode: currentUser`), so no administrator prompt appears either. What remains is outside the code: an unsigned installer shows SmartScreen's "unrecognized app" screen until the build is code signed, and a machine without WebView2 downloads it during setup.
