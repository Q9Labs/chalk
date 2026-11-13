> **Plan, not authority.** This is one of our plans. It may be stale or wrong, and code, contracts and checks win wherever they disagree. Verify any claim here against code before relying on it.

# Chalk SFU

Why Chalk runs its own SFU, and the constraints it must keep. The code under `features/media/sfu/` and `apps/api/internal/adapters/chalksfu/` is the source for behavior, routes and defaults. The [SFU README](../../features/media/sfu/README.md) covers the service. [Capacity calibration](../sfu/capacity-calibration.md) explains the node budgets and [production rollout](../sfu/production-rollout.md) the move of traffic.

## Decisions

- **Go with Pion, no new call protocol.** Pion supplies WebRTC and RTCP primitives, not an SFU. Chalk owns routing, sequence translation, pacing, allocation and lifecycle fencing. API, Sync, publication references and the SDK signalling flow stay. We do not adopt LiveKit's room protocol or SDK. Borrowing a LiveKit unit (layer selector, RTP translation, allocator) is allowed only when smaller than writing it. It is Apache-2.0, so a copied unit needs its upstream commit, headers and NOTICE text recorded in a third-party notices file in the SFU module. Do not import a room server for its allocator, and do not assume code built against LiveKit's Pion fork fits stock Pion.
- **Pinned upstream Pion, fork only on profile evidence.** Module versions are pinned in `go.mod` and updated on purpose. A fork needs a CPU or heap profile that shows a hotspot upstream cannot fix in time (fix unmerged, declined, or Linux-only). Then: fork into the Q9Labs organization, wire it with a `replace` pinned to a commit, keep one patch per hotspot, send fixes upstream, and record each patch (profile, before and after numbers, upstream PR, removal condition) in a fork-patches file in the SFU module. No such fork exists today. Likely candidates are batched UDP sends (`sendmmsg`) and per-packet allocations. Do not adopt LiveKit's fork for either.
- **No transcoding, no seamless failover.** Two-layer camera simulcast with per-subscriber layer choice. Non-goals: global routing, one Episode across nodes, PeerConnection migration on node loss, VP9/AV1 SVC, end-to-end encryption beyond DTLS-SRTP. Node loss means coordinated replacement: clients rejoin with fresh sessions.
- **Provider is frozen per Episode.** A Tenant default with Space override picks the provider only when an Episode is created, and the binding is stored in the same authority transaction. A flag flip or rollback never moves live media. A client that does not declare `chalk_sfu` gets Cloudflare or `media.client_unsupported` (409), never an own-provider grant it cannot decode.
- **Cloudflare TURN stays.** It works with any destination, is free at current traffic, and costs nothing to keep. Relay traffic to our SFU counts against the same shared allowance as Cloudflare SFU traffic (first 1,000 decimal GB a month, then $0.05/GB), so count both during rollback windows. Revisit only if a relay-only proof against our SFU fails, relay latency misses the media gates, usage nears the paid tier, or compliance rules it out. A replacement needs its own TLS-443 listener, short-lived credentials, quotas and private-destination blocking. Retiring Cloudflare SFU must keep TURN credentials and renewal monitoring.
- **Cloudflare SFU retirement is its own release decision.** It needs seven consecutive days at full cutover covering evening peaks, zero Cloudflare overflow and signalling in that window (including deploys and failure drills), zero live Cloudflare Episodes, captures or pending cleanup, and a rehearsed rollback. After removal, rollback means redeploying the last compatible release. Keep historical binding and artifact readers until retention obligations end.

## Control channel

The API proxies SDK signalling to the SFU over mutual TLS on public TCP 8443. The browser never calls this listener and never holds a service secret.

- Private networking is not authentication. The API client and SFU server have separately rotated identities, and each side authorizes the expected identity, not any certificate from the CA.
- The application tier is one AWS node, not a shared VPC with the Droplets, so control crosses the public internet. The cloud firewall also limits 8443 to the API host's fixed Elastic IP. Readiness and metrics are open only to configured operators.
- The SFU module exposes versioned DTOs in its own `protocol` package. The API adapter translates to `mediaplane`. There is no parallel domain model and no database replica. The SFU has no Postgres client.
- Scope comes from authenticated authority at the API, never from caller-supplied track names. The SFU checks that every referenced publisher and subscriber belongs to the same Tenant and Episode.
- Mutations carry an operation id and body digest. An identical replay returns the prior result and a conflicting reuse fails. Replay storage lives as long as the session. Never evict a live revoke watermark to admit more work.
- Media goes direct to a Droplet public address over one UDP mux, never through an HTTP proxy or CDN. Signalled ICE candidates are limited to intended public addresses, so untrusted SDP cannot probe a private network.

## Media path rules

- Forward only codecs we can forward or translate safely. Single-encoding browsers must work. Screen is one stream with optional screen audio, with no screen simulcast.
- A paused layer is not a dead publication. Switching layers waits for a decodable keyframe and throttles upstream PLI and FIR. Translate sequence numbers, timestamps and picture ids across switches, so the subscriber sees one continuous track.
- Subscriber transports get fresh transport-wide sequence numbers. Never forward the publisher's. The allocator spends the per-subscriber estimate on audio, then screen, then cameras within the requested ceilings. It drops fast and raises slowly. If the lowest camera layer does not fit, it pauses video and keeps audio.
- Packet history is kept once per ingress stream and shared by subscribers, at most one second per stream. A slow subscriber never blocks a publisher reader. Repair traffic counts in the congestion budget.
- Active-speaker state comes from Sync. The SFU forwards RFC 6464 audio levels but owns no presence authority.
- New own-provider pulls start on the low layer, because an unprobed top layer into a link of unknown size is the likeliest moment for a queue and a freeze. The picture sharpens in seconds. Cloudflare pulls keep starting on the top layer.
- Tell the viewer why video is paused. The SDK reads subscription state (`active` or `paused`, with a reason and a revision, highest revision wins) before it repulls a stalled track. A paused track shows "video paused for network", not a frozen frame. Signalling is request and response, so there is no server push.
- Video is pulled only for visible tiles, and audio is always pulled. Tile visibility is reported to the SDK per publication, and an unreported tile is treated as visible after a short wait, so a UI that never reports keeps the old behavior.

## Reconnect and authority

Postgres owns durable admission, permissions, media-control revisions and operation intents. The SFU owns only actual allocations and packet liveness. Losing a Sync socket is presence loss, not a durable Leave.

1. Off stops local capture at once and cannot fail as a user intent. The owed off survives timeouts and reconnects until Sync accepts it, and never stops a different device's publication.
2. On is authorized by Sync. A pending permission or publication is not visible-on, and recovering a stale on snapshot never restarts a locally muted source.
3. Recover grants and newer moderation stops, not only observed publications. A missing publication is not a host stop. A proven drop under 60 seconds keeps consent. A longer or unproven drop needs a new user on, unless the user acted freshly during it. Without the negotiated off-reason extension, behavior fails closed.
4. Stale generation, revision, publish, enable, close and old-node responses never affect newer intent or allocations.

Distributed revoke is not atomic, because the SFU cannot change Postgres in the same step. So:

- Keep durable operation intents and retry cleanup. Make revoke atomic only inside the SFU's routing state.
- Keep a per-source revision tombstone even without a track. Remove routing before acknowledging a revoke. Only a newer authorized grant clears the tombstone.
- A device's off or old-session close targets only its own allocation. A host stop fences the Participant and source across allocations. Neither lets a late close kill another device's newer publication.
- A source that no control has named does not forward. Forwarding runs on short leases (default 15 s), renewed by the API only while the Episode is live, the Participant is present with the capability, and no stop was decided at or after the grant. The SFU checks expiry on the forwarding path, not on a GC tick. Never extend a lease from RTP receipt or SDK claims. So lost control connectivity ends forwarding by expiry. Mute enforcement is bounded by the lease, not instant, and the production proof treats that bound as its limit.
- ICE restart preserves consent and off debt. A failed restart or missing session gets a fresh bootstrap, generation and PeerConnection. Never reuse a DTLS association across a node incarnation change.
- Node loss drops all sessions, packets and caches. A new boot gets a new incarnation, and old handles are rejected as gone. Clients replace sessions, republish wanted sources and re-pull from the API's roster. Cached on states are never treated as permission. Postgres being down blocks new admissions and lease renewal.

## Admission and capacity

The node admits by a packets-per-second reservation, not by Participant count. Costs and limits are config (`internal/config`). Rules that code cannot say:

- The Episode participant limit is not a capacity promise. A configured maximum is bounded by packet, memory and live-health budgets, and the API's durable Participant maximum is not an SFU throughput claim.
- Reserve for the upper bound of what a Participant may publish, so admission rather than a blanket pause is the gate. Every hop counts: uplink, each downlink, and audio. Replacement must not double-count a Participant.
- A per-Episode ceiling keeps one class from taking the node. Mandatory media (every microphone and camera uplink, since only subscriber layers can be lowered) must fit under it, or the Episode refuses admission. Never claim sixteen all-audio Participants fit a class-sized ceiling, and never sacrifice audio silently.
- Large calls show small tiles and ask for the low layer, so billing every downlink at the top layer overcounts about four times. Past the large-call size, one featured Participant is billed at the top layer and all other cameras at the low-layer cost, and the ceiling is the node budget. A large call never reserves less than a call at the threshold, so a Participant leaving cannot raise the node total.
- Capture is additional load. A capture reserves the per-track top-layer cost of each track it pulls, and a pull that does not fit is refused.
- Memory: about 5 to 8 MiB RSS per PeerConnection was measured, and the Go memory limit sits below the container limit. The 2 GiB node must stay below 70% of RAM with no growth over an hour. Test on the production size, never by extrapolating from staging.
- Shared vCPU steal decides when to stop admitting. The service exports steal, pacer delay and scheduler latency. The code default of 3% steal is too tight for shared Droplets, so deploy sets 25% on staging and 40% on production. If the guards close admission in more than 1% of minutes in a week, compare a dedicated-CPU node rather than accept freezes. More vCPUs do not prove the roughly 60,000 outbound packets/s ceiling has gone away.
- Tune from profiles: every optimization needs a profile before and a gain after. Raw profiles stay out of Git. Registering only the interceptors we use and one UDP mux are design defaults, not optimizations waiting for evidence.

## Hosting and budget

One `s-1vcpu-1gb` staging node ($6) and one `s-2vcpu-2gb` production node ($18) in Singapore `sgp1`, $24 a month, plus disposable bench nodes. Decided 6 November 2026 by Hasan. A production standby, a second $18 node or a dedicated-CPU tier needs a new approval, and nothing relies on one.

- Bench nodes are tagged `chalk-sfu-bench`, deleted by that tag, and listed empty before the lane reports done. Stopped Droplets still cost money. A run costs under USD 1.
- Placement is primary first. A standby takes new Episodes only when the primary is unhealthy, draining or full, and at a smaller packet budget with camera layers held low. The API follows the Episode's binding for control, never a round robin. Production has no standby, so that role is proved on bench nodes only. When no node can take a new Episode, it ends in Cloudflare overflow until Cloudflare SFU is retired, then in an explicit capacity result. An extra Participant refused in a bound Episode is never sent alone to another provider.
- Egress is cheap at today's volume (about 103 GB a month against 4,000 GiB pooled transfer), so replacing Cloudflare SFU is a control and completeness decision, not a saving. Do not multiply a busy-hour peak into a monthly bill.
- Deploys drain the node: new Episodes go elsewhere, existing calls and cleanup finish on it, and the node stops at zero allocations and cleanup debt. A deadline that forces replacement is disruptive recovery. Resize by draining first and using a CPU and RAM-only resize, or by building a replacement. Measure a new size before changing budgets.
- Keep one Episode on one node. Use the node assignment and boot incarnation on every operation, including capture and deferred cleanup, so a response from a replaced node is rejected and cleanup stays aimed at the old allocation.

## Observability and security

Follow [observability](../observability.md). Carry `traceparent`, the allowlisted `session.id` baggage and the journey context from API to SFU, through deferred cleanup. A provider session id is not the device `session.id`. Metric labels are bounded (provider, codec, kind, RID, outcome): never Tenant, Episode, Participant, publication, IP or session ids. Telemetry carries no SDP, ICE candidates, credentials, device labels, packet dumps or payloads. Disable core dumps. A server bytes-sent counter does not prove audio was rendered, so keep the SDK call-stats path for that. SFU-local telemetry cannot replace durable Postgres lifecycle evidence. Update the journey ledger and observability proof when a lifecycle boundary changes.

DTLS-SRTP terminates at the SFU, so this is transport encryption, not end-to-end. Reject oversized SDP, excess tracks, unsupported codecs and unauthenticated control before allocating state. Test cross-Tenant pulls and forged or stale ids. New provider and bootstrap capabilities are additive contract changes: run `pnpm run regen`, and check that the previous server release still runs against the expanded schema. Deploy accepting servers and compatible SDKs before selecting any Space. Never expose own-provider Spaces to SDK versions that cannot use them.
