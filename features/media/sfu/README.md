# Chalk SFU

A standalone Go service that forwards Participants' audio and video as a second media provider beside Cloudflare Realtime. The design and milestone plan are in the SFU design pull request (#796). The API reaches it through the `chalk_sfu` media-plane adapter. The module is `github.com/q9labs/chalk/features/media/sfu` and never imports `apps/api/internal`; the public `protocol/` package holds the wire types.

The code is the source of truth for the HTTP surface (`internal/` handlers, `protocol/`) and for every setting: `internal/config/config.go` lists each `SFU_*` variable with its default and range. This file keeps the parts the code cannot explain.

## Design points

- **Control** is TCP over mutual TLS 1.3, on the port `internal/config/node.json` names. The client certificate must also carry the service identity (`SFU_CLIENT_IDENTITY`), so a certificate from the right CA but another service gets 403. The listener binds all interfaces because the service is public; mutual TLS and the cloud firewall guard it. `/healthz`, `/readyz` and `/debug/pprof/` sit on the same listener, and `/readyz` and pprof need the service identity. Profiles hold heap contents, so keep them out of Git and telemetry.
- **Scope.** Every operation is scoped to Tenant, Episode, Participant and generation. Outside that scope a session reads as gone. Mutations take an `operationId`, so a retry returns the first result and the same ID with another body is a 409. The API adapter makes one ID per logical call and reuses it on HTTP retries. The node remembers the highest generation per Participant (a fence), so a delayed create from an older generation stays refused after the newer session closes. A refused create never drops a fence, and a full table never drops a live session's fence.
- **Admission** reserves packets/s per Episode so the node never overcommits: for `n` Participants with `m` cameras it reserves `n·(m·u + a) + n·(n-1)·(m·d + a) + n·(s + a)`, where `u` is a camera's uplink with every simulcast layer (publishers keep sending all of them) and `d` its downlink to one subscriber (one layer). The default costs come from the SDK's camera encodings and match what real SDK cameras sent on a deployed node. A create past `SFU_PACKET_BUDGET` gets 429 `capacity_exceeded`. An Episode is held to a ceiling (`SFU_EPISODE_PACKET_CEILING`), and admission refuses a join whose mandatory media (microphones, camera uplinks, screen share) could not fit under it, so an admitted Episode at real SDK rates is never paused wholesale. A host guard (CPU steal, CPU busy, pacer drops, UDP buffer errors, scheduler latency) closes admission to new Episodes while live Episodes still admit their Participants; `/readyz` reports the reason. Pacer queue delay is reported but does not close admission, because a new transport draining keyframes at its first estimate waits 50 ms or more on an idle node. `SFU_MAX_SUBSCRIPTIONS_PER_SESSION` defaults to `(SFU_MAX_EPISODE_PARTICIPANTS-1)·(SFU_CAMERAS_PER_PARTICIPANT+1)+2` (47 at the defaults, a full Episode plus a screen share and its audio) and `SFU_MAX_CAPTURE_SUBSCRIPTIONS` to the larger of 64 and `SFU_MAX_EPISODE_PARTICIPANTS·(SFU_CAMERAS_PER_PARTICIPANT+1)+2`; both go up to 512, and the node refuses to start with a lower value.
- **Source control.** A source forwards only under a live grant, which the API sends when Sync authorizes the source and keeps renewing. Each control carries the Episode's durable control revision. The node applies a control only at or above the source's recorded revision, and a revoke wins a tie, so a duplicate or delayed control never undoes a newer one. Every egress write checks the lease at send time, so media stops when the lease lapses even if a write stalls.
- **Retire and reserve.** `retire` raises an Episode's allocation-generation floor, closes sessions created under a lower generation, and lapses their forwarding leases, so a request issued under a binding the Episode has left cannot leave a second live allocation. The API records a retirement debt in the same transaction as the binding move and repeats the call until the node acknowledges. A floor lives 24 hours or until restart, and the table never evicts: when it is full the node turns conservative and refuses what it cannot fence. `reserve` holds a complete recovering Episode before any Participant rejoins, so a standby takes the whole call or refuses it, instead of half-recovered calls racing for capacity. Each join replaces the hold, and a hold ends at its deadline or with Episode end.
- **Capture sessions** give the recorder a receive-only connection to an Episode the node hosts. A capture is not a Participant: it takes no Participant slot, never shares a name or fence with one, and reserves packets of its own for each track it pulls. The Episode's plan and congestion decisions leave it out. The API reaches captures only when `CHALK_SFU_CAPTURE_ENABLED=true`; keep it off in production until recording parity passes (see [infrastructure/sfu/README.md](../../../infrastructure/sfu/README.md#connect-the-api)). The `kind` field is additive, and a node that predates it answers a capture create with 400 `invalid_request`, so callers check `sessionKinds` in `/readyz` first.
- **Media.** Opus and VP8 on one Pion UDP socket (ICE-lite). Each subscription forwards one simulcast layer, switches wait for a keyframe of the new layer, and each subscriber gets its own continuous stream because sequence numbers, timestamps, VP8 picture IDs and TL0PICIDX are rewritten. The forwarding path allocates nothing per packet (`TestForwardingAllocatesNothing`).
- **Congestion.** Each subscriber has its own paced downlink transport with a GCC-style estimate. Audio and repairs go first, and a full pacer queue drops video that the subscriber's NACK recovers. The control loop measures its own lateness and CPU steal: while the host is under pressure no tile drops, pauses or raises, so a stall on a shared host does not look like congestion. Loss still lowers the estimate. Publishers are not lowered because they keep sending every layer until dynacast.
- **Telemetry.** With `SFU_OTLP_ENDPOINT` the node exports async OTLP metrics as `service.name=chalk-sfu`. Metrics carry no Tenant, Episode, Participant, session or address. Only the named diagnosis events go to the same endpoint, each with a fixed set of id, number and enum fields, and a resource built from fixed attributes only (never `OTEL_RESOURCE_ATTRIBUTES`) (`internal/telemetry/export.go`); every other line, and every error string, stays in the journal (see [Follow one Participant through the own SFU](../../../docs/observability.md)). Without an endpoint the node still logs `media telemetry` lines and reports load on `/readyz`. See the [alerts runbook](../../../infrastructure/observability/production-alerts/sfu-runbook.md).

## Run it

```sh
cd features/media/sfu
SFU_TLS_CERT_FILE=server.pem SFU_TLS_KEY_FILE=server.key \
SFU_CLIENT_CA_FILE=ca.pem SFU_CLIENT_IDENTITY=chalk-api \
SFU_ANNOUNCE_IPS=203.0.113.10 \
go run ./cmd/sfu
```

## Deploy

Set `net.core.rmem_max`, `rmem_default`, `wmem_max` and `wmem_default` to `udpBufferBytes` of `internal/config/node.json` on the host (`infrastructure/sfu` sets them). Linux defaults to about 208 KiB, which bursts of video overflow as UDP receive errors. The node logs the sizes it requested and got, and `/readyz` reports them with the host's drop counters.

`POST /v1/drain` (or SIGUSR1) drains the node and keeps it running: `/readyz` answers 503 with `draining: true`, the API places no new Episode on it, and live calls continue. `POST /v1/undrain` reopens admission for a called-off restart. A restart interrupts no call once `allocations` and `cleanupDebt` are zero. `sourceLeases` only informs, because leases are soft state a restart drops and the API keeps renewing standing grants. SIGINT or SIGTERM finishes in-flight requests and closes everything.

Deployment (the OpenTofu node module, the image, the Quadlet unit, `deploy` and `certs`) lives in [`infrastructure/sfu`](../../../infrastructure/sfu), and its README is the runbook.

## Tests

Run heavy runs on Instabox (`box run -- '...'` from the repository root), not a laptop.

1. **Loopback integration** starts the real HTTP service and two real Pion peers and asserts payloads, close, inspect, duplicate create, a wrong client certificate, a cross-Tenant pull and that nothing leaks at the end. `cd features/media/sfu && go test -race -count=1 ./...`; `scripts/gate.sh` runs it with format, tidy and vet, and the repo gate runs it as the `sfu` lane.
2. **Live smoke** (`scripts/live-smoke <staging|production> --confirm <env>`) runs `TestLiveSmoke` against a deployed node through the operator certificate and an SSH tunnel, and prints `<env>-live-smoke: PASS` or `FAIL: <reason>`. Production's run is the M7 hard condition. Staging runs hold the staging lease.
3. **Live staging soak** (`TestLiveSmokeClasses` in `tests/live_smoke_test.go`) holds classes on a deployed node and judges the run against [Soak acceptance](../../../docs/sfu/capacity-calibration.md#soak-acceptance). It skips without `SFU_LIVE_URL`; the knobs and defaults are listed above the test. It is a staging run, so it goes through the lease wrapper, and `go test` needs a timeout longer than the hold. `scripts/node-cpu-capture` runs on the node over SSH and writes the CPU file the test reads:

   ```sh
   ssh root@<node> 'bash -s -- 10' < features/media/sfu/scripts/node-cpu-capture > cpu.jsonl &
   scripts/staging-sfu/staging-lock --holder soak --purpose staging-soak --run-id <label> --ttl 600 -- \
     env SFU_LIVE_URL=<control URL> SFU_LIVE_CA=<ca> SFU_LIVE_CERT=<api cert> SFU_LIVE_KEY=<api key> \
       SFU_LIVE_NODE_CPU=cpu.jsonl SFU_LIVE_RESULT=result.json \
     go -C features/media/sfu test ./tests -run '^TestLiveSmokeClasses$' -count=1 -v -timeout 5h45m
   ```

### Shared staging node

Every lane that drives the staging SFU runs its whole test, rerun, fault test or soak through `scripts/staging-sfu/staging-lock` before touching the node; workflows also use the Actions concurrency group `chalk-staging-sfu` with cancellation disabled. Cleanup of a proof's own resources by run ID is exempt: always end its Episodes and archive its Spaces without waiting for a lease, and fail the job if cleanup fails.

```sh
scripts/staging-sfu/staging-lock --holder lane-name --purpose retest --run-id run-label -- your-test-command
```

The helper creates `refs/heads/locks/staging-sfu` atomically, holding one JSON lease record (holder, purpose, run ID, times, ownership token). Use plain labels, not customer names, URLs or secrets. The lock branch must stay outside release branch protections, and nobody edits or deletes it by hand. Expired leases are taken over with compare-and-swap, and release expires the record instead of deleting it. The default wait is 10 minutes and the TTL 180 seconds with periodic renewal; a failed renewal stops the workload before expiry. Never detach a workload from the helper, because the lease covers only its process tree. The lease is cooperative, so an older checkout or unwrapped command can still interfere. The nightly latency card therefore also records observed foreign Episodes and connections (see the [scorecard](../../scorecard/README.md#staging-contention)). The disposable fleet in `scripts/bench/bench` and `scripts/bench/faults` does not target shared staging and needs no lease.
