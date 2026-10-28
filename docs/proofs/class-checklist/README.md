# Class checklist browser proof

Baseline runtime: `775c0b99140879634e1753a6f0164af10086a8fd`.
No runtime fixes are included. Run the opt-in slow suite using
[scripts/web-proof/class-checklist.md](../../../scripts/web-proof/class-checklist.md).
It starts a real local API, PostgreSQL-backed Sync and web app, with the real
development SFU. Three native Chromium processes hold independent role contexts.
Capture inputs are generated; admission, transport, playback and UI are real.

## Coverage before this change

No complete C1–C7 case had a real-stack browser test at the baseline.

| Case                            | Existing evidence                                              | Missing part added                                                                                      |
| ------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| C1, five joins                  | `tests/call.e2e.ts` has real two-browser audio/video           | Five timed admissions and exact three-way roster                                                        |
| C2, eight minutes hidden        | #564 has headful Chromium + real Sync/Postgres heartbeat proof | Full API/media call, eight actual hidden minutes, continuous roster-loss checks                         |
| C3, three-minute absence        | #568 SDK startup-failure fixtures                              | Close a real browser tab, wait 180 seconds, navigate and automatically rejoin <10 seconds               |
| C4, 60 seconds offline          | #565 browser/SDK proof uses an in-process Sync fixture         | Real stack, terminal UI, no stale tiles, one Rejoin                                                     |
| C5, 140 seconds offline         | #565/#568 recovery fixtures                                    | Visible browser, real wait, per-role IPv4/IPv6 and local-stack traffic cut, one Rejoin, roster and chat |
| C6, media after recovery        | Real media on initial admission only                           | Both-way received audio, advancing camera/share frames, stop/restart share, no duplicate tiles          |
| C7, whiteboard after background | Real board tests cover sync/layout/follow                      | Hidden-period stroke <10 seconds, new stroke and chat <5 seconds, no reload/rejoin                      |

## Collected evidence

Completed full diagnostic on test commit `7d5b6cdb18b8dcc5c224c09dc40fe854d7530230`:
972.10 seconds framework duration, exit 1. Case times are wall time inside each
case, not individual admission latency. Every admission has its own <10-second
assertion. C2/C7 share one hidden interval.

| Case | Outcome                                                                                   | Case time |
| ---- | ----------------------------------------------------------------------------------------- | --------- |
| C1   | Pass                                                                                      | 15.433 s  |
| C2   | Pass                                                                                      | 481.449 s |
| C3   | Harness failure: automatic rejoin was already live; helper wrongly waited for a name form | 205.152 s |
| C4   | Fail: Rejoin remained disabled after online restoration                                   | 75.098 s  |
| C5   | Pass: dual-stack 140-second outage, one Rejoin, roster and chat                           | 142.481 s |
| C6   | Audio assertion failed; source/sink attribution not yet established                       | 17.248 s  |
| C7   | Pass                                                                                      | 2.320 s   |

C3 now times navigation through automatic admission and checks every roster
within ten seconds. A fresh-call media control and bounded sender/receiver
statistics now distinguish a silent input or sink from a recovery regression.
The fresh-call control was then driven on test commit
`90419ab80a428baa749d141b77b0c488ec729eee` and failed in 28.36 seconds.
Both sources were running, with live enabled tracks, about 0.15 source audio
level and over 50 KB outbound audio each. Teacher received Student audio
(606 packets, level 0.1523); Student had no inbound audio report. A silent
generated source does not explain that failure. Its cause in the app,
development SFU or network path is not established, and the failure is not
specific to recovery. Share checks were not reached.

An Instabox SSH/API outage interrupted execution briefly; access returned.
**The required three final repetitions are not complete yet.** Queue attempts
do not count as executions or passes. Corrected C3 and the full frozen suite
will run without retries or relaxed deadlines.

C4 failed at `tests/class-checklist.e2e.ts:148` on the diagnostic commit:
`locator.click` timed out after 15000 ms on the disabled `Rejoin` button.
The terminal heading and absence of stale tiles had passed. An earlier full
diagnostic reproduced the same failure after its real 60-second outage.
C6 failed at line 344 on that commit: the received audio level stayed zero for
10000 ms. Camera/share checks were not reached. No product code, forced click,
reload, retry or deadline relaxation hides either failure.

![Key diagnostic frames](contact.png)

The first two frames show the actual eight-minute hidden interval and subsequent
whiteboard/chat catch-up. The lower left shows the disabled recovery action.
The lower right shows the successful roster/chat recovery after the 140-second
network cut. An earlier separate diagnostic also saw room-creation HTTP 500s
with an SFU transport error; those blocked setup and are not attributed to a
specific browser/network regression.

## Limits

- Role labels represent the public app's creator/guests, not an external host's role integration or account sign-in.
- Generated tones prove audio reception, not intelligible speech.
- Hidden Chromium tabs and Linux network cuts do not prove a particular PC, physical Wi-Fi adapter or ISP path. C8 is not covered.
- Raw logs, private invitations, credentials and production identifiers are not published.
- No merge, deployment or promote/nightly/npm workflow dispatch was performed.
