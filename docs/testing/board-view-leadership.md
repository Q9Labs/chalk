# Camera leadership scenario table

All rows feed the real whiteboard SDK into the rendered React Board. Only the external Excalidraw engine is replaced in the DOM runner. Fake-clock idle timers run every 2 s in the foreground and every 60 s in the background. Each real move/Follow-me start has a 600 ms follower-camera deadline after delivery/readiness; no row permits a manual reload. Server signing and physical restore are separate live proof.

| Scenario | Round 4 helper | 8550a79d7 | b2d201ec6 | This fix |
| --- | --- | --- | --- | --- |
| Delayed frame from the same connection | PASS | PASS | PASS | PASS |
| Delayed pre-loss frame stamped after a post-reconnect move | PASS | PASS | FAIL | PASS |
| Owner direct first, then the selected relay | PASS | PASS | PASS | PASS |
| Follow-me start grants leadership; idle views retain it | FAIL | FAIL | PASS | PASS |
| Older idle tab cannot take over a throttled newer leader | FAIL | FAIL | PASS | PASS |
| Switch to older tab while newer tab is throttled | FAIL | FAIL | PASS | PASS |
| Switch back to newer tab without reload | PASS | FAIL | PASS | PASS |
| Real move during reconnect; no extra move after recovery | FAIL | FAIL | FAIL | PASS |
| One tab quiet for minutes, then resumes | PASS | PASS | PASS | PASS |
| Database rewind with surviving/new origins and relays both ways | FAIL | FAIL | PASS | PASS |
| Delayed pre-restore frame after recovery | FAIL | PASS | PASS | PASS |
| Cached Follow: enriched proof before the newer view | PASS | PASS | PASS | PASS |
| Cached Follow: enriched proof after the newer view | PASS | PASS | PASS | PASS |
| Legacy view then its enriched duplicate | FAIL | FAIL | PASS | PASS |
| Temporary socket loss versus authoritative participant leave | FAIL | FAIL | PASS | PASS |
| Idle keep-alives: zero camera writes | PASS | PASS | PASS | PASS |

Historical runs freeze the SDK, generated wire contract and Board at 8550a79d7; only the ordering helper changes for the round-4 comparison. The baseline loader does not overwrite the implementation checkout. On this 16-row table, each historical incarnation-based baseline passes 8/16. The first last-led head b2d201ec6 passes 14/16; this fix passes 16/16. The two extra rows pin delayed old-socket stamping and leading moves made during recovery.

The camera API table covers pan, wheel/pinch, clamped zoom, zoom buttons/reset, keyboard zoom, fit and first-content fitting. Every camera move leads by default; applying a followed view is the sole explicit exception. Discovery and idle refreshes do not lead. Focused regressions also cover intent coalescing, unavailable control replicas and monotonic legacy metadata. No suppressions were added; fallow reports zero introduced complexity/duplicate/dead-code findings.

## Local evidence

`scratchpad/held-sdk-proof-2026-10-23/r8/` contains the expanded row-by-row JSON, historical baseline loader and focused red/green results. The prior `r7/` directory retains frozen historical modules and the live harness.

## Real-stack restore proof

The final M4 admission ran direct under the lead's slot-limiter rule and exited 0. Two Chromium instances used the real SDK, Board, Excalidraw, Sync and PostgreSQL 18. A physical restore lowered the transaction ID from 987 to 853 while Sync and both established whiteboard sockets stayed live. The next real move reached Follow; authenticated relay frames worked in both directions between surviving and new sockets. A delayed pre-restore frame caused zero camera writes, and idle refreshes retained their stamp without moving the camera. An explicit Sync restart also recovered automatically with the origin sequence continuing.

`live-final/result.json` records source hashes for the SDK, ordering helper, Board, socket handler and proof derivation; all match this branch. `live-final/contact.png` pairs leader/follower before and after restore. These artifacts and the runnable harness are in the local evidence directory above. The preliminary admission stopped before browser startup because the isolated checkout lacked built React workspace declaration prerequisites; its logs remain in `live-setup-failure/`. The final harness resolves workspace sources directly. CI owns the full workspace build.
