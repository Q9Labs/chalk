# Lane A: map the Sync and media control path, and audit the existing reliability tools

You are working in the Chalk repository at /Users/macmini/code/chalk. Chalk is a real-time collaboration product. Read AGENTS.md and GLOSSARY.md first and use the glossary vocabulary in your report.

## Why this work exists

The owner does not trust Sync correctness, durability, or speed. In the production web app, turning the microphone or camera on or off takes more than one second. The product target (theory.md, "Performance budget") is under 100ms p95 for state signals such as mute. We do not yet know whether the time goes to device capture, the Sync server, Postgres, the API provider bridge, Cloudflare SFU, or WebRTC. This lane produces the map and the tool audit. It does not fix anything.

## Task 1: trace the media toggle path end to end

Trace what happens, in order, from the moment a web user presses the microphone button until the UI shows the new state, for both enable and disable, and for camera too. Start at `sdks/typescript/client/src/space-client/media-controller.ts` (`#set`, around line 216) and follow the call through `sdks/typescript/client/src/sync/v1-client.ts` (`setMicrophoneEnabled`, `#sendLiveTarget`), over the WebSocket into `apps/sync` (Elixir), through the Episode coordinator and `Stateholder.Postgres`, and into any external operation or `ChalkSync.ProviderBridge` call to the Go API (`apps/api`) and on to Cloudflare Realtime SFU. Also trace the client-side WebRTC publish/unpublish (`ports.media`) and whether the local track is stopped on disable (forcing a new getUserMedia on re-enable).

For every step, record:
- file:line references;
- whether the UI waits for it (serial, on the critical path) or it happens in the background;
- every network round trip it adds (browser→Sync, Sync→Postgres, Sync→API bridge, API→Cloudflare, browser→Cloudflare), and every Postgres transaction, lock, or synchronous-standby wait;
- every timeout, retry, or polling interval that could add delay (for example periodic head reads, the 7s bridge budget, the 8s durable-operation budget);
- when other Participants see the change, and through which path.

Answer these questions explicitly with code evidence: Does the Sync reply to `set_microphone_enabled` wait for a Cloudflare API call? Does it wait for a synchronous-standby commit? Does the UI update optimistically or only after the server confirms? Is there any sleep, debounce, or poll in the path?

## Task 2: map the Sync correctness design at a high level

Summarize, in plain language for someone who has not seen this code in months: the command path, what is durable and where, how clients recover after a disconnect (snapshot, replay, recovery_ack), what happens when a Sync node dies after acknowledging, and what happens when Postgres is unavailable. Point to the code. List any place where the implementation looks like it could lose, duplicate, or reorder acknowledged state, or could hang. Mark each as "verified by reading code" or "suspected".

## Task 3: audit the existing reliability and performance tools

The owner believes these tools are out of date and not robust. Audit each honestly:
- `apps/sync/docs/reliability-harness.md` and whatever it points to;
- `apps/sync/docs/sync-breaker-v1.md`;
- `apps/sync/docs/release-topology-failure-scheduler.md`;
- `scripts/performance/space-experience/`;
- `scratchpad/perf-harness/`;
- the SDK diagnostics operation phases in media-controller.ts (`local_track_state`, `sync_commit`, `sfu_publication`), and whether those phases actually measure what their names claim (for example, is `sfu_publication` recorded after the SFU publication really happened, or immediately after the sync commit?).

For each tool: what it claims to prove, whether it still runs against the current code (try the cheapest invocation; see constraints), what it really proves, what is stale or broken, and whether it is worth keeping, fixing, or replacing.

## Constraints

- Do not edit, create, or delete any tracked file. Do not commit, push, stash, reset, or create branches. Other agents are working in this repository.
- You may run tests and harness commands locally. Use OrbStack (`docker` CLI) for containers. Give every container, database, and volume you create a unique name containing `lane-a-20260927`, and remove them when you finish. Do not use or stop the existing `chalk_perf_profile` database, and do not bind ports 18080, 4100, or 13070, which another lane uses. If a tool can only run on those shared resources, do not run it; report that instead.
- Do not touch production, AWS, Cloudflare, PlanetScale, DigitalOcean, or any deployed service. Do not read secrets from 1Password.
- Time-box any single tool run to 20 minutes.

## Done

Write your report to /Users/macmini/code/chalk/scratchpad/sync-hardening-2026-09-27/lane-a-report.md with sections: 1) Toggle path (an ordered step table plus a short prose explanation), 2) Sync correctness design and suspected risks, 3) Tool audit (one subsection per tool), 4) What you ran and the exact results, including failures, 5) Open questions you could not answer. Separate what you verified from what you inferred. Write the report file last; its existence signals completion.
