# Class checklist (slow, local stack)

`tests/class-checklist.e2e.ts` automates C1–C7 from the class go/no-go checklist.
It uses the real web app, local API, PostgreSQL-backed Sync/whiteboard and the
approved **development** Cloudflare SFU. Camera, microphone and moving display
capture are deterministic sources; admission, networking, media transport,
decoding, rendering and user actions are not mocked. Teacher, Student and Admin
are independent browser contexts/processes, using the web app's invite roles
(creator/guests); this is not a test of TH's role integration or account login.

Run on a disposable Instabox with root dependencies, Go, Elixir dependencies,
Chromium (`pnpm exec e2e-web install chromium --with-deps` and
`pnpm exec playwright install --with-deps chromium`), Xvfb and Docker available:

```sh
GOTOOLCHAIN=auto CHALK_CLASS_SFU_FILE="$HOME/class-sfu.json" CHALK_CLASS_RUN=1 xvfb-run -a pnpm test:class-checklist
```

Supply the private JSON file over SSH, never in Git: `environment` must be
`development`, `source` must be `chalk-local-dev`, and `appId`/`appSecret` must
come from the approved local-development SFU item. The supervisor passes the
credentials only to local services and owns cleanup on success and failure.
Never point this command at production or nightly.

There was no existing slow split. `CHALK_CLASS_CHECKLIST=1` selects only this
suite and extends its per-test timeout to eleven minutes; ordinary `test:e2e`
still selects the existing call and board suites. A sixth fresh-call control uses the same native-browser media assertions before
any outage; failed media runs also save bounded sender/receiver audio evidence.
No model assertions or cache
entries are used. Retries remain disabled. Each fresh invocation starts its own
local stack and writes case outcomes/timings and screenshots under
`.private/class-checklist/run-<CHALK_CLASS_RUN>/`. A setup failure before a case
starts is **blocked**, not passed; a dependent C6 is not run if C5 fails.

C2 and C7 share one eight-minute background interval. C5 and C6 share a recovered
call, so a failing 60-second recovery does not prevent the media check after a
successful 140-second recovery. The student is muted with its camera off during background; another tab
in its own window hides it. CDP `noDefaults` avoids forcing it visible. This
tests real background behaviour, not a synthetic freeze or an accelerated
clock. It does not claim an active WebRTC connection enters intensive timer
throttling. C4 uses Chromium network-offline emulation. C5 additionally drops
the student's IPv4/IPv6 non-loopback traffic and local stack TCP traffic with a Linux
process-group firewall rule, including SFU/UDP traffic that DevTools does not
block. It needs passwordless `sudo`, `setpriv`, `iptables` and `ip6tables`; rules are removed in `finally`.
Neither test exercises a physical Wi-Fi adapter or a particular ISP.
C6 uses distinguishable tones rather than speech
recognition; it checks audio received both ways and advancing decoded video
and restarted-share frames. C8/PC/ISP comparisons remain outside this suite.

The harness supplies `/space` explicitly because the local launcher's route
scanner does not recognize the current pathless layout. It also starts an
isolated PostgreSQL container and waits for the final server (not the temporary
entrypoint server) before handing it to the supervisor. The container and its
anonymous data volume are removed in `finally`. No product code is changed for
either startup workaround. Use e2e's normal `--grep` flag for a short diagnosis,
for example append `--grep '^C1:'` to the command above.
