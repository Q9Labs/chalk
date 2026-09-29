# Lane B: measure where media toggle time goes, locally first

You are working in the Chalk repository at /Users/macmini/code/chalk. Chalk is a real-time collaboration product. Read AGENTS.md and GLOSSARY.md first and use the glossary vocabulary in your report.

## Why this work exists

In the production web app (https://chalkmeet.com, servers in AWS us-east-1), turning the microphone or camera on or off takes more than one second for a user in Karachi, Pakistan. The product target is under 100ms p95 for state signals such as mute. We need to know where the time goes before we change anything. This lane builds a repeatable measurement and runs it against the local development stack. It does not fix anything.

The local stack is a useful first split: Sync, the API, and Postgres run on this Mac (near-zero network distance), while the local development configuration still uses a real Cloudflare Realtime SFU app. So a slow local toggle points at client, Sync, or Cloudflare work; a fast local toggle points at network distance or production topology.

## Background you need

The web toggle is implemented in `sdks/typescript/client/src/space-client/media-controller.ts` (`#set`, around line 216). In order, it captures a device track if none is held (getUserMedia), calls `ports.sync.setMicrophoneEnabled` / `setCameraEnabled` (a Sync v1 command over WebSocket, see `sdks/typescript/client/src/sync/v1-client.ts`), and then records diagnostic phases `local_track_state`, `sync_commit`, and `sfu_publication`. Do not assume those phase names are accurate; check what each one really marks.

The owner considers the existing performance tooling (`scripts/performance/space-experience/`, `scratchpad/perf-harness/`) out of date and not robust. You may reuse pieces, but do not trust them without checking.

## Task

1. Start the local stack with `pnpm dev` (see `scripts/dev/`, `pnpm dev:status`, `pnpm dev:logs`). It resolves local Cloudflare credentials through 1Password; if that fails, report the exact error and stop.
2. Build a measurement script with Playwright and real headless Chromium using fake media devices (`--use-fake-ui-for-media-stream`, `--use-fake-device-for-media-stream`). Two Participants join one Space. Participant A toggles the microphone and the camera, on and off, at least 30 times each, with a pause between toggles.
3. For every toggle, record wall-clock timestamps for each stage, so the total splits into parts:
   - button press (or SDK call start);
   - getUserMedia start and resolve, when it happens;
   - Sync command frame sent and Sync reply received (instrument the WebSocket from the page, for example by wrapping WebSocket in an init script);
   - WebRTC state changes on A's RTCPeerConnection (renegotiation start and end, track sender changes; use `getStats` or connection events);
   - the UI showing the new state on A's screen;
   - the new state visible on B's screen, both in the UI and in B's Sync frames;
   - on enable, when B's remote track first receives media (inbound-rtp bytes or frames start increasing).
     Also capture Sync and API server-side timing from logs or OTLP if it is cheap to get; skip it if not.
4. Report p50, p95, and max for each stage and for the total, separately for microphone enable, microphone disable, camera enable, and camera disable. Say which stage dominates.

## Constraints

- Put every file you create under /Users/macmini/code/chalk/scratchpad/sync-hardening-2026-09-27/lane-b/. Do not edit, create, or delete any tracked file. Do not commit, push, stash, reset, or create branches. Other agents are working in this repository.
- Another lane may run Sync tests with its own containers named `*lane-a-20260927*`. Do not touch those.
- Do not touch production, AWS, PlanetScale, DigitalOcean, or any deployed service. Only the local stack and the local development Cloudflare app are in scope. Do not print or save secrets.
- Stop the local stack with `pnpm dev:stop` when you finish, unless it was already running before you started; in that case leave it running and say so.

## Done

Write the report to /Users/macmini/code/chalk/scratchpad/sync-hardening-2026-09-27/lane-b-report.md with: 1) what you measured and how, with the exact command to rerun it, 2) a stage-by-stage latency table per toggle type, 3) which stage dominates and why, with the evidence, 4) what the diagnostic phase names really mark, 5) anything that failed or that you could not measure. Keep raw per-toggle data as JSON in lane-b/. Separate measured facts from inferences. Write the report file last; its existence signals completion.
