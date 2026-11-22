# Helper permission onboarding

Helper asks for one permission, and only when the sharer chooses **Follow captured window**: macOS Screen Recording, so Helper can sample the shared window and keep marks on it. Windows needs no permission. Everything else here is about making that one grant short and hard to get wrong.

## macOS flow

1. The sharer chooses **Follow captured window**. If Screen Recording is already on, follow starts. If not, Settings shows **Allow Screen Recording** and nothing else happens: Helper never triggers the system prompt, so the sharer is never surprised by a dialog mid-call.
2. **Open System Settings** opens the Screen & System Audio Recording pane and shows a small floating tile with Chalk Helper's icon below the Settings window. The sharer drags the tile into the list, or switches Chalk Helper on if it is already there. The tile follows the Settings window, never takes focus, and is excluded from capture like every Helper window. A **Show Chalk Helper in Finder** link covers the case where the drag fails.
3. Helper watches for the grant once a second while the panel is open. macOS applies a new grant to a process only after it restarts, so Helper checks in a short child process (`--check-screen-recording`) that sees the new state. When that child reports access, Helper writes a resume note, relaunches itself and opens Settings with **Screen Recording is on**. Settings can also be dismissed with **Not now**, which leaves marks in the call preview and offers **Turn on window follow** later.

The resume note is a timestamp and a flag. It holds no secrets, expires after ten minutes, and is read once.

## What came from where

- **Hex** (open source dictation app) shows the pattern: read access without prompting, deep-link into the right Settings pane, and re-check when the app becomes active. Hex has no drag tile.
- **PermissionFlow** (MIT, Swift package) shows the drag tile: a non-activating floating panel that follows the System Settings window and a drag source carrying the app bundle. Helper is Rust and Objective-C, so it does not depend on the package. The roughly 150 lines in `native/permission_mac.m` find the Settings window by bundle id through the window list, which needs no Accessibility permission.

## Limits

- The browser cannot reconnect on its own after the relaunch. A pairing needs a fresh signed ticket, a native **Allow** click and a typed confirmation code, so the sharer reconnects from the call. Removing that step needs a resume token in the pairing protocol, or sampling windows in a child process so Helper never has to restart.
- The grant click itself cannot be automated or skipped, and nothing here tries to.
- Preview builds (`--features fixture`) can open any onboarding state with `--preview=<first_run|needed|settings|restarting|resumed|later>` and save PNGs of their own windows with `--snapshot=<dir>`. Real Helper windows are excluded from capture, so the preview window is not.

## Windows

Nothing to grant. Helper listens on `127.0.0.1:47361` only (a unit test pins this), so Windows Firewall does not prompt. The installer installs per user (`installMode: currentUser`), so no administrator prompt appears either. What remains is outside the code: an unsigned installer shows SmartScreen's "unrecognized app" screen until the build is code signed, and a machine without WebView2 downloads it during setup.
