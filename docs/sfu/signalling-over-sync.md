# SFU signalling over the Sync WebSocket

Status: design only, no product code. Recommendation: **stage it**. Do not build the
move as a transport swap. It costs about 20 lane-days and, against the single-URL
change already in flight, saves nothing on mic, camera and screen toggles and at most
one round trip (about 196 ms) once per join. The case for it rests on server push,
which needs its own design (stage 2) and is decided after the next nightly cut.

A lane-day is one lane's working day that ends in a reviewed, gate-green PR.
Round-trip numbers use the nightly proof's own runner-to-SFU round trip (1 RTT = 196 ms
p50, from a US runner to the Singapore SFU).

## Question

Today each SFU signalling call is an HTTP request: browser, Cloudflare, Tunnel, API,
SFU over mutual TLS. Can all of it (publications, tracks, renegotiate, subscriptions,
tracks/close, tracks/update) move onto the already-open Sync WebSocket, with server
push, and what would it save?

## What the data says

Evidence is the latest nightly sidecar (60 cycles, US runner) and the stage
definitions in `features/scorecard/stages.mjs`.

1. **The Sync socket opens after the first SFU calls finish.** Summing the join's
   from-previous stages gives: socket created at 80 ms, open at 858 ms (`sync_connect`
   778), welcome at 1,261 ms (`sync_welcome` 403). The first `listPublications` reply
   arrives at 674 ms and the first `tracks` reply at 1,272 ms. A WebSocket-only join
   could not send its first signalling frame before about 1,261 ms, so it would
   delay the join by roughly 560 ms unless HTTP stays in the join path.
2. **A warm HTTP call costs about 1.5 RTT, not 1.** `camera_on.list_publications`,
   `mic_on.list_publications` and the matching turn-off stage are all about 300 ms
   p50. The URL's preflight is already cached there, so about 100 ms of that is
   server work (credential check, Postgres participant and Episode reads, the
   mutual-TLS call to the SFU). A WebSocket frame does not remove that server work.
3. **A cold join call costs about 3 RTT.** The join's three sequential calls are
   about 600 ms apart (674, 1,272, 1,838): one preflight (1 RTT), one request (1 RTT),
   server work (about 0.5 RTT) and an unexplained rest. The single-URL change (the
   `/signal` route) removes two of the three preflights, about 2 RTT (390 ms) by
   `join.sfu_renegotiate`.
4. **Sync's own round trip is longer than the SFU's.** `rtt.sync_ms` is 265.6 ms p50
   against `rtt.sfu_ms` 196 ms. The live ping renews presence in Postgres before it
   replies (`apps/sync/lib/chalk_sync/transport/socket.ex`, `handle_frame(:ping, ...)`).
   PR #1028 moves the reply first. Until a cut shows the gap closed, a Sync frame costs
   about 70 ms more than the same HTTP request.
5. **Most of a toggle is not signalling transport.** `camera_on` receiver stages are
   `sync_fanout` 727, `list_publications` 302, `pull` 865, `renegotiate` 315.
   `list_publications` and `pull` are two sequential request/response pairs that a
   different protocol shape removes, with or without a WebSocket (see stage 0).

So a transport swap changes the 1-RTT preflight and nothing else. The structure of the
exchange (three sequential calls on join, list then pull then renegotiate on a
receiver) is what costs time.

## Options for who talks to the SFU

| Option                                           | Verdict                                                                                                                                                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Browser to Sync to API (internal call) to SFU | The only workable shape. The API keeps the six handlers, the publication registry, receive-health observers, per-Tenant plane resolution (own SFU and Cloudflare) and the mutual-TLS client. Sync only frames, orders and relays. |
| B. Sync calls the SFU directly                   | Rejected. It re-implements `signalSFUTracks` and its observers in Elixir, puts SFU client certificates on Sync, and leaves the Cloudflare plane on a second path.                                                                 |
| C. A signalling WebSocket on the API, not Sync   | A fallback if Sync's fate-sharing proves too costly. Same protocol work, but a second socket pays another connect (Sync's own takes 778 ms) unless it opens in the lobby.                                                         |

The rest of this document designs option A.

## Protocol

Negotiation follows the existing pattern for `participant_devices=1` and
`media_off_reason=1` (`apps/sync/README.md`): the SDK adds `media_signal=1` to the
WebSocket query and the welcome frame carries `"media_signal": true` only when the
server flag is on. An old SDK never asks. A new SDK on an old or flagged-off Sync sees
no flag and keeps HTTP. React Native and the native apps keep HTTP.

Two new frame types in `contract/schema/sync-v1.json`, generated to Elixir and
TypeScript by `pnpm run regen`:

- `media_signal` (client to server): `request_id` (existing 16 to 64 byte rule), `op`
  (`publications`, `tracks`, `renegotiate`, `tracks_close`, `tracks_update`,
  `subscriptions`, the same names the `/signal` change uses), `credential` (the media
  bearer, unchanged), `body` (the same JSON the HTTP route takes, with its query
  parameters moved into the body exactly as `/signal` does).
- `media_signal_result` (server to client): the same `request_id`, `status` (the HTTP
  status the route would return), and `body` (the route's JSON, or its API error
  envelope).

Reusing HTTP status codes and bodies means the SDK keeps one response parser and one
error mapping, and a parity test can compare the two paths byte for byte.

Limits. Sync's decoded command payload limit is 16,384 bytes and a live event is
32,768 bytes encoded. An SDP offer for a large pull can pass both. Signalling frames
get their own limits (proposed 65,536 inbound, 65,536 outbound), set in the contract.

**Acks and ordering.** A request gets exactly one result. Writes (`tracks`,
`renegotiate`, `tracks_close`, `tracks_update`) run one at a time per socket in arrival
order, because the SFU allows one serialized negotiation per session. Reads
(`publications`, `subscriptions`) queue behind them on the same worker: reads take
about 100 ms of server work, and one worker avoids a second ordering rule.

**Backpressure.** At most one operation in flight and eight queued per socket. A ninth
gets `status: 429` with `retry_after_ms`, not a dropped frame. Results use the existing
bounded outbound queue (`apps/sync/lib/chalk_sync/transport/outbound_queue.ex`); the design must confirm that a
full queue closes the socket with the same retryable code Sync already uses, because a
lost result looks like a hung call to the SDK.

**Idempotency and replay.** Today the HTTP routes carry no client request id
(`sdks/typescript/client/src/media/transport.ts` sends none), so a retry after a network error can double-apply.
Over a socket that can drop mid-call this matters more. Sync forwards `request_id`
to the API. The API keeps a short result cache keyed by participant and request id
(proposed 60 s, bounded per participant) and returns the stored result on a repeat. The
SFU already de-duplicates mutations by operation id and body digest
(`docs/sfu/design.md`, control contract); the API derives that operation id from the
request id so both layers agree. Sync itself keeps no state: the per-socket queue is
disposable, as the Sync README requires.

## Authority

The API remains the only authority. Sync is not trusted to say who the caller is.

1. The frame carries the media credential. Sync checks only that the credential's
   participant and generation match the socket's admitted identity (cheap, rejects
   crossed frames) and forwards it unchanged.
2. A new internal route on the existing provider-bridge listener (mutual TLS, Sync
   identity pinned) accepts `{op, request_id, credential, body}`. It runs the same
   `requireParticipantMedia` verification, `AuthorizeActiveParticipant`,
   `RouteSubject` match and Episode lookup as HTTP, then calls the same six handler
   functions the `/signal` dispatcher calls. It must not copy handler logic. If the
   handlers are still closures when this starts, extracting them is part of the
   single-URL change, not this one.
3. Rate limits stay in the API and stay keyed by participant (`rateLimitKey` uses the
   verified subject, not the client IP), so Sync's address never becomes the key.
   Parity is a table test over every op: same policy, same limit, same 429.
4. Tenant and Episode scope come from the verified credential and the socket identity.
   Nothing the SDK puts in `body` can widen them.

A compromised Sync can replay credentials it has already seen, which is the same
exposure the Tunnel has today. It cannot mint a credential.

## Failure semantics

- **Socket loss is presence, not lifecycle** (`apps/sync/README.md`). Dropping the
  socket never leaves or unpublishes anyone. An operation already sent to the API
  runs to completion there; its result is dropped if the socket is gone.
- **Replay after reconnect.** The SDK re-sends unanswered requests with the same
  `request_id`, over the new socket or over HTTP if the capability is gone. The API
  result cache turns a repeat of a finished call into a stored reply. A repeat of a
  call still running joins it rather than starting a second one.
- **Partial failure.** `tracks` already reports per-track errors inside a 200. The
  result frame keeps that shape; the transport adds no new partial state.
- **Deadlines.** The relay budget is 7 s, shorter than the SDK's 8 s
  (`SIGNALING_TIMEOUT_MS`), the same ordering the provider bridge already uses (7 s
  bridge request inside an 8 s consumer budget). On expiry Sync returns a timeout
  result, and the cached outcome (if it lands later) answers the SDK's retry.
- **Sync restart or deploy.** Sync drains by closing sockets with 1012. HTTP
  signalling survives a Sync deploy today. With this change the SDK must fall back to
  HTTP while the socket reconnects, so HTTP stays for good. That is a permanent second
  transport to test, and the largest long-run cost of the design.
- **Head-of-line risk.** The socket process handles frames inline and the ping handler
  does a Postgres transaction inside it. A relayed API call must run in a supervised
  per-socket task and deliver its result by message, or one 7 s call blocks pings,
  replay and fan-out for that socket. The bridge HTTP client also sets
  `max_keep_alive_length: 0`, so each call opens a new mutual-TLS connection to the API
  on the same host. That is cheap on loopback but unmeasured; work item W0 measures it.

## SDK transport

`sdks/typescript/client/src/media/transport.ts` already hides HTTP behind the
`CloudflareSFUSignalingTransport` interface (`addTracks`, `closeTracks`, `updateTracks`,
`listSubscriptions`, `renegotiate`, `listPublications`). The new transport implements
that interface on top of `sdks/typescript/client/src/sync/v1-client.ts`:

- One selector per session: use Sync when `media_signal` was in the welcome and the
  socket is live; otherwise HTTP. No per-call racing.
- Correlation map of `request_id` to pending promise, each with the 8 s deadline,
  rejected on socket close and then retried once through the selector.
- Failure markers (`markMediaFailure`, step names in `SIGNALING_STEPS`) and the
  `credential` stage that the single-URL change adds keep working unchanged.
- No change to `sdks/typescript/client/src/media/client.ts` call sites. A reviewer should see zero diff there.

## Observability

Frames already carry `journey_id`, `traceparent` and `tracestate`. Add a short
`sync.media_signal` span per op with bounded attributes only (`op`, `outcome`, `status
class`), never tenant, participant or request ids. Add fixed-cardinality counters to
`/metrics`: ops by op and outcome, in-flight gauge, queue overflows, deadline expiries,
cache hits. The sidecar records which transport served each call so a cut can compare
the two. A new user-visible lifecycle step means the journey ledger and observability
proof get updated (`docs/observability.md`).

## Rollout and rollback

Server flag on Sync (`CHALK_SYNC_MEDIA_SIGNAL`, default off) read at socket entry;
the SDK needs no flag because it follows the welcome. Rollback is setting the flag off
and restarting Sync (clients reconnect on the 1012 close and see no capability, so they
use HTTP); no web build changes. The API route is dormant when nothing calls it.
Deploy order: API route, then Sync, then web SDK, matching the Sync README's rule that
the server side lands first. Exposure: staging nightly with alternating cycles (30
HTTP, 30 socket) so one cut gives a like-for-like table, then production at the lead's
discretion.

## Cost

- **Postgres writes per op:** none added. Signalling frames do not use the Episode
  command path, so there is no event, receipt or lease write. The API's existing
  registry writes are unchanged.
- **Infrastructure:** none. Sync and the API run on the same AWS Singapore node behind
  the same Cloudflare Tunnel (`infrastructure/managed-episode/README.md`), so the
  extra hop is local. No new service, tier or recurring spend.
- **Where the Sync socket lives:** the one Sync container, single node. Media
  signalling would depend on it for the fast path (HTTP remains the fallback).

## Expected saving by stage

Baseline is the latest nightly. "Single URL" is the `/signal` change already in
flight. "WebSocket, extra" is what this design adds beyond it, assuming Sync's round
trip has dropped to the API's after #1028 (not yet shown). Negative means slower.

| Stage                                                             | Today p50              | After single URL                    | WebSocket, extra                                                                                                   |
| ----------------------------------------------------------------- | ---------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `join.sfu_publications`                                           | 674 ms (cumulative)    | no preflight gain on the first call | none: the socket is not open until about 1,261 ms. With a lobby pre-connect (lane O): up to -1 RTT (about -196 ms) |
| `join.sfu_tracks`                                                 | 1,272 ms               | -1 RTT (about -196 ms)              | none; negative without a pre-connect                                                                               |
| `join.sfu_renegotiate`                                            | 1,838 ms               | -2 RTT (about -390 ms)              | none beyond the first-call preflight above                                                                         |
| `join.ice_connected`                                              | 3,467 ms               | follows renegotiate                 | follows it                                                                                                         |
| `mic_on`, `camera_on`, `screen_start` publish and receiver stages | 300 to 865 ms per call | preflight already cached            | about 0 RTT; +70 ms per call until the ping fix shows in a cut                                                     |
| `mic_off`, `camera_off`, `screen_stop`                            | 300 to 600 ms per call | preflight already cached            | about 0 RTT                                                                                                        |

Total beyond the single-URL change: **about 1 RTT (196 ms, 5.7% of the 3.5 s join) on
join, and only with a lobby pre-connect; about zero on toggles.** After 600 s idle a
cached preflight expires, so the first toggle after a long quiet period pays 1 RTT on
HTTP and not on the socket; that is rare and small.

The estimates come from the sidecar above. Two inputs are unproved: whether Sync's
round trip matches the API's once #1028 lands, and the unexplained part of the 3 RTT
join call (the `credential` stage in the single-URL change will show it).

## Work breakdown

| #   | Item                                                                                                                        | Lane-days |
| --- | --------------------------------------------------------------------------------------------------------------------------- | --------- |
| W0  | Measure first: Sync versus API round trip after #1028, credential stage, relay hop and new-connection cost on the same host | 0.5       |
| W1  | Contract: `media_signal` and `media_signal_result`, limits, capability, regen, fixtures, old-client tests                   | 1.5       |
| W2  | API internal route: reuse of the `/signal` handlers, credential verify, request-id result cache, parity table tests         | 2         |
| W3  | Sync server: per-socket serial worker, deadlines, bounded queue, pooled bridge client, flag, telemetry                      | 3         |
| W4  | SDK transport: selector, correlation, fallback and retry, unit tests                                                        | 3         |
| W5  | Observability: spans, counters, sidecar transport tag, journey ledger                                                       | 1         |
| W6  | Verification: ExUnit, Go parity, TypeScript, fault simulation (kill Sync mid-op, API 5xx, replay), browser end to end       | 3         |
| W7  | Rollout: A/B nightly, Orb runs (lead), flag runbook                                                                         | 1.5       |
| W8  | Docs: Sync README section, route docs                                                                                       | 0.5       |
|     | Build subtotal                                                                                                              | 16        |
|     | Review and rework (Sol judge rounds, regen conflicts)                                                                       | 4         |
|     | **Total**                                                                                                                   | **20**    |

With W1 first and W2, W3 and W4 in parallel on three lanes, elapsed time is about 9 to
10 working days. The lead's Orb runs and the nightly A/B add calendar time, not lane
time.

## Risks

1. **Permanent second transport.** Sync restarts, old Sync, native apps and the flag
   all force HTTP, so both paths are tested and supported indefinitely.
2. **Media depends on Sync's health.** A slow Postgres standby already stalls the ping
   path; relayed signalling would share the socket's queue with it.
3. **Credential forwarding.** Tokens now cross one more process. The mutual-TLS bridge
   is loopback-local, but Sync logs and spans must never include `credential`.
4. **Frame size.** Large SDPs exceed today's Sync limits; raising limits for one frame
   type needs a bound that the hostile-frame tests also cover.
5. **Unverified assumptions.** SFU replay of an already-applied renegotiate answer must
   return success; check `features/media/sfu/internal/media/session.go` before W2.
6. **Regression risk on join.** A WebSocket-first join is slower than HTTP (see data
   point 1); the selector must keep HTTP for the join unless the socket is already open.

## Recommendation: stage it

**Stage 0, now, no WebSocket work.** Ship what is already in flight: the single URL,
one-request publish, mute without renegotiation, #1025 (ICE pool), #1028 (pong first).
Add two cheap items found here, each its own lane:

- _Receiver skips `listPublications` on a Sync media change._ The Sync media item
  already carries `publication_id` when enabled (`contract/schema/sync-v1.json`), and the camera-on
  receiver pays `list_publications` (302 ms) then `pull` (865 ms) in sequence. Whether
  the pull can start from the Sync item, with `listPublications` as a background
  reconcile, needs a read of `refreshRemotePublications` and the recovery paths in
  `sdks/typescript/client/src/media/client.ts`. Potential: about 1.5 RTT (about 300 ms) per receiver turn-on and turn-off.
  Estimate 2 to 3 lane-days including tests.
- _Overlap the join's preflight with media capture._ Fire the preflight as soon as the
  participant id is known, in parallel with `getUserMedia`. Saves up to 1 RTT only
  where capture is slow; check first whether capture already runs before the first call.

**Gate.** After a nightly cut with stage 0, compute for each call the time above one
RTT. Move to stage 1 only if the remaining cost per call is above about 150 ms and Sync
and API round trips are within 20 ms of each other.

**Stage 1, not sized as a transport swap: server-initiated subscription.** The only
saving big enough to justify a socket is removing the receiver's request legs. If the
SFU or API pushes the offer for a new publication over Sync, the receiver does
`renegotiate` only, which would cut the `list_publications` and `pull` stages
(about 1,170 ms on camera-on, about 6 RTT). That is a protocol and SFU redesign, not
signalling transport, and needs its own design doc before any estimate. This document's
work breakdown is the transport half that design would reuse.

**Go condition for the full 20 lane-days:** the stage-1 design is accepted, or the gate
data shows more than about 1 RTT of per-call cost the socket would remove. **Not go**
if the post-stage-0 cut shows per-call cost within about 100 ms of one RTT, since then
the move buys under 200 ms at join for a permanent second transport.
