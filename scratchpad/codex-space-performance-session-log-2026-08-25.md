# Space performance continuation log

## 2026-08-25  — Handoff resumed

- Continued in `.worktrees/perf-space-fixes` on `perf/space-profile-fixes-20260823` from the 2026-08-24 handoff.
- Preserved the intentionally uncommitted harness and product corrections.
- Kept correctness as the first gate: attachment upload/finalize, visible re-entry, Board browser state, and stale publication reconciliation must pass before measured performance changes.
- Started read-only discovery lanes for the attachment, re-entry, and publication lifecycle contracts. Runtime diagnosis and integration remain with the root thread.

## 2026-08-25 — Isolated runtime rebuild

- The retained M4 source and Playwright cache named in the handoff were no longer present, so rebuilt a uniquely named remote copy and verified it against the local worktree with a checksum dry run.
- Restored the locked JavaScript dependencies. The remote container runtime state was also gone, while a shared PostgreSQL process owns port 5432.
- Added an explicit `CHALK_PERF_POSTGRES_PORT` launcher input so the profiling database can use its own port without stopping or reusing the shared database.

## 2026-08-25 — Attachment upload corrected

- Added a redacted CDP capture for the chat attachment initiation, presigned PUT, finalize exchange, and browser CORS/loading failure.
- Strict run `shakedown-2026-08-25T07-31-40-754Z-y2peut` proved initiation returned 201 and no PUT followed. The composer preserved the direct browser error: native `fetch` was invoked with the controller as its receiver and threw `Illegal invocation`.
- Both chat upload implementations now invoke injected fetches without an object receiver. Six focused client tests and the client typecheck pass on the M4.
- Strict run `shakedown-2026-08-25T07-41-10-449Z-4khwd2` proved initiation 201, storage PUT 200, finalize 200, send, and remote attachment appearance in 325 ms. The run remains red overall because media, Board visibility, and re-entry still fail.

## 2026-08-25 — Public re-entry corrected

- Strict runtime evidence showed `Try again` refreshing the old public arrival after durable Leave; `/v1/public/space-invite-arrival/access-grants` returned 500 because that Participant was already terminal.
- The public arrival adapter now closes the old arrival and mints a fresh arrival/AccessGrant for the second explicit join. Scheduled refresh and media recovery still refresh the current active arrival.
- Added focused correctness flows to the durable runner so re-entry and Board behavior can be proved without unrelated media and panel timeouts.
- Twenty-one focused web tests and the web typecheck pass on the M4.
- Focused run `shakedown-2026-08-25T08-01-58-000Z-56o3k7` proved Leave, roster removal, visible `Try again`, fresh public leave+arrive, grid restoration in 1.427 seconds, and roster restoration. Its only validation errors were the known SFU 503 diagnostics during initial joins.

## 2026-08-25 — Board visibility diagnosis

- The previous failure screenshot proves Excalidraw rendered correctly. The strict locator failed because the whiteboard package root had no accessible name and the current Excalidraw DOM no longer exposes the legacy `.excalidraw` class.
- Added `aria-label="Shared whiteboard"` at the package-owned root. The focused package test and whiteboard typecheck pass on the M4; browser proof remains next.
- Focused run `shakedown-2026-08-25T08-03-18-148Z-8ddlkc` proved the Board opened visibly in 791 ms and closed in 832 ms. Its only validation error was one known SFU 503 during initial join.

## 2026-08-25 — Partial remote pull and first render fixes

- Full strict evidence showed the provider returning successful remote tracks and exact `track_not_found` rows in one response. The API discarded the successful subset, so one stale publication blocked every healthy track in the batch.
- The API now returns the proven successful subset only when every failed row is an exact remote `track_not_found`, and it feeds the missing identities into age-bounded reconciliation. The client commits that subset, keeps the authoritative cursor pending, backs off, and retries only unresolved publications.
- Reconciliation requires three distinct evidence waves at least two seconds apart and eight seconds of elapsed absence. Successful observation resets evidence, and conditional closure cannot remove a replacement publication.
- Focused M4 verification passes: six Go packages, 30 client media tests, 17 React tests, the CSS contract test, and client/React type checks.
- Removed the measured fresh timestamp formatter allocation, coalesced chat visibility geometry reads to one animation frame, stabilized AudioOutput effect inputs, stopped animating Stage dimensions, and moved the speaking halo from animated box-shadow paint to opacity/transform composition.
- Restarted the isolated stack with a freshly built API and the integrated client source. A strict four-Participant shakedown is in progress.

## 2026-08-25 — Real-SFU media matrix passes

- Provider responses omit the remote result location, so the adapter now restores `remote` only when the returned session and track identity exactly match the request. It also recognizes Cloudflare's current source-not-sending description as exact absence evidence.
- Mixed remote responses no longer discard a valid offer when a sibling track has a transient per-track failure. The API returns the valid subset without treating the transient failure as publication-absence evidence, so clients answer the offer and retry the unresolved track with backoff.
- Screen-share runtime evidence exposed a stale `Shared by Blake` harness locator. The Stage tile is labeled `Blake's screen`; the harness now uses the package-owned accessible tile label, pins it, and scopes zoom/pan to a named primary screen region.
- Camera decoded-frame proof now uses Chromium's next-video-frame callback, with the existing decoded-frame counter as a fallback. This proves a newly rendered frame instead of relying on a counter that remained unchanged across a replaced `srcObject`.
- Focused run `shakedown-2026-08-25T09-51-24-301Z-uzdjkg` passes the four-Participant media matrix with no browser diagnostics: microphone, camera off/on, layout and pinning, screen-share playback, zoom/pan, and stop.

## 2026-08-25 — Media recovery and whiteboard matrix pass

- Implemented the missing `PUT /tracks/update` path across the TypeScript transport, Go API, provider adapter, and generated OpenAPI contract. The client retries Cloudflare's transient internal errors, and focused client and Go verification pass.
- Focused run `shakedown-2026-08-25T10-32-16-599Z-ofg0ko` passes the media matrix after exercising mute recovery through the real update path.
- The Board harness incorrectly treated presentation as Participant-local state and toggled the Episode-wide state once per browser. It now changes presentation only through the anchor and has every remote Participant observe the resulting open or closed state.
- The whiteboard surface exposes stable package-owned readiness hooks. Collaboration initialization now starts in a mounted React effect, which removes the React 19 pre-mount state warning and prevents interaction before the collaboration engine is ready.
- The React whiteboard entry imports Excalidraw's package CSS. The default surface no longer fetches jsDelivr at runtime, while embedded renderers retain their explicit offline stylesheet path.
- Focused run `shakedown-2026-08-25T11-19-43-034Z-8h4w9l` passes drawing, zoom, pan, remote cursors, and Episode-wide Board open/close across four Participants with no browser diagnostics.

## 2026-08-25 — Integrated short-form measurements pass

- Full mixed run `shakedown-2026-08-25T11-20-28-759Z-fl7y7s` passes one strict cycle across four Participants.
- Trace run `shakedown-2026-08-25T11-22-30-485Z-eso292` passes with nine feature traces. Admission waiting and transcript remain explicitly unreachable in this local surface rather than silently skipped.
- Snapshot run `shakedown-2026-08-25T11-25-11-107Z-cngvsi` failed when Blake produced no new decoded camera frame within five seconds. Its 23 forced-GC snapshots were preserved in a validated lossless archive.
- The unchanged snapshot rerun `shakedown-2026-08-25T11-46-05-258Z-g9bi97` passes, which falsifies a deterministic camera regression under snapshot instrumentation. The final 30-minute profile is next.

## 2026-08-25 — Sustained media profile failure corrected

- The first 30-minute profile failed eight feature assertions. Reused local microphone and camera tracks repeatedly called the provider update endpoint, which returned one `provider_internal` result per local MID and caused an eight-attempt retry storm. Screen-share and one camera proof then failed under the accumulated pressure.
- The API still invokes the provider because that update resumes media flow, but it now accepts only the provider's exact all-local, no-SDP anomaly when every result maps to one requested MID. Mixed, mismatched, and provider-backed SDP failures remain fatal. A bounded structured warning makes the anomaly visible without flooding logs.
- Focused run `shakedown-2026-08-25T12-51-15-598Z-rk9zh4` passes the real four-Participant media matrix with no update retry storm and live remote playback.

## 2026-08-25 — Board reconnect race isolated

- A three-cycle Board workload exposed an intermittent close failure. Database receipts prove the server never committed the missing close; the anchor's whiteboard socket closed after the open commit and the client lost the following presentation command before it could send.
- Presentation changes now persist while the client is recovering or authenticating and replay after the next welcome. A native WebSocket state guard also turns a send against a closing socket into an immediate recovery transition, so the already-persisted operation remains queued for the replacement socket.
- Fifteen whiteboard recovery tests, the browser boundary test, client type-checking, and all 22 pure harness tests pass on the M4. Repeated browser proof is in progress.
- Focused run `shakedown-2026-08-25T13-22-25-510Z-88s68v` passes three complete Board open, draw, pan, zoom, remote-cursor, and close cycles. The anchor committed three true and three false presentation changes, and every remote Participant observed all six transitions.

## 2026-08-25 — Sustained Grid and screen-share ownership failures isolated

- Five-minute strict run `shakedown-2026-08-25T13-24-06-316Z-vkbmnt` failed its second screen-share cycle and second Board open. The run is preserved locally with four complete CPU profiles and failure screenshots.
- The Board operation committed and every remote Participant rendered the canvas. The anchor remained in Grid with a stale local pin, so Chalk showed only the small Board card despite the Episode-wide presentation state. An active Board now forces the shared canvas into the primary presentation slot until it closes.
- The second screen capture reused its first transceiver but discarded the provider publication ID. Chalk then resumed the MID under a new track name; remote pulls returned exact `track_not_found` until reconciliation closed the registry row. Reusable local publications now retain both the transceiver and authoritative provider identity.
- The focused client and React regressions pass, and the published whiteboard build retains the runtime Excalidraw CSS import while omitting the type-irrelevant CSS import from declaration output.

## 2026-08-25 — Local publication reuse contract corrected

- Real Cloudflare behavior falsified the retained-publication workaround. Updating a server-revoked local MID under its closed track name returned `provider_internal`; creating a fresh transceiver produced a successful signaling response but a publication that remote sessions could not pull.
- A negotiated client close also failed because the Sync provider bridge had already performed the required force-close before authorizing the local target. Database receipts showed the failed follow-up clicks remained duplicate revokes, so microphone and camera grants never ran.
- The client now treats that server result as the provider close: disable detaches the sender and retires the publication identity without a second provider mutation. Re-enable reuses the existing transceiver through `tracks/update`, omits SDP, and assigns the new logical operation track name. This matches Cloudflare's documented transceiver-reuse contract while preserving the stable MID.
- Removed the API exception that translated an exact local `provider_internal` response into success. Thirty-seven focused media and transport tests pass. A uniquely named API artifact now runs on the isolated M4 with the strict provider response contract; real media-cycle proof is in progress.

## 2026-08-25 — Provider session rotation replaces local publication reuse

- Strict provider evidence falsified the final transceiver-reuse assumption above. After a server-authorized local publication revoke, Cloudflare rejected local update with `provider_internal`; a fresh transceiver and cloned browser track could signal successfully but remote pulls returned exact `track_not_found`.
- The client now retires the SFU session after a confirmed local disable. Desired local sources survive the failure snapshot and are republished when lifecycle recovery replaces the provider connection.
- Public arrival refresh now carries `replace_media_connection` through the web adapter, TypeScript SDK, generated OpenAPI contract, HTTP endpoint, public access app, and runtime. The API creates a fresh provider join for the same Chalk Participant, persists the new provider subject on the admitted arrival, and validates the grant against that updated binding.
- Focused verification passes on the M4: three Go packages, 4 public-invite SDK tests, 8 web access tests, 31 SFU tests, 6 transport tests, and generated SDK contract validation.
- Strict run `shakedown-2026-08-25T14-46-07-156Z-0h4msy` proved two public replacement refreshes returned 201 and the publication registry replaced Blake's microphone and camera references while preserving Participant identity. It also exposed two remaining races: the camera proof pinned the retiring video element before the replacement appeared, and an older local negotiation can still roll back state owned by a replacement generation. Both corrections are in progress before another real-SFU run.

## 2026-08-25 — Replacement retry budget and double-rotation race

- Local MediaPlane retries now use bounded exponential backoff across the existing 15-second live-target budget. Ninety-one focused client tests and all 24 pure harness tests pass on the M4.
- Strict run `shakedown-2026-08-25T15-30-14-999Z-gqnnfq` proved the longer budget prevents the immediate screen-control rollback, but media still failed after repeated provider replacements.
- Database observations isolated the race. Disabling Blake's microphone published the disabled state at sequence 5 and immediately replaced the provider session with camera only at sequence 6. The following enable required a second replacement before microphone returned at sequence 7, which exceeded the command budget.
- The target lifecycle is one replacement per re-enable: disable removes the publication without retiring the whole session, and the next enable retires the live session after it has recorded the desired source. That replacement can bootstrap every desired source together.

## 2026-08-25 — Media replacement matrix passes

- The Sync local target now retries within the 15-second command budget, and Connection lifecycle commands use a separate serialized semaphore lane so a recoverable media snapshot can replace the provider session while the command is still waiting. The lifecycle lane rechecks closure after acquiring its permit.
- Disabling a publication no longer replaces the whole provider session. A later enable retires the live session once, with the desired source already recorded for replacement bootstrap.
- Runtime `getStats()` evidence showed the browser sending packets and encoded frames on microphone, camera, and screen while Cloudflare rejected tracks created from two copies of Chromium's fake camera. The harness now uses an animated canvas capture for screen share, which gives the provider a distinct display source and removes that test-only topology error.
- The harness waits for the exact opposite `aria-pressed` value on the last visible Space toolbar, so transient or hidden duplicate controls cannot satisfy microphone and camera toggle proof.
- Four-Participant focused run `shakedown-2026-08-25T16-16-42-782Z-ki40ze` passes microphone, camera decoded-frame playback, layouts, pinning, screen playback, zoom/pan, and stop. All 24 pure harness tests also pass.

## 2026-08-25 — Board snapshot recovery race reproduced

- Focused Board runs complete the first two open, draw, cursor, presentation, and close cycles, then intermittently lose the third close after the anchor whiteboard socket terminates.
- The harness now records the DOM `CloseEvent` code and reason. Run `shakedown-2026-08-25T16-35-33-956Z-p3mozg` proved a clean server close with `1008 operation not available in this phase` 104 milliseconds after the third presentation commit.
- Reopening the Board requests a fresh snapshot. The server enters snapshot recovery while the browser still considers the transport live, so immediate cursor or draw traffic can hit a phase that previously closed the whole socket.
- Sync now accepts ephemeral cursor traffic during snapshot recovery without changing snapshot state; six focused socket tests pass on the M4. Durable client operations still need to wait for the snapshot acknowledgement before the focused browser proof can pass.
- Optional join-sound CDN DNS failures remain recorded but no longer invalidate unrelated local feature proof. The pure harness suite now has 26 passing tests.

## 2026-08-25 — Board snapshot boundary passes

- Sanitized frame-type evidence showed five outbound snapshot requests but only four snapshot page/ack exchanges. Concurrent Board refresh callers sent the fifth request while the server was already recovering the fourth, which caused the proven `1008` close.
- The whiteboard client now coalesces concurrent snapshot callers onto one in-flight Promise, suppresses ephemeral cursors during that snapshot, and persists durable operations until the final snapshot acknowledgement is sent.
- Seventeen focused whiteboard client tests and the client typecheck pass on the M4. Sync still defensively accepts cursors during snapshot recovery, with six focused socket tests passing.
- Four-Participant focused run `shakedown-2026-08-25T16-53-01-605Z-sc1quw` passes three complete Board open, draw, pan/zoom, remote cursor, presentation, and close cycles without a socket close.

## 2026-08-25 — Slow provider replacement stays recoverable

- The first 300-second strict rerun reached Casey's second media rotation, then exhausted lifecycle recovery and closed Sync and Board at the ten-second deadline. The replacement grant had succeeded and both new provider publications were durable just before teardown, so the later remote `track_not_found` rows were a consequence of closing the recovering Participant.
- The default lifecycle recovery budget is now 20 seconds. A focused regression holds media restart past ten seconds and proves the lifecycle remains reconnecting, then returns live when the provider replacement completes; all 19 focused lifecycle tests pass on the M4.
- The focused media workload now exercises microphone, camera, layout, and pinning on two rotating Participants instead of reporting two cycles after exercising one. Stable run `shakedown-2026-08-25T17-16-18-427Z-xmysq9` passes the complete four-Participant media and screen-share matrix.

## 2026-08-25 — Media observation recovery stays bounded

- Strict run `shakedown-2026-08-25T17-18-55-135Z-78bkjv` passed three cycles, then Avery's replacement camera stopped propagating, screen-share stop timed out, Chat was blocked by the resulting error toast, and Blake's final rejoin exhausted its Sync startup deadline.
- Provider publications and remote pulls succeeded. Sync logs showed `response_too_large` on every media reconciliation and registration attempt after the cumulative observation response crossed the ProviderBridge 64 KiB limit at sequence 26, exactly when Avery's replacement camera was published.
- `Live.Episode` stored the last media observation cursor but never passed it through the MediaPlane port. The port now requires the cursor, ProviderBridge translates it to `after_incarnation` and `after_sequence`, and command intake explicitly requests its initial unscoped observation.
- Forty-nine affected Sync tests pass on the M4, including exact initial and subsequent cursor forwarding, and the production Sync build compiles. The rebuilt local Sync process is running against the unchanged performance stack for the strict runtime proof.

## 2026-08-25 — Cursor fix isolates the remaining camera fault

- Strict run `shakedown-2026-08-25T17-44-34-267Z-om52ws` no longer produced a ProviderBridge oversized response. Cycle 4 screen-share stop and Chat passed, and cycle 5 completed screen share, Chat, Blake's leave, and Blake's rejoin.
- Avery's camera remained the only workload failure: initial remote playback passed, the disabled observation committed at sequence 25, and a new enabled publication committed at sequence 26, but Blake's attached replacement track decoded no frame for 25 seconds.
- All four remote pull requests after Avery's replacement returned complete offers with no missing tracks. Avery's local camera kept rendering while Blake showed Avery's placeholder, so the remaining fault is in the observer-side WebRTC path after a successful publication and pull.
- The run did not capture sender or receiver RTP statistics. The next focused four-actor media run will record bounded PeerConnection, packet, frame, and track-mute evidence before any recovery policy is added.
- Focused run `shakedown-2026-08-25T18-06-39-442Z-jnpdbx` passes camera replacement for Blake, Casey, Devon, and Avery plus two screen-share cycles. The fault is not deterministic by Participant or replacement count; the next strict run retains bounded RTP diagnostics for a sustained-workload recurrence.

## 2026-08-25 — Stuck replacement is a receiver RTP failure

- Unchanged 300-second run `shakedown-2026-08-25T18-09-23-586Z-el3mru` reproduced only Avery's cycle-4 decoded-frame failure. Avery's active sender remained connected and encoded 359 frames into 1,020 packets; Blake's active connection continued decoding thousands of frames from other Participants but held one live video receiver permanently muted.
- Publication, observation, remote-pull signaling, local camera capture, peer connectivity, and other inbound streams were all healthy. The failure is a negotiated replacement track that never receives RTP, while the client currently treats track arrival as success and advances its publication cursor.
- The client recovery seam is before remote publication commit: a newly pulled track must leave its initial muted state within a short bounded interval. A live track that stays muted will produce a recoverable media failure, which lets the existing Connection lifecycle replace the observer session instead of retaining an unusable publication indefinitely.

## 2026-08-25 — Muted replacement recovery passes the media matrix

- Newly pulled tracks now have two seconds to become live and unmuted before the client commits the publication and cursor. A permanent mute publishes a recoverable media failure and stops the uncommitted tracks; 35 focused media tests and the client typecheck pass on the M4.
- Four-actor focused run `shakedown-2026-08-25T18-22-44-339Z-2ibhqh` passes every microphone, camera replacement, layout, pinning, and screen-share assertion. It remains red only for one Avery page error, `WebSocket is not open.`, emitted during a Sync close/reconnect race after the first camera cycle.
- `V1SyncClient` can retain its live phase until deferred close cleanup runs, while the native browser socket is already closed. A heartbeat or acknowledgement in that window calls the strict browser socket and leaks its throw; the fix belongs at the V1 transport boundary so queued durable work can follow the existing reconnect path.

## 2026-08-25 — Sync send failures enter the existing recovery path

- `V1SyncClient` now catches a transport send failure at its boundary and starts the existing recovery flow. Durable commands remain queued for replay, while ephemeral sends reject without leaking a browser page error; 61 focused V1 tests, the client typecheck, and formatting pass on the M4.
- Focused retry `shakedown-2026-08-25T18-39-49-806Z-0876rc` reached the fourth camera cycle without the prior `WebSocket is not open.` page error, but Avery's replacement still failed remotely. Blake's PeerConnection retained seven video inbound RTP entries and several ended receiver tracks after repeated replacements, so receiver cleanup must be fixed before another strict run.
- The API close-tracks contract cannot close a viewer's remote subscription: it validates the authenticated viewer against the publication owner's connection identity and records an authoritative publication closure. The safe local correction is to retain and stop each received transceiver when its remote publication is replaced, removed, or abandoned after a muted pull.

## 2026-08-25 — Receiver ownership closes the four-cycle media leak

- Each internal remote track now retains its browser receiver transceiver. Authoritative replacement or removal stops the transceiver and track together, and a failed or permanently muted pull cleans both before recovery; the public snapshot type remains unchanged and the API close-tracks contract is untouched.
- Thirty-four focused media tests, the client typecheck, and formatting pass on the M4. The fake PeerConnection proves that remote removal returns to one active local transceiver and that a failed muted pull leaves no active receiver transceiver.
- Four-Participant focused run `shakedown-2026-08-25T18-54-37-517Z-gqwkvn` passes all four camera and microphone replacement cycles plus both screen-share cycles with no workload errors or browser page errors. The only network diagnostics are non-fatal local DNS misses for optional join sounds; a deliberate Sync close during recovery was replayed without leaking the previous `WebSocket is not open.` error.

## 2026-08-26 — Strict workload reaches a pending cycle-three camera command

- Unchanged 300-second run `shakedown-2026-08-25T18-57-22-235Z-o2tiiw` completes five workload cycles but fails one allowed-to-continue assertion: Devon's first camera toggle in cycle 3 does not change the local control state within 15 seconds. The final Devon and Avery screenshots both show Devon's camera still enabled, so this is not the old muted receiver failure or an `aria-pressed` matcher error.
- API events record two Cloudflare `close_tracks` transport failures at 19:00:40Z and 19:00:47Z inside the exact 19:00:32Z–19:00:48Z failed-control window. No Devon browser error occurs, but the current client disable path does not call that endpoint, so the events are correlated but not yet attributed to the command.
- The next focused media run will preserve bounded API and Sync log deltas around every toggle. A repeated close failure during the same control stall confirms provider cleanup pressure; a clean API window with a stuck control moves the diagnosis to Sync live-target completion or the lifecycle command lane.

## 2026-08-26 — Authorized local media work is now bounded

- Attribution run `shakedown-2026-08-25T19-11-59-703Z-eyn2a1` passes all four media cycles and contains no `close_tracks` API event. The earlier close failures are a separate stale-publication sweep that recurs without browser traffic, so their overlap with Devon's stalled click was coincidental.
- `V1SyncClient` previously cleared its 15-second live-target deadline as soon as Sync authorized a target, then waited without a bound for `mediaPlane.setLocalPublicationTarget()`. A hung provider promise could therefore retain the global lifecycle command lane and leave later controls unchanged indefinitely.
- Server authorization and authorized local media work now receive separate 15-second budgets. Local retry backoff measures from the start of local work, a hung promise rejects with `retry_exhausted`, and a late result cannot change the failed V1 state; 63 focused V1 tests, the client type build, and formatting pass on the M4.
- Post-fix four-Participant run `shakedown-2026-08-25T19-25-58-829Z-8wr1de` passes all camera, microphone, and screen-share cycles. The full strict workload is the next proof.

## 2026-08-26 — The full strict feature matrix is green

- Post-fix 300-second run `shakedown-2026-08-25T19-28-32-465Z-u7zztp` passes all five workload cycles and final validation with four Participants. The run covers the sustained camera and microphone replacements, screen share, layouts, pinning, Chat and File, Board collaboration, idle windows, and leave/rejoin path that previously failed.
- Correctness is now a prerequisite rather than an unresolved variable. The remaining measurement sequence is an isolated trace pass, an isolated forced-GC heap-snapshot pass, and the unchanged 30-minute four-Participant runtime profile before baseline comparison.

## 2026-08-26 — Isolated trace and heap passes are green

- Trace run `shakedown-2026-08-25T19-35-00-103Z-mim5kt` passes the one-cycle feature workload and records the targeted camera, reaction, screen-share, Chat-scroll, and Board rendering windows.
- Forced-GC heap run `shakedown-2026-08-25T19-37-37-808Z-nybrs4` passes its one-cycle workload and captures the join, leave/rejoin, and panel baseline/open/closed snapshots outside the CPU measurement process.
- The final measurement is the unchanged 30-minute four-Participant runtime profile with whole-run CPU profiles and five-second process sampling.

## 2026-08-26 — The first long profile hits a transient provider outage

- Runtime profile `profile-2026-08-25T19-41-11-184Z-ktoklr` captures four valid CPU profiles with 99.98% minimum duration parity across 1,828 seconds and completes 27 cycles, but it is not an acceptable final profile because cycle 13 has five media failures and one fatal HTTP 500.
- Blake's microphone disable begins the cascade while Cloudflare `close_tracks` requests time out repeatedly. Camera and screen-share commands then fail during the same provider outage; a forced replacement `create_connection` times out once and produces the public access-refresh 500 at 19:59:27Z.
- Recovery succeeds at 19:59:34Z and all four remote pulls complete at 19:59:36Z, so the session is not permanently lost. The run is red because the outage intersects strict feature actions, not because CPU-profile coverage is incomplete.
- The outage also exposes a harness cleanup defect: after Blake activates screen share, a failed remote visibility assertion skips the stop action, which creates the misleading later `screen share stayed active after stop` failure. Cleanup will move into a primary-error-preserving `finally` before the long profile is retried.

## 2026-08-26 — Screen-share failure cleanup is bounded

- Screen-share visibility and zoom failures now stop an activated share in cleanup while preserving the primary assertion or trace error. A cleanup failure is aggregated with that primary error, and cleanup stays outside the measured trace boundary.
- The first focused media health run exposed a return-contract regression in the cleanup wrapper: a successful unrecorded trace normally returns `undefined`, which skipped the successful stop step and left the first share active. The wrapper now returns an explicit success marker; the production-shaped regression and all 30 pure harness tests pass.
- A second health run did not reach media because the hours-old isolated stack returned `coordinator_unavailable` during the anchor Sync hello despite green readiness endpoints. The performance PostgreSQL database was recreated, the isolated Redis database was flushed, and a fresh M4 stack restart is in progress. Raw run artifacts remain unchanged.

## 2026-08-26 — The clean long profile exposes premature publication reconciliation

- Runtime profile `profile-2026-08-25T20-36-51-352Z-v2dwjt` captures four valid CPU profiles with 99.99% minimum duration parity across 1,811 seconds, but it is red because current camera, microphone, and screen-share references intermittently return `track_not_found` during rapid media replacement.
- The API recorded 60 provider misses in seven clusters. Each reference was still the latest enabled publication, each publisher PeerConnection was connected and sending RTP, and the API had no transport, timeout, or HTTP failure, so this is not the earlier provider outage, a stale viewer cursor, or a receiver leak.
- Chalk currently converts repeated provider absence into an authoritative publication closure after an eight-second grace. The failed clusters reached that threshold at roughly 10–12 seconds, so Chalk removed the current registry entries before delayed provider visibility could recover. The next proof extends only this bounded grace, preserves the observation-count and spacing requirements, and runs real four-Participant churn before another long profile.
- The bounded grace is now 15 seconds; the three-observation and two-second spacing requirements are unchanged. Focused API tests prove no closure through 12 seconds and closure at 16 seconds, while presence still resets the evidence.
- Four-Participant media run `shakedown-2026-08-25T21-41-42-507Z-8m7noz` passes all four camera and microphone replacement cycles plus both screen-share cycles. It encountered two real partial `track_not_found` responses, recovered both, and recorded no confirmed publication absence, which validates the intended transient-recovery path before the unchanged strict matrix.
- Unchanged 300-second run `shakedown-2026-08-25T21-44-33-351Z-aqdzqp` passes five full workload cycles with four valid CPU profiles and no failed reachable steps. Its API window contains no `track_not_found`, confirmed publication absence, or HTTP failure, so the final 30-minute profile can start from a newly isolated database.

## 2026-08-26 — The completed long workload exposes an optional-sound classifier gap

- Runtime profile `profile-2026-08-25T21-55-55-867Z-tdhg99` completes 24 workload cycles with no reachable step failure and four valid CPU profiles covering 1,861.5–1,861.8 seconds at 99.98% duration parity. It still exits red because three teardown requests for the optional external `leave.<hash>.opus` asset fail local DNS and the harness only exempted the equivalent join sound.
- The API window has 19 transient `track_not_found` responses, one startup confirmed-absence event, no provider transport failure, and no HTTP 4xx/5xx. The startup closure recovers before the feature cycles; later transient misses also recover without a reachable assertion failure.
- The diagnostic classifier now recognizes only exact Chalk UI join and leave media URLs while unrelated media failures remain fatal. All 31 harness tests and formatting pass on the M4, and focused leave/re-entry run `shakedown-2026-08-25T22-30-54-357Z-nks73g` is green. A fresh long rerun will produce the final durable manifest instead of reinterpreting the red artifact.

## 2026-08-26 — The final long profile is green

- Clean runtime profile `profile-2026-08-25T22-32-32-712Z-uz58x1` passes 24 workload cycles over 1,853.145 seconds with no reachable failure or fatal browser diagnostic. All four CPU profiles are valid with 99.99% duration parity; 1,496 samples have no metric error and at most 7 ms drift.
- The exact API window contains 36 transient `track_not_found` responses, no confirmed publication closure, no provider transport or timeout failure, and no HTTP 4xx/5xx. Partial pulls and bounded backoff recover every miss without breaking a feature cycle.
- The final report records the central caveat: normalized rendering traces fall sharply and the full feature matrix is green, but aggregate Chromium CPU is higher than the media-broken baseline and is not a like-for-like reduction claim. A future whole-run CPU target needs a green comparison baseline.

## 2026-08-26 — Visible dogfood passes with one browser limitation

- Helium verified entrance, two-Participant presence, camera and microphone controls, grid, hand and reaction signals, chat text and attachment delivery, Board collaboration, leave, and visible re-entry. Screen share remains unproved in this pass because Helium reported that capture was unavailable; the automated four-Participant workload still passed all 24 screen-share cycles.
- The visible pass also saw a roughly 20-second initial hydration delay, one brief reconnect state after a device toggle, one media-publication HTTP 403, and one transient access-grant `ERR_EMPTY_RESPONSE`. The flow recovered without a runtime exception.
- The durable recording is a validated 50-second screenshot-state MP4 because macOS live capture failed. It is shared read-only at `https://drive.google.com/file/d/1BPf8tjSGrkkSizmY8bhAz1ckowHTrVRY/view?usp=sharing`; the source remains untracked under `.private/chalk-perf/recordings/`, and durable screenshots remain under `scratchpad/screenshots/perf-space-profile/`.

## 2026-08-26 — The remote gate mirror is valid, but vocabulary still blocks the gate

- The first canonical-gate attempt failed before project checks because the disposable remote mirror had an empty Git index. Smart-gate discovered no workspaces and returned exit 2 instead of the synthetic task exit; the production smart-gate source and its test were unchanged.
- A current-tree snapshot now gives the disposable mirror 4,278 tracked files. All 34 smart-gate tests pass there, which proves the environment correction without weakening gate planning.
- The canonical gate now reaches the language ratchet and fails on `session`: 142 occurrences above the API baseline and 58 above the TypeScript client baseline. The API and Sync gates have not run yet; the exact branch contribution is under diagnosis before any vocabulary change.

## 2026-08-26 — Vocabulary and cross-gate database isolation are corrected

- Chalk-owned media failure terminology now uses `connection_retired`, and the new remote-track identity uses `ConnectionID`. Cloudflare `sessionId`, `/sessions`, and session-description fields remain unchanged only at explicit provider seams. The ratchet excludes those exact adapter paths, its tests pass, and the baseline tightens by 76 API occurrences and 46 TypeScript client occurrences.
- The first substantive full gate reached 419 of 420 passing Sync correctness tests. The failed global claim test received a pending maximum-duration operation left by the preceding API integration test: that test registered `defer pool.Close()` before `t.Cleanup(cleanup)`, so its cleanup tried to use a closed pool and silently left database work behind.
- The API test now registers pool closure as an earlier `t.Cleanup`, which makes the later row cleanup execute first. The exact API-then-Sync sequence that previously reproduced 19 of 20 passing tests now passes all 20 in one freshly migrated PostgreSQL database; the full canonical gate rerun remains in progress.
- The five retained local run directories match the remote evidence byte for byte. This includes 3,129,684,489 bytes in the forced-GC run plus both long profiles, the trace run, and the focused leave/re-entry run.

## 2026-08-26 — Review and full-gate failures close real retry and test-lifecycle gaps

- The required timed `codex review` completed in 11m29.7s with exit 0 and one P1 finding. Token accounting was unavailable because the wrapper reported `expected_one_new_review_rollout found=0`; the earlier raw CLI attempt was stopped without a verdict after it exposed that the repository requires the timed Terra/xhigh wrapper.
- The finding was real: after releasing the old public arrival, a transient re-entry failure left the client pointing at that released arrival, so Try again repeated a non-idempotent leave and never reached the new arrival request. Prepared public access now remembers a released current arrival, retries re-entry without leaving it twice, resets the state after success, and skips duplicate cleanup. The focused re-entry and Episode-end route tests pass 12 of 12.
- A client diagnostics integration test relied on unrelated suite activity to run a zero-delay export before disposal cancelled it. The test now waits for the scheduled fetch before disposal and passes 10 consecutive focused runs.
- A stale route test invoked `onLeft` even though the current embedding deliberately cleans public access on `onEpisodeEnded`; component tests already enforce ordinary leave as re-entry-safe. The route test now asserts the Episode-end contract. The final full canonical gate and the dedicated API and Sync gates are in progress on the exact corrected tree.

## 2026-08-26 — The packaged whiteboard owns a self-contained stylesheet

- The full gate's packaged SDK consumer exposed that `@excalidraw/excalidraw/index.css` is exported only under Excalidraw's `development` and `production` conditions. App-local builds activated one of those conditions, but a standard esbuild consumer did not, so the published whiteboard React entry was unusable.
- The whiteboard build now copies Excalidraw's production stylesheet into `dist/react/index.css`, inlines the four Assistant font files as data URLs, imports the stylesheet relatively, exports the conventional `./styles.css` path, declares the CSS side effect, and publishes the Excalidraw MIT notice. It keeps source development styles and declaration-import stripping at their existing seams.
- The remote package passes 36 unit tests, two declaration proofs, three CSS artifact proofs, a production build, and the unchanged packaged Chromium consumer. The final full canonical gate plus dedicated API and Sync gates will run on this exact artifact change.

## 2026-08-26 — Final gates are green

- `pnpm run gate -- --full` passes on the M4 against the complete final tree. Its log is `/tmp/chalk-perf-canonical-full-gate-complete.1Dg8Jz` on `agents-macmini`.
- `apps/api/scripts/gate.sh` passes independently; its log is `/tmp/chalk-perf-api-gate-complete.NAFqdC`.
- The direct Sync gate correctly refused to run without `CHALK_SYNC_TEST_DATABASE_URL`. Running the same `apps/sync/scripts/gate.sh` through `apps/sync/scripts/with-reliability-postgres` provisions a migrated disposable database and passes all 420 tests with four intentional exclusions; its log is `/tmp/chalk-perf-sync-gate-with-postgres.WmtDYa`.
- No production environment was touched. The original handoff remains preserved and untracked because this chronological log and the final report now own the completed public record.
