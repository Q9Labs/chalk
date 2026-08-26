# Web app perf profiling harness — session log 2026-08-23

Goal: profile apps/web + packages for memory/CPU/GPU inefficiencies across the
whole meeting experience; harness first, report before fixes.

Worktree: `.worktrees/perf-profile` (branch `perf/profile-meeting`).

## Environment findings

- `pnpm dev` (supervised stack) is broken on HEAD: `scripts/dev/chalk.mjs`
  `discoverBrokerRuntime` requires an untracked broker `wrangler.toml`, but the
  broker Worker sources were deleted from the repo in dc8f4a7a (2026-08-20).
  The web app itself no longer needs a Worker broker — access grants come from
  the API directly (`apps/web/src/lib/chalk-access.ts`), and vite proxies
  `/v1` to the local API.
- Workaround: `scratchpad/perf-harness/dev-stack.mjs` starts only what the
  meeting needs: postgres/redis containers, goose migrations, Go API
  (+ provider bridge, mTLS material mirrored from chalk-resources.mjs),
  Elixir sync, Vite web. Ports: api 18080, sync 4100, web 13070.
  SFU creds resolve from 1Password ("Cloudflare Realtime SFU chalk-local-dev").
- Join flow needs no login: open `/space?name=<n>`, app creates a public Space,
  address bar becomes `/space/<slug>#spaceInviteToken=cspi1.…`; replay that URL
  for other participants (pattern from scripts/dev/media-smoke-runner.mjs).

## Harness

- `scratchpad/perf-harness/dev-stack.mjs` — local stack orchestrator.
- `scratchpad/perf-harness/collectors.mjs` — CDP: 5s page metrics
  (nodes/listeners/documents/heaps/layout+style counts + durations), sampling
  CPU profiles (5ms whole-run on P1, 1ms windows on P2), streamed heap
  snapshots + structural summaries (top constructors by self size), windowed
  devtools.timeline traces (Paint/CompositeLayers/ImageDecode/Raster counts).
- `scratchpad/perf-harness/scenario.mjs` — feature steps from the real
  selector catalog (entrance → toolbar toggles → panels → chat/upload →
  layouts → reactions → screen share → whiteboard draw/pan/zoom → leave).
- `scratchpad/perf-harness/run.mjs` — orchestration; outputs under
  `.private/chalk-perf/runs/<ts>/`.

## Progress

- [x] Worktree created; deps installed.
- [x] Feature map (explore agent) + static anti-pattern scan (explore agent).
- [ ] Local stack up on alternate ports (broker requirement bypassed).
- [ ] Harness shakedown run (2–3 min).
- [ ] Full 30–45 min profiling run.
- [ ] Prioritized findings report with numbers.
- [ ] Fix top items one at a time + before/after verification.

## Static scan highlights (to be confirmed by runtime numbers)

1. Chat scroll handler N+1 getBoundingClientRect per scroll event
   (chat-panel-model.ts:35-43) — high for long chats.
2. Stage.tsx frameStyle fresh objects/closures defeat ParticipantTile memo
   (:162-170) — re-render storm during speaker flips.
3. `.chalk-voice-halo` infinite box-shadow animation, non-composited, per
   speaking tile (packages/ui/src/styles/index.css:1432) — GPU/paint cost.
4. Chat list not virtualized (DOM grows with loaded window).
5. AudioOutput arrays recreated each render → 3 effects rebuild every render.
6. media/client.ts remote-publication poll ignores tab visibility.

## 18:44 shakedown completed

- A four-Participant, three-minute run completed and produced 239 metric rows,
  nine heap snapshots, one whole-run CPU profile, five timeline traces, and a
  terminal run manifest.
- The run was not a valid baseline. Four of 90 feature steps failed:
  whiteboard draw and pan/zoom never reached Excalidraw, the second-round
  Presentation selection did not resolve, and the attachment composer was
  disabled when the harness tried to send.
- The live whiteboard probe found the cause of the first failure: the floating
  controls must be revealed with a real pointer move. Clicking the visible
  Board control opened Excalidraw within two seconds and exposed two canvases.
  The old helper dispatched a click to a zero-size duplicate control.
- The existing harness also treats clicks as success without proving their
  state changes, lets asynchronous samplers overlap, and has no fatal cleanup
  path. Its output is useful shakedown evidence only.

## 18:48 environment and harness decision

- The Chrome plugin could not connect to Helium because its browser bridge
  rejected the available automation service as untrusted. The required
  Playwright harness remains usable; the final visible Helium pass is still
  unproved.
- The canonical `pnpm dev` path is still broken after the unified public-invite
  change: `scripts/dev/chalk.mjs` requires a local broker config that the same
  change deleted. The temporary supervisor is sufficient for instrumentation
  work but does not satisfy the final canonical-stack requirement.
- The durable harness will live under
  `scripts/performance/space-experience/`. It will require real visible actions,
  state assertions, serialized sampling, paired heap diffs, synchronized trace
  windows, a terminal manifest, and run-to-run comparison before any product
  performance change is made.

## 00:15 corrected pre-fix runtime and trace baseline

- Measurement moved to the isolated M4 test Mac using the frozen pre-fix product
  revision `bde30e42` plus the validated harness. The clean fix branch is
  `perf/space-profile-fixes-20260823`; it does not contain the unrelated combined
  product change from the first worktree.
- The 30-minute workload completed 26 full cycles and 32.3 minutes of CPU
  coverage. All four Participant profiles are valid at 1,944.5–1,944.9 seconds
  with 99.98% duration parity. The sampler recorded 1,565 live Participant
  samples at five-second cadence with 5 ms maximum shared drift.
- The shared host averaged 5.515 load on 10 logical CPUs and peaked at 12.269,
  so browser-process CPU is shape evidence, not a clean machine-wide comparison.
  Aggregate renderer CPU averaged 44.799%, the GPU process 22.703%, the browser
  process 2.407%, and the browser audio service 6.281%.
- Remote media reconciliation is the dominant correctness and load failure:
  browser diagnostics captured 2,898 HTTP 503 responses and five HTTP 500
  responses. Nineteen of 26 microphone cycles failed; camera disable, screen
  share visibility, and screen-share zoom/pan also failed.
- Other confirmed coverage failures are native `File` attachment staging and
  re-entry after leave. Board activation exceeded 120 seconds; its control also
  remained `aria-pressed="false"` because the Space views do not pass the open
  state into either ControlBar.
- Long-run endpoint counters grew most on the two chat-active pages. Avery added
  62,437 DOM nodes and 68.5 MB used heap; Blake added 48,570 nodes and 159.8 MB.
  Casey and Devon added only 518 and 956 nodes. These are not leak findings until
  the forced-GC heap pass distinguishes live chat UI from retained detached DOM.
- Full CPU profiles identify per-message `Intl.DateTimeFormat` construction as
  the largest application frame on the chat-active pages: 2.187 seconds self
  time for Avery and 1.322 seconds for Blake.
- The isolated trace pass captured seven feature windows with hardware Metal
  compositing. Relative to idle, chat scrolling raised Layout events from 3.335
  to 5.977 and Paint events from 8.941 to 12.702 per Participant-second;
  reaction animation raised Paint to 12.249 and RasterTask to 9.569.
- The forced-GC snapshot pass is running. The numbered pre-fix report remains
  blocked only on those heap diffs; no product fix has started.

## 00:21 forced-GC evidence and numbered pre-fix report complete

- The snapshot pass produced 20 forced-GC snapshots and 17 paired diffs. No
  class name containing `detached` appears in any diff. Panel close operations
  released nearly all panel Fibers and DOM; React development
  `PerformanceMeasure` entries dominate the retained chat delta.
- The apparent 25.3 MB leave delta is late Excalidraw development-module,
  source-map, font, and compiled-code loading. It is not evidence that departed
  Participant media remained reachable.
- A frozen production build measured a 993.97 kB raw, 254.54 kB gzip Space
  route. Board remains deferred, with a 1,106.91 kB raw main dependency and a
  1,821.04 kB raw supporting chunk.
- All three raw pre-fix runs are now retained under
  `.private/chalk-perf/runs/`. Durable screenshots cover the remote-media,
  re-entry, and late Board states under `scratchpad/screenshots/perf-space-profile/`.
- `findings-report-2026-08-23.md` now contains the corrected numbered record.
  The obsolete permissive harness files were removed; the validated harness
  under `scripts/performance/space-experience/` is the only measurement path.

## 00:49 first SFU correction and publication-registry failure path

- The first correction now matches Cloudflare remote-track responses to the
  requested publication by `(sessionId, trackName)` instead of array position.
  It rejects missing, duplicate, unexpected, or wrong-kind responses and stops
  any received tracks when validation fails.
- The focused client typecheck passed, and all 26 focused Cloudflare SFU tests
  passed, including reversed, missing, duplicate, and wrong-kind response
  cases.
- Strict run `shakedown-2026-08-23T19-27-31-212Z-2el4fz` proved that identity
  matching is safe but does not stop the provider failure path. Microphone,
  camera, and screen-share assertions still failed while `/media/sfu/tracks`
  returned 503 responses before a usable response reached the client.
- The disable path has a separate registry-consistency gap. A successful
  provider close followed by an ambiguous registry write was treated as a
  terminal Sync result, so the V1 client did not retry and did not retire its
  sender. Sync now maps an ambiguous revoke result to retryable dependency
  unavailability while preserving the operation ID for idempotent retry.
- The focused Sync regression passed all six Episode tests. The corrected Sync
  process is healthy in the isolated M4 runtime, and a strict four-Participant
  rerun is in progress against that single additional correction.

## 00:53 bounded retry and native attachment corrections prepared

- Remote pull failures now back off by 2, 4, 8, and 16 times the healthy poll
  interval for one unchanged validated publication cursor. Success, restart,
  or a changed cursor resets the progression. Healthy polling keeps its
  configured cadence.
- The client typecheck passed and all 29 focused Cloudflare SFU tests passed,
  including capped backoff and reset cases. This limits provider pressure; it
  does not repair an already stale publication registry entry.
- Both React chat panels now share one upload-file discriminator. It checks the
  browser/raw `arrayBuffer` shape before the SDK byte-input shape, so modern
  inherited `Blob.bytes()` no longer masquerades as an `ArrayBuffer` field.
- The focused ChatPanel suite passed all four tests, including a browser `File`
  that exposes `bytes()`, and the React package typecheck passed.
- Neither of these two corrections has been copied into the remote fix runtime
  yet. The active browser run contains only response identity and ambiguous
  revoke handling, which preserves the one-change rerun contract.

## 00:55 ambiguous-revoke runtime result

- Strict run `shakedown-2026-08-23T19-48-18-622Z-zp2487` failed with 871 HTTP
  503 responses: Avery 232, Blake 178, Casey 230, and Devon 231. Camera initial
  playback, screen share, attachment staging, Board, and re-entry also failed.
- Microphone passed in this run, unlike the identity-only rerun, but one
  nondeterministic provider run is not enough to attribute that change to
  ambiguous-revoke retry.
- The result confirms that ambiguous revoke is a real registry consistency fix
  but is not the common stale-reference path behind the remote-pull storm. The
  raw terminal run has been copied to the local private evidence directory.
- Bounded client retry is now the only additional web correction in the remote
  fix source, and its strict four-Participant rerun is in progress.

## 01:09 Board state correction prepared

- Both Space skins now pass `whiteboard.isOpen` into both responsive ControlBar
  surfaces. The public ControlBar props expose that state, and the existing
  surface already projects it to `aria-pressed` and active styling.
- The combined focused React run passed 23 ChatPanel and SpaceView tests. The
  React package typecheck and `git diff --check` also passed.
- This correction is local only. It must be deployed and measured after the
  native attachment correction so each browser result still has one new cause.

## 01:11 re-entry ownership correction prepared

- Ordinary leave now calls only `client.leave()`. It retains the client and
  prepared arrival access so the visible `Try again` action can refresh access
  and call `join()` on a usable client.
- Episode end and real page unmount still use the full release path: leave,
  dispose, and prepared-arrival finish. Pagehide keepalive cleanup is unchanged.
- The focused SpacePage suite passed all 12 tests, including the ordinary-leave
  ownership split and Episode-end cleanup. The web package typecheck and
  `git diff --check` passed.
- This correction is local only and still needs its own strict browser rerun.

## 01:13 bounded retry runtime result

- Strict run `shakedown-2026-08-23T20-06-02-948Z-n12b9p` reduced HTTP 503
  responses from 871 to 90, an 89.7% reduction. Avery emitted 23, Blake 22,
  Casey 23, and Devon 22.
- The long-lived failing Participants settled near one request every 16.6
  seconds, matching the 16-times cap. Blake's shorter active window averaged
  12.9 seconds because leave ended its retry series earlier.
- Microphone, camera, and screen share still failed. The result proves bounded
  provider pressure but does not repair the stale publication registry.
- The raw terminal run is copied locally. The native attachment correction is
  now the only additional change in the remote fix source, and its strict rerun
  is in progress.

## 01:16 re-entry callback ownership refined

- Chalk's Space surface already owns the leave command and calls
  `client.leave()`. Its public `onLeft` prop is an event callback after the
  connection becomes left, so an app callback that calls `leave()` would repeat
  the command.
- SpacePage now omits `onLeft` entirely. It keeps terminal cleanup only on
  Episode end, pagehide, and real unmount. The supplied client therefore stays
  reusable for the visible retry action.
- The refined proof passes 12 SpacePage tests, 30 React binding tests, and both
  package typechecks. The binding regression crosses live to left, clicks
  `Try again`, observes a new `join()`, and proves no disposal.

## 01:24 native File boundary split confirmed

- Strict run `shakedown-2026-08-23T20-13-06-313Z-nl9zrx` proved that the React
  panel correction stages a native browser `File`, but the attachment remained
  visible for the full 15-second completion assertion and did not send.
- The SDK chat controller and controller effects had the same inherited
  `Blob.bytes()` ambiguity. Both now select a native file by `arrayBuffer`
  before reading the SDK byte-input field.
- Six focused SDK tests pass with a browser-file subclass whose `bytes()` is a
  prototype method. The client typecheck and `git diff --check` pass. The full
  two-boundary correction is deployed to the isolated remote web source and
  its strict four-Participant rerun is in progress.

## 01:30 native File rerun reaches storage boundary

- Strict run `shakedown-2026-08-23T20-21-39-081Z-yny8xk` still kept the
  attachment staged through the 15-second completion assertion.
- The API log recorded `chat_attachment` initiation as succeeded at the same
  timestamp, so the React and SDK native-File corrections are both executing.
  No attachment finalize followed. The remaining failure is between the
  presigned storage PUT and finalize, not another proven File-shape branch.
- Browser diagnostics showed no non-media HTTP error. The isolated RustFS
  listener and container were live, and the stack launcher had configured the
  web origin. Capture the composer error or PUT network exchange before
  assigning the cause to CORS or changing storage product code.
- The raw terminal run is copied locally. The already-tested re-entry ownership
  correction is now the only additional change in the remote fix source, and
  its strict rerun is in progress.

## 01:36 re-entry ownership hypothesis falsified at runtime

- Strict run `shakedown-2026-08-23T20-29-34-442Z-m0teud` passed remote leave,
  but visible `Try again` still failed to restore the video grid within 90
  seconds.
- Removing the app's `onLeft` callback is unit-tested and preserves a supplied
  client in the binding test, but it is not a sufficient runtime repair. The
  next pass must observe real client status, prepared-arrival access, and route
  state across leave before extending that hypothesis.
- The raw terminal run is copied locally. The Board correction did not receive
  a strict browser rerun before the requested stop boundary.

## 01:37 runtime stopped for handoff

- Exact listener owners and working directories were verified before cleanup.
  Fix Vite, detached Sync, the API supervisor, and their owned children stopped.
- Ports 13070, 4100, 18080, and 19000 are closed. The two uniquely named
  profiling PostgreSQL and Redis containers are stopped with volumes retained.
  The supervisor removed its owned ephemeral RustFS container and volume.
- No local or remote profiler Chromium, harness, test, or build process remains.
  The remote source trees and every terminal run remain available for the next
  agent.

## 01:40 original-objective completion audit added

- Re-read the original pasted objective rather than treating the partial
  handoff as the success definition.
- The durable handoff now maps every explicit profiling deliverable to its
  authoritative artifact and states whether it is complete, contradicted, or
  still missing.
- The audit confirms that pre-fix exploration, harness construction, long-run
  sampling, CPU profiles, heap snapshots, traces, static review, and the
  numbered report are complete. Reachable feature correctness, measured
  performance fixes, post-fix comparisons, dogfood, the full gate, release
  notes, and commit remain incomplete.

## 01:41 attachment failure diagnostics hardened

- The strict upload scenario now races successful attachment clearing against
  the visible composer alert. A storage or finalize failure will report the
  actual user-facing message instead of only timing out because the attachment
  remains staged.
- A pure regression covers both successful attachment clearing and propagation
  of the trimmed composer error. `node --check`, all 20 pure harness tests, and
  `git diff --check` pass. The
  isolated runtime remains stopped, so the next agent must restart it for the
  browser proof.

## 01:43 re-entry access seam narrowed

- Read-only tracing shows that lifecycle Leave clears cached access correctly,
  so the failed retry is not explained by stale client-side grant reuse.
- The public adapter then refreshes the same arrival, and the API refresh path
  finds the same Participant generation and resumes the same provider subject.
  It does not create a new arrival/generation after durable Leave.
- This is a causal lead, not runtime proof. The next narrow probe must preserve
  the public refresh response and client join trace before choosing between a
  fresh-arrival app contract and explicit API reactivation.
