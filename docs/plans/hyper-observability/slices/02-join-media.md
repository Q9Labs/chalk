# Slice 2: Join and media connection

Trace an admitted Participant from Join through Sync entry, SFU signaling, and first RTP. The SDK reporting `live`, a successful HTTP response, or an ICE candidate on its own does not prove media flowed.

## 1. Scope

- **Entry seam (slice 1):** invites, knock, admission, access issuance before an admitted seat, and prejoin capture belong to slice 1. This slice starts on the SDK Join that obtains the admitted seat's grant. Capture performed for that Join supplies the initial publish intent and availability; its result belongs to this slice only after it can be attributed to the admitted seat.
- **Recovery seam (slice 7):** before the first RTP in either direction, an ICE restart or connection replacement is still startup for diagnosis, even if the SDK internally calls it recovery. After the first RTP, slice 7 owns subsequent disconnects and reconnection; slice 2 may still witness the other initial direction on the same peer connection. Audio/video rendering and one-way quality belong to slices 3 and 4.
- **Population:** every Episode seat declared by Postgres for an Episode with media. A seat with no observed attempt is unchecked; admission alone does not prove the person pressed Join. Each observed Join names an operation; do not combine multiple attempts or peer connections into one success. A Participant intentionally leaving before media is not a startup failure.
- **Files:** SDK `connection/{lifecycle,dependencies,production}.ts`, `media/{initial-join,client,types,call-stats}.ts` and focused tests; SDK telemetry priority; API SDK telemetry event validation and generated contracts; this spec, the join registry area, the rule and its fixtures. No protocol, admission, retry, or media behavior changes.

## 2. Symptom catalogue

| Code | Party | User words | Outcome |
|---|---|---|---|
| `join.no_media` | Participant | “stuck connecting”, “I joined but nothing works” | Broken when the SDK witnesses a terminal startup failure or a measured startup deadline without RTP. Not inferred from silence in telemetry. |

Listen-only after a denied or absent input is supported, not a finding. The proof names the input and whether it was denied, absent, not requested, or captured. A missing camera does not make a working microphone listen-only.

## 3. Witnesses

`join.initial` is a per-seat SDK fact. It reads `join.initial_signal` (`sdk.telemetry` type `initial_join` until the client kernel envelope has a native delivery path). Query: `episode_id`, Participant, and `op_id` for one Join. The server binds identity to the credential rather than accepting a Participant claim from the payload.

| Hop | Evidence |
|---|---|
| Sync | Start, live, entry confirmed, and terminal Sync failure or hello timeout. The client witnesses its own view, not a server commit. |
| Capture and publish | Initial microphone and camera dispositions; startup publish request, completion or terminal failure. A no-op can never be a successful publish witness. |
| SFU transport | ICE state, DTLS state when available, and whether the browser selected a direct or relay pair. TURN candidates merely offered are not a fallback. |
| Subscribe | A remote pull is requested; at least one remote track is accepted, or the pull fails. A retryable pull failure is only a breadcrumb until a deadline is measured. An empty room is not a pull failure. |
| RTP | Positive outbound and inbound audio/video packet counts from the current peer connection, with no candidate addresses, track identifiers, packet payloads or SDP in telemetry. Counts are local transport evidence, not another Participant's playout. |

## 4. Rule conditions

- A terminal startup timeout/error is cited directly. A retry, Episode end, user cancellation, or missing stats is not proof of failure. The stats-based deadline starts only after local publish or remote pull creates an expectation, and needs a continuous sampling interval; a suspended tab or missing stats cannot time out based on elapsed wall time alone.
- A successful startup requires Sync entry, receive RTP, and send RTP when local publication was requested and capture supplied a track. Listen-only requires receive RTP but not send RTP. Without a peer, a seat that only sent RTP stays unchecked, not broken. Evidence from one live direction never proves both.
- Missing required evidence, unplaceable clocks, and a never-observed start remain unchecked. Keep any independently proved failure when unrelated rows disappear.

## 5. Boundaries to adopt the kernel at

- `performJoin` binds the observer after access resolves. Keep observations outside the retry, terminal, and Leave decisions.
- The media client records actual publish and pull attempts; the owned peer connection's state callbacks and existing stats sampler observe ICE, DTLS, selected pair and RTP. No extra stats loop. Do not sample a retired peer connection as current.
- Emit bounded enum values through the SDK kernel and acknowledged outbox. Do not send codec identifiers, device labels, candidate addresses, credentials, or signaling bodies.

## 6. Fault scenarios

| Injection | Expected finding | Healthy control |
|---|---|---|
| Sync never reaches live | `join.no_media`, Participant, `sdk.connection`, `join.sync_timeout` | Sync entry confirmed, two-way RTP |
| First publish is rejected and startup fails | `join.no_media`, Participant, `sdk.media`, `media.publish_failed` | Publish accepted, two-way RTP |
| ICE fails, or never progresses within the observed startup budget | `join.no_media`, Participant, `sdk.media`, `media.ice_failed` or `media.transport_timeout` | Connected DTLS and RTP; selected relay pair proves TURN use without a finding |
| Remote pull repeatedly fails and startup never moves RTP | `join.no_media`, Participant, `sdk.media`, `media.subscribe_timeout` | Remote pull accepted and receive RTP, outgoing devices unavailable or off |
| Connected but RTP stays at zero for the observed budget | `join.no_media`, Participant, `sdk.media`, `media.rtp_timeout` | Packet counts advance; absent or interrupted measurements remain unchecked |

Use the normal SDK entry points, inject at the Sync, SFU signaling and peer-connection boundaries, and judge outbox records without fabricating timestamps or identity. A live stack run additionally needs intake, readback and the real CLI. Save fault and control lines with the run evidence; do not present fixture output as live readback.

## 7. Out of scope and traps

- Do not change ICE policy, force TURN in production, infer why consent failed, or report media connectivity from the SDP handshake alone.
- DTLS is recorded only when the runtime exposes it; overall peer connection failure is not proof of a DTLS failure. Relay is a selected path, and only direct followed by relay proves an observed switch.
- A seat declared by Postgres with no timed, bound row must remain unchecked. Do not synthesize the missing Join, use receipt time as event time, or turn telemetry loss into a media failure.
