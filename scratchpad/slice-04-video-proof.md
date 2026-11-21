# Slice 4 (Video) proof log

Branch `obs/slice-04-video`, head 83f7e9fa0b (before proof-log commit). Foundation `origin/obs/foundation-int`.

Every check below has a committed positive and healthy fixture judged by the real proof kernel
(`scripts/diagnose-call/proof/rows.mjs` `judgeFixture` → verdict → `ruleResult`): each positive
yields exactly one finding with the expected code/hop, each healthy yields none with
`checked=1, eligible=1`, and `dropped` is empty — no row is silently ignored.

## Check table

| check | fault | finding (hop) | proof file |
|---|---|---|---|
| video.camera_wont_start | getUserMedia rejects with NotFoundError; camera machine ends `ended`, never `live`+bound | broken @ client_capture | `observability/fixtures/video.camera_wont_start/positive.json` |
| video.camera_stopped | live+bound camera track ends with trigger `track_ended`, no deliberate cause | broken @ client_capture | `observability/fixtures/video.camera_stopped/positive.json` |
| video.not_published | camera live+bound, encoder emits frames, SFU never registers the camera publication; ingress sits at 0 | broken @ publisher_uplink | `observability/fixtures/video.not_published/positive.json` |
| video.not_shown | camera subscription exists; SFU forwarded_packets stays at 0 while publisher ingress flows; tile stays avatar | broken @ sfu_forward | `observability/fixtures/video.not_shown/positive.json` |
| video.frozen | forwarded+decoded counters flow; on-screen tile presented_frames flat ≥8 s | broken @ client_render | `observability/fixtures/video.frozen/positive.json` |
| video.low_quality | picture shows at ~80 kbps sustained under plan=lowest; downlink congestion mark + transport drops | degraded @ sfu_forward | `observability/fixtures/video.low_quality/positive.json` |

Healthy controls: same files under `healthy.json` — all six produce no finding.

## Chain (hops)

- **(a) client** `sdks/typescript/client/src/space-client/media-controller.fault.test.ts` — real space
  client + MediaController + kernel + TelemetryOutbox on a fixed clock; camera capture/transition/
  bound/muted/permission rows.
- **(a) client stats** `sdks/typescript/client/src/media/client.fault.test.ts` — real
  `createCallStatsCollector` on scripted getStats reports → `video.send_window`,
  `video.track_window`, `video.call_stats`, `video.stats_failed`.
- **(a) render** `sdks/typescript/react/src/components/participant-tile/ParticipantTile.fault.test.tsx`
  — real `useVideoRenderProbe` on a pinned video element → `video.render_probe`, `video.tile`.
- **(sfu)** `features/media/sfu/internal/media/video_chain_test.go` — drives the real trail emitters
  (`s.trail`, `n.trail`, `subscriptionAttrs`, `traceSubscriptionStarted/Pause/Select/Stopped`,
  `tracePublicationStarted`) with pinned counters and captures exported journal records.
- **(s) sync** `apps/sync/test/chalk_sync/obs_video_chain_test.exs` — real Sync + real Postgres:
  `sync.media.intent` and `sync.episode.ended` rows (camera symptoms + not_published).
- **(b) assembly** `scripts/diagnose-call/proof/video-camera-chain.test.mjs` and
  `video-media-chain.test.mjs` — stamp each hop's rows into ledger shape, merge, judge.

Per-symptom hop manifests: `observability/fixtures/video.<code>/chain/hops.json`.

## Verification results (this run)

- `node --test scripts/diagnose-call/proof/video-camera-chain.test.mjs video-media-chain.test.mjs`
  → 12/12 pass (8 positive findings, 4 healthy passes … per table).
- `node scripts/gates/obs-coverage.mjs` → 7 symptoms covered end to end, incl. all 6 video;
  `video.frozen` removed from coverage-allowlist (gate demanded it).
- `pnpm run check:generated` → passed (14 checks).
- `CHALK_CHAIN_WRITE=1` reruns of every hop reproduce the committed rows byte-for-byte
  (each hop test asserts equality against the committed file).
- `mix test test/chalk_sync/obs_video_chain_test.exs` on isolated Postgres → passed earlier this
  session (1 test; real rows landed in `chain/sync-rows.json`).
- `go test ./internal/media -run TestVideoChainFixtures` → pass; vitest hops → 8+6 pass, no type errors.

## Honest-limitation notes

- SFU counter values are pinned in the Go test (real emitters + real export path; the
  translator/lease state behind `sub.state()` is not driven end-to-end — flagged here, not hidden).
- `video.stats_failed` is emitted through the real kernel in the stats hop; the emit site itself
  (`media/client.ts` adapt-loop catch) isn't driven by a live failing getStats — noted, not faked.
- `video.render_probe` `probe_unavailable` is declared on the event but excluded from the fact's
  coverage fields because any native-unavailable row in a positive fixture would (correctly) make
  the rule `unknown`; RN emits it, the rule reads it, the positive path can't contain it.
- `video.call_stats` `gap`/`gap_ms` were dropped from the `video.call_window` fact field list for
  the same reason: gap rows can't carry `recv_hidden_videos`, which `video.viewer_pause` claims —
  they'd be dropped as unplaceable.
- `video.connection` fact was removed (no client.connection machine rows exist yet; slice 2 owns
  them). All rules treat it as absent — no health inference from missing evidence.
- Native (RN) tile reports `probe_unavailable: "native_render"` rather than fabricating DOM metrics.

## Still unproved

- Real end-to-end Postgres relay path for SFU trail rows (journal → relay → ledger): the Go hop
  proves the emit+export boundary; the relay ingest leg itself is exercised only through the
  assembly's stamped rows.
- `video.camera_wont_start`/`camera_stopped` reconnect-recovery variants beyond the fixture runs.
