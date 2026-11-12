# Class checklist (slow, local stack)

## Live-class checks

Operator checks before treating a class as healthy. Record times in PKT. They are not automated.

1. **W33, media recovery exhaustion:** confirm audio and video in both directions even when chat and the board work. For missing audio, mute then unmute; if still broken, use **Report a problem** when available and rejoin once. If that fails, use the agreed fallback.
2. **W34, slow media start or failed join:** watch camera and microphone startup through the join result. If it fails, check permissions and device selection, use **Report a problem** when available, and rejoin once. If that fails, use the agreed fallback.
3. **W35, local mic on but remote muted:** compare the local mic button with a classmate's mute badge and received audio, including on iPad. Mute then unmute; if still silent, use **Report a problem** when available and rejoin once. If that fails, use the agreed fallback.

For every unresolved failure, report the Episode ID, PKT time and device or browser. Do not infer a browser or network cause from the symptom alone.

## Automated local proof

`tests/class-checklist.e2e.ts` automates C1 to C7 of the class go/no-go checklist against the real web app, local API, PostgreSQL-backed Sync and the development Cloudflare SFU. Only camera, microphone and display sources are synthetic; admission, transport, decoding and rendering are not mocked. It does not test TH's role integration or account login.

Run on a disposable Instabox with root dependencies, Go, Elixir dependencies, Chromium, Xvfb, Docker, and passwordless `sudo` with `setpriv`, `iptables` and `ip6tables` (C5 uses them to drop the student's traffic, including the SFU UDP that DevTools cannot block; rules are removed in `finally`):

```sh
GOTOOLCHAIN=auto CHALK_CLASS_SFU_FILE="$HOME/class-sfu.json" CHALK_CLASS_RUN=1 xvfb-run -a pnpm test:class-checklist
```

The JSON file is supplied over SSH, never in Git: `environment` is `development`, `source` is `chalk-local-dev`, plus `appId`/`appSecret` from the local-development SFU item. Never point this at production or nightly. Append `--grep '^C1:'` for a short diagnosis.

Judgment worth keeping:

- A setup failure before a case starts is **blocked**, not passed. C6 does not run if C5 fails.
- C2 and C7 share one eight-minute background interval, with the student's camera off and its tab hidden by another window. This tests real background behaviour, not an accelerated clock, and it does not claim intensive timer throttling of an active WebRTC connection.
- C4 uses Chromium offline emulation. Nothing here exercises a physical Wi-Fi adapter or a particular ISP, and C8 and PC/ISP comparisons stay outside this suite.
- Recovery deadlines read the SDK's actual recovery defaults instead of a shorter fixed wait.
- C6 checks distinguishable tones and advancing decoded video, not speech recognition.

Results and screenshots go to `.private/class-checklist/run-<CHALK_CLASS_RUN>/`.
