# iPhone Safari proof on the iOS Simulator

Opens a page in iPhone Safari on an iOS Simulator and taps **Allow** on the camera and microphone prompts, so a thread can prove a real mobile Safari join without a person at the Mac. Built for the Mac mini (Xcode, `xcodegen`, a booted simulator); it does not run on Linux.

```sh
PROOF_URL='https://example.com/classroom' PROOF_SECONDS=120 PROOF_OUT=./out ./run.sh
```

| Variable | Meaning |
| --- | --- |
| `PROOF_URL` | Required. The page to open. |
| `PROOF_SECONDS` | How long the UI test watches and screenshots (default 90). |
| `PROOF_OUT` | Output folder (default: an `out` folder next to the script). |
| `PROOF_DEVICE` | Simulator UDID (default: the booted one). |
| `PROOF_REOPEN_AFTER` | Seconds after which the URL is opened again, which is a reload and rejoin. |
| `PROOF_TAP_TO_HEAR=1` | Also taps the "Click to hear the call" notice, the gesture iOS needs before it plays sound. |
| `PROOF_TAP_CENTER_AT` | Seconds after which the middle of the page is tapped once. |

Output: `shot-NNN.png` every 5 seconds, `simulator.mp4` (screen recording), `ui-test.log` (every prompt it allowed, with timing) and `build.log` / `test.log`.

## How it works

`run.sh` generates an Xcode project with xcodegen (a tiny host app plus a UI test bundle), builds it for the simulator, starts `simctl io recordVideo`, opens the URL with `simctl openurl`, and runs one UI test. The test drives `com.apple.mobilesafari`: it polls for a system alert and taps Allow, and takes screenshots. A first build takes about 30 seconds.

## What it can and cannot prove

- The Simulator has **no camera and no microphone input**. Safari still asks for permission, so the prompt path is real, but the phone sends no media. Use it to prove that the page loads on iOS Safari, that the join completes, that remote video and audio arrive, and what iOS does about autoplay.
- Sign in without typing: Safari cannot be typed into from here. Serve a tiny page that answers with `Set-Cookie` for the portal's session and a redirect to the class, forward it with `ssh -R`, and use that page as `PROOF_URL`. Cookies are shared across ports on `localhost`, and a `localhost` origin is a secure context for `getUserMedia`.
- Network drops are not simulated.
- The "Allow" button text and the alert layout are English iOS 26; adjust `Tests/SafariProofTests.swift` for another language.
