# Declarative core-conference sync v3

Status: proposed

Protocol v3 turns Chalk’s existing durable control path into the provider-neutral state and command contract for a complete core video conference. It preserves the current Postgres authority, exact revision chain, stable receipts, digest-checked recovery, bounded transport, and optimistic client loop, while replacing operation-shaped durable commands with absolute targets and adding the missing admission, role, moderation, recording, media-control, and Session-lifecycle surfaces.

The boundary is hexagonal. `SyncEngine` and `MediaPlane` are independent ports, and provider-specific behavior lives only in adapters. Postgres is the sole durable authority for Session policy, participant lifecycle, roles, desired control state, command receipts, lifecycle and external-operation intents, recording projections, and exact control history. `MediaPlane` executes and observes actual microphone, camera, and screen publications. `SyncEngine` enforces current capabilities, serializes shared live rights, distributes provider-neutral live projections, and repairs clients. The SDK combines those projections into one internally consistent `SessionSnapshot` without treating an adapter or local replica as authority.

Chalk has no production v2 clients, so this is a clean replacement. Production v2 admission remains disabled, v3 uses `/v3/sync`, and v2 is removed after v3 passes equivalent local and staging proofs.

## Done and stopping point

The work is done only when a real v3 client can complete the core conference workflows through the public SDK and every authoritative outcome is proven across a real Postgres database, a provider-neutral MediaPlane test adapter, multi-node sync, reconnect, process failure, and a browser verification surface.

The completed surface includes:

- local microphone, camera, and single-participant screen sharing;
- raised-hand and Session display-name state;
- `open`, `approval`, and `closed` admission;
- host, cohost, and participant roles backed by server-evaluated capabilities;
- host transfer and the immutable per-Session host-exit policy;
- microphone, camera, screen-share, and removal moderation;
- consent-safe requests to unmute or start a camera, with no remote force-on operation;
- one active Recording per Session with start/stop and observable process status;
- explicit Leave, tenant recovery, maximum-duration expiry, and end-for-all;
- declarative recovery for durable control plus correct latest-state behavior for live projections;
- deterministic convergence and external-operation reconciliation under injected faults.

The implementation stops after those workflows and proofs. Chat, reactions, transcripts, files, whiteboard semantics, layout, device selection, output volume, background effects, caption visibility, webinar roles, per-participant capability overrides, pause/resume recording, multiple concurrent screen shares, moderator renaming, and production deployment remain out of scope.

## Architecture and sources of truth

The same Session appears through four authorities, each with one job:

| Concern | Authority | Recovery contract |
| --- | --- | --- |
| Session policy, participant lifecycle, display names, host/cohost assignment, hand state, admission, recording projection, moderation facts, receipts, and lifecycle/external-operation intents | Postgres through the Session Stateholder transaction boundary | Exact control replay when serviceable, otherwise digest-checked snapshot; terminal recovery after Session or participant end |
| Actual microphone, camera, and screen publications | Installed `MediaPlane` adapter behind the provider-neutral port | Observe a fresh provider-neutral publication snapshot; never replay stale track history |
| Connection, speaking, active-speaker, and current availability | Live coordination/presence projection | Replace with the latest bounded snapshot; socket loss expires presence but never changes durable membership |
| Device choice, speaker volume, layout, backgrounds, and caption visibility | Local SDK/application | Local persistence if the application wants it; never enters the shared protocol |

`SyncEngine` owns the protocol and live coordination, not the media implementation. It validates current Session authority before a MediaPlane action, carries low-latency provider-neutral signals, and publishes confirmed outcomes. `MediaPlane` owns media execution and observed publication state, not Session roles or durable policy. Its stable contract has a client-runtime surface for local capture/publication and observation plus a server-control surface for grants, remote stop/removal, and authoritative observation; an adapter may implement those surfaces through different provider SDKs without leaking that split into Chalk’s domain. The Go API owns Session creation, tenant policy, signed admission authority, durable lifecycle producers, maximum-duration scheduling, tenant recovery, and recording orchestration.

The durable authority key remains `{tenant_id, session_id}`. `Room` is the reusable place and never replaces Session in this key. Participant identity is one admitted attendance in one Session; a reconnect preserves that Participant and its generation, while a rejoin creates a new Participant.

## Streams and declarative recovery

V3 makes each subscribed stream declare its own four-question contract instead of hard-coding all behavior as `control`.

| Stream | Client declaration | Version | Recovery |
| --- | --- | --- | --- |
| `control` | Required with nullable `{ revision, state_schema_version, state_digest }` cursor | Durable monotonic revision plus digest | Snapshot, bounded exact replay, up to date, or terminal |
| `media` | Required with no durable cursor | Provider-observed publication snapshot incarnation | Replace from the latest MediaPlane projection, then apply live exact-incarnation changes |
| `presence` | Required with no durable cursor | Disposable projection incarnation | Replace with latest presence; stale entries expire |
| `requests` | Required only for the authenticated participant | No replay cursor | No recovery; requests expire and a missed request is gone |

The language-neutral schema declares these stream policies and bounds. A concrete registry may implement them, but generic callbacks, empty stream modules, or speculative chat/whiteboard implementations are rejected. Every snapshot, replay page, live event, request, queue, and retained reservation remains bounded by count, bytes, and age.

The `media` stream contains provider-neutral publication facts only: participant, source (`microphone`, `camera`, or `screen`), enabled/disabled or publication identity as required by the port, and an incarnation that prevents a stale adapter observation from overwriting a newer one. Each replace snapshot creates a `projection_id` and sequence zero; live changes are exact-next sequence values within that projection, and a new projection ID forces replacement instead of comparing unrelated counters. Presence follows the same disposable projection-ID/sequence rule. Neither projection is a durable reconnect cursor. The streams contain no Cloudflare meeting, participant, track, preset, or token concept.

## Session policy and authority

Session creation fixes the following policy:

- `host_exit_policy` is `require_transfer` or `promote_cohost` and is immutable after creation.
- Role-to-capability mappings for `host`, `cohost`, and `participant` are supplied by the tenant at creation and remain immutable while the Session is active.
- Screen-share concurrency is exactly one active sharer.
- `max_duration` is tenant-selected and bounded by the plan ceiling. Only the tenant control plane may change the resulting deadline, and it may never exceed that ceiling.

`admission_policy` is live durable control state and may be set to `open`, `approval`, or `closed` by a participant whose current capabilities allow it. `open` admits a valid join immediately, `approval` creates a bounded durable `AdmissionRequest`, and `closed` rejects without creating pending work.

There is exactly one host authority in an active Session. The canonical state stores `host_participant_id`; the public `host` role is derived for that Participant. Other participants are `cohost` or `participant`. `setParticipantRole` can select only cohost or participant. `transferHost` is the sole participant command that changes `host_participant_id`; it atomically makes the old host a cohost and the target the host.

A tenant-signed participant token carries `initial_role` and `eligible_roles`. Admission stores the verified eligible set. A role transition is rejected unless the target role is eligible, so a host can delegate authority without overriding tenant-signed limits. The server evaluates capabilities from the Participant’s current role and the immutable Session mapping on every command; clients may use projected capabilities for UI but never authorize themselves.

V3 defines these provider-neutral capability atoms for the core surface: `publishAudio`, `publishVideo`, `publishScreen`, `subscribe`, `raiseHand`, `renameSelf`, `manageAdmission`, `promoteDemote`, `transferHost`, `muteOthers`, `stopVideoOthers`, `stopScreenOthers`, `requestMediaOthers`, `removeParticipant`, `manageRecording`, and `endMeeting`. Session creation rejects unknown, duplicate, or internally inconsistent mappings. `transferHost` is additionally restricted to the current host even if another role mapping contains the atom. Tenant recovery uses tenant API authority rather than a participant capability.

## Host exit and abandoned-host behavior

`require_transfer` rejects the sole host’s explicit Leave until host authority is transferred or the Session is ended. `promote_cohost` atomically assigns the longest-tenured active cohost before completing the host’s Leave; admission revision determines tenure and Participant ID breaks a tie. If no active cohost exists, it falls back to `require_transfer`. An ordinary participant is never implicitly promoted.

Socket loss is presence loss and never a durable Leave, even for a host. Host membership does not expire merely because the host stays disconnected, so the same Participant can reconnect and recover authority for the lifetime of the active Session. The meeting and media continue without a connected host, subject to whatever capabilities active cohosts hold.

Liveness comes from two independent durable controls rather than presence-based promotion:

- The tenant control-plane API may transfer host authority to a token-eligible active Participant or end the Session through a stable lifecycle intent.
- The authoritative maximum-duration scheduler emits an idempotent Session-end intent at the current deadline.

## Command taxonomy

Every mutation is classified before entering the contract:

1. **Durable target command.** The actor states an absolute desired value owned by the control fold. If the locked state already matches, the command succeeds as `satisfied` without an event or revision increment.
2. **Live media target.** The actor states an absolute desired local publication value. MediaPlane confirmation completes the operation, but Postgres does not retain crashed-device track state.
3. **Directed live request.** The actor asks another active participant to consider a consent-gated action. Delivery completes the request; it never claims the target media changed and it expires without replay.
4. **Durable external-operation intent.** Moderation, removal, recording, admission, tenant recovery, and end operations cross an authority or side-effect boundary. A stable domain ID guards the external effect, and a bounded durable intent reconciles pending, applied, or failed work.
5. **Local-only command.** Device or presentation preferences never leave the SDK/application boundary.

Toggle, increment, decrement, “next,” and other relative shapes are forbidden on durable or live shared state. Append and external side-effect operations require a stable domain idempotency key. Commands never accept actor identity, actor capabilities, resulting revision, resulting digest, or event name from a client.

## Core action catalog

### Durable participant and Session targets

| Public SDK method | Wire intent | Authorization | Durable result |
| --- | --- | --- | --- |
| `setHandRaised(raised)` | `set_hand_raised { raised }` | Self plus `raiseHand` | `hand_raised` or `hand_lowered`; `satisfied` when unchanged |
| `setDisplayName(displayName)` | `set_display_name { display_name }` | Self plus `renameSelf` | `participant_display_name_changed`; `satisfied` when unchanged |
| `setAdmissionPolicy(policy)` | `set_admission_policy { policy }` | `manageAdmission` | `admission_policy_changed`; `satisfied` when unchanged |
| `setParticipantRole(participantId, role)` | `set_participant_role { participant_id, role }` | `promoteDemote`; target role cohost or participant and token-eligible | `participant_role_changed`; `satisfied` when unchanged |
| `transferHost(participantId)` | `transfer_host { participant_id }` | Current host; target is active and host-eligible | `host_transferred`; atomically swaps host authority |

Display names are Session-scoped, self-controlled, non-empty after surrounding-whitespace validation, valid UTF-8, and bounded to the existing 256-byte limit. Names need not be unique and never alter User, external identity, token subject, or Participant ID. Moderator renaming is absent.

### Live self-media targets

| Public SDK method | Provider-neutral target | Completion |
| --- | --- | --- |
| `setMicrophoneEnabled(enabled)` | Local `microphone` publication desired on/off | MediaPlane confirms observed target or returns a stable retryable/terminal error |
| `setCameraEnabled(enabled)` | Local `camera` publication desired on/off | MediaPlane confirms observed target or returns a stable retryable/terminal error |
| `setScreenShareEnabled(enabled, options?)` | Acquire/release the single share lease and publish/stop `screen` | Lease plus MediaPlane confirmation; no implicit eviction of another sharer |

Local enablement requires the current publish capability and device permission, but DevicePermission remains local and is never confused with Session authority. An already-observed target returns `satisfied`. These operations are safe to retry because they set an absolute target. The SDK does not persist them as durable pending control commands across process death; after reconnect it observes current MediaPlane truth and the application may request a new target.

The single screen-share slot uses a bounded Postgres coordination lease keyed by Session, because node-local state cannot enforce exclusivity across sync nodes. The lease has an owner Participant, stable lease ID, acquisition/renewal deadline, and hard expiry. It is not part of the durable control history or a claim that media exists. A start attempt acquires the lease before publishing, confirms the MediaPlane screen publication, and releases on failure. Confirmed publication loss releases the slot immediately; a reconnecting former sharer must acquire it again. Another start while a valid lease/publication exists returns `screen_share_in_use` and never stops the current share implicitly.

### Directed consent requests

| Public SDK method | Meaning |
| --- | --- |
| `requestUnmute(participantId)` | Ask an active participant to enable their microphone |
| `requestStartCamera(participantId)` | Ask an active participant to enable their camera |

Requests require the corresponding moderation capability, are bounded and rate-limited per actor/target/Session, carry a stable request ID and expiry, and are delivered only to the target Participant’s active connections. Delivery ACK means the request reached an active target connection; expiry, rejection, or no active connection never becomes a media-state fact. Requests are not replayed after reconnect. No command may force a remote microphone or camera on.

### Admission, moderation, recording, and lifecycle intents

| Public/API operation | Durable intent and completion |
| --- | --- |
| `admit(requestId)` | Apply one pending AdmissionRequest, create/activate the Participant lifecycle, and publish `participant_joined` |
| `deny(requestId)` | Terminally mark one pending request denied and publish `admission_denied`; no Participant becomes active |
| `muteParticipant(participantId)` | Revoke/stop the current microphone publication once; succeed only after MediaPlane confirms off, then publish `participant_microphone_stopped` |
| `stopParticipantCamera(participantId)` | Stop the current camera publication once; succeed only after MediaPlane confirms off, then publish `participant_camera_stopped` |
| `stopParticipantScreenShare(participantId)` | Stop the current screen publication and release its lease; succeed only after both are confirmed, then publish `participant_screen_share_stopped` |
| `removeParticipant(participantId)` | Revoke live authority immediately, remove through MediaPlane, finalize durable membership Leave after confirmation, and publish `participant_left` with a bounded reason code |
| `startRecording()` | Reserve a stable Recording ID, durably enter `starting`, start through the recording/provider port, and reconcile to `recording` or `failed` |
| `stopRecording(recordingId)` | Durably enter `stopping`, stop the matching active Recording, and reconcile to `stopped` or `failed` |
| `leave()` | Create the caller’s lifecycle intent; enforce host-exit policy; remove MediaPlane participation; publish the atomic Leave/succession fact |
| `endSession()` | Revoke Session authority, stop/reconcile active media and Recording work, and publish terminal `session_ended` |
| Tenant `transferHost` / `endSession` | Control-plane-only recovery intents authenticated independently of participant capabilities |
| Maximum-duration expiry | Scheduler-generated idempotent end intent for the current deadline generation |

Moderation off is a one-time forced stop, not a durable ban on self-publishing. While a stop intent is pending, SyncEngine installs a bounded source-specific publication fence before calling MediaPlane, so the target cannot race the confirmation by republishing. Finalization removes the fence; a participant who still has the current publish capability may then enable again. Removing or restricting that capability requires a role transition; v3 has no per-participant capability override.

A role or host transition that removes a currently exercised media capability commits the authority reduction and publication fences first, then creates child MediaPlane stop intents. The role event may reach replicas before the terminal command ACK, but the command reports success only after every now-forbidden publication is confirmed off. Provider failure never restores the old authority: the durable role remains reduced, fences remain bounded/reconcilable, and the receipt stays pending or reaches a stable failure that reports incomplete cleanup.

Exactly one Recording may be `starting`, `recording`, or `stopping` for a Session. Start/stop are process commands rather than boolean targets because they create and control a keyed external artifact. Public start resolves after durable acceptance into `starting`; clients observe later `recording` or `failed`. Stop resolves after durable acceptance into `stopping`; clients observe `stopped` or `failed`. V3 does not add pause/resume or composition controls.

## External-operation state machine

No database transaction stays open across a MediaPlane, recording-provider, or other network call. Every externally effective operation uses this bounded state machine:

1. Under the Session authority lock, validate identity, generation, current capability, target facts, and capacity; resolve any matching receipt; persist an idempotent `pending` intent with its canonical fingerprint and any source-specific authority/publication fence required to stop a republish race.
2. Execute the absolute or domain-keyed port operation outside the transaction.
3. On provider-neutral confirmation, reacquire the Session lock, verify the intent generation is still current, mark it `applied`, append the exact-next durable fact when required, update the fold, and finalize the stable receipt atomically.
4. On terminal provider failure, mark `failed` and finalize a rejected receipt. On dependency ambiguity, retain `pending` and reconcile rather than claiming success.
5. If finalization is uncertain, read the intent/receipt through a fresh writable-primary connection and observe or safely retry the idempotent port operation.

An operation that revokes authority, such as removal or Session end, fences new work in the first transaction before waiting on provider cleanup. Success is still reported only after the required external confirmation. A crashed worker cannot leave an unbounded task: pending intents have bounded count/bytes/age, retry schedules, terminal exhaustion policy, and a reconciliation owner that is safe across nodes.

## Durable command receipts and ACKs

The terminal ACK separates delivery history from semantic outcome:

```json
{
  "type": "ack",
  "command_id": "client-generated-stable-id",
  "delivery": "original",
  "outcome": "satisfied",
  "revision": 42,
  "state_digest": "…"
}
```

`delivery` is `original` or `duplicate`. `outcome` is `committed`, `satisfied`, `rejected`, or `command_id_conflict`. A committed control change includes event ID, revision, and resulting digest. A satisfied target has no event ID and identifies the unchanged authoritative head. A matching retry reproduces the original outcome fields exactly with `delivery: duplicate`; an ID reused with a different canonical fingerprint returns conflict.

Satisfied receipts consume bounded receipt capacity and retention but no event capacity. Database constraints encode valid committed, satisfied, rejected, and external-intent field combinations so impossible receipts cannot be stored. Retryable admission or dependency failures are non-terminal and are not persisted as authoritative outcomes unless a durable external intent already exists to reconcile.

## Reducer and event semantics

The pure control reducer returns `change`, `satisfied`, or a stable error for every target command. Events remain past-tense facts, even when commands are declarative. A repeated target with a new command ID receives a satisfied receipt and emits no event; logs record state transitions rather than every request.

Host Leave under `promote_cohost` must be one atomic reducer fact whose payload identifies the departing host and successor, so no replay prefix exposes an active Session with zero hosts. Explicit `host_transferred` similarly changes `host_participant_id` and the old host’s derived role in one event. Lifecycle and external-operation events have exactly one durable origin ID. Every event remains exact-next and carries the resulting state digest.

Replica application accepts only the exact next revision or an identical already-applied duplicate. A gap, conflicting duplicate, schema mismatch, impossible role/host state, or digest mismatch stops live application and enters authoritative recovery.

## SDK behavior

The ergonomic TypeScript surface uses target setters for shared values: `setHandRaised`, `setDisplayName`, `setMicrophoneEnabled`, `setCameraEnabled`, and `setScreenShareEnabled`. It does not retain raise/lower, enable/disable, or toggle aliases in v3. Irreducible actions keep precise verbs: admit, deny, request, mute, stop, remove, transfer, start Recording, stop Recording, Leave, and end Session.

The SDK exposes one `SessionSnapshot` assembled from separately versioned control, media, presence, and local projections. UI components read evaluated capabilities from that snapshot but command calls always reauthorize on the server. Remote Participant media is read-only except through explicit moderation methods.

Durable target commands are persisted before optimistic application. Rebase rewinds to canonical control, discards confirmed work, replays remaining deterministic targets in durable local order, and publishes the optimistic projection. ACK-before-event, event-before-ACK, duplicate-committed, duplicate-satisfied, rejection, retryable failure, recovery, process restart, and expired pending work all have focused tests.

A satisfied ACK removes pending work only after the client proves the named control head. A committed ACK waits for its event or recovery proof. A terminal rejection removes the pending target, rebases, and exposes a stable failure. Live media targets are not inserted into the durable pending store; their Promise completes from MediaPlane observation and their UI state distinguishes requesting, enabled/disabled, and failed without pretending an optimistic track is real.

V3 uses a new pending-storage namespace. Development-era v2 commands are deleted rather than reinterpreted. Browser and React Native implementations must prove the same bounded persistence and recovery behavior.

## Failure, offline, and race behavior

- Two opposing durable targets serialize under the Session control lock; the later committed decision wins and every replica observes the same exact order.
- Two simultaneous screen-share starts serialize on the Session lease; at most one receives the lease, and failure or confirmed publication loss releases it without waiting for reconnect grace.
- Role demotion races with moderation or recording by locking current authority; a command either validates before the role transition and has a durable accepted intent, or observes the new role and is rejected.
- A role or host transition that revokes an exercised publish capability is durable before cleanup, fences republishing immediately, and withholds terminal success until MediaPlane confirms every required stop.
- Admission policy changes do not retroactively admit or discard existing requests. Requests already pending remain explicitly decidable until their bounded expiry.
- Disconnect never means Leave, never transfers host, and never ends Session membership. Presence and directed requests may disappear; durable control and pending commands recover.
- A Session with no connected host continues. If the host never returns, tenant recovery or maximum-duration expiry provides the only host-authority escape.
- MediaPlane observation always overrides stale client track state. Postgres never claims a camera or microphone remains on after an adapter reports it gone.
- The maximum-duration end intent is generation-fenced so changing the deadline through the tenant API makes an old scheduled task harmless.
- Recording/provider callbacks and reconciliation use stable Recording identity and cannot resurrect a stopped or ended Session process.

Every frame, queue, task set, admission set, receipt set, intent set, lease, recovery page, snapshot, diagnostic buffer, and retained database set has explicit count, byte, and age bounds. Telemetry uses bounded outcome, action-class, stream, and failure-code dimensions; it never uses tokens, tenant/Room/Session/Participant/command/request/Recording IDs, display names, target values, revisions, or raw payloads as dimensions or public log content.

## Deterministic proof

The v3 breaker runs the real schema decoder, reducer, Stateholder adapters, stream recovery planners, receipt/intent reconciliation, MediaPlane fake adapter, frame codec, SDK replica model, and an independent `fold(log)` oracle. One seed controls actors, legal commands, opposing targets, policy variants, admission order, host eligibility, MediaPlane outcomes, delivery schedule, process failure, and supported dependency faults.

The schedule injects:

- duplicate command, lifecycle intent, provider callback, and event delivery;
- ACK-before-event, event-before-ACK, delayed and reordered live frames, and dropped notification hints;
- disconnect during send, after durable acceptance, during external execution, after provider confirmation, before receipt finalization, during replay, and before recovery ACK;
- simultaneous host transfer/Leave, role change/moderation, admission decision/expiry, screen-share acquisition, recording start/stop, and deadline-change/expiry races;
- MediaPlane timeout, confirmed failure, lost response after effect, stale observation, publication loss, and reconciliation after node restart;
- Postgres transaction fault points and independent sync-node loss.

It checks continuously:

- applied control revision never decreases, exact equal revisions have equal digests/state, and every replica converges to `fold(log)` after quiescence;
- one command ID has one fingerprint and one stable original outcome;
- satisfied decisions change no fold, digest, revision, event count, or head notification;
- an active Session has exactly one durable host, and every role is token-eligible;
- at most one valid screen-share lease/publication exists and every abandoned lease expires within its bound;
- no remote force-on command exists or can be encoded;
- applied external-operation receipts correspond to confirmed port outcomes, while ambiguous work remains reconcilable rather than falsely successful;
- Session end is terminal, maximum duration is respected, and stale scheduler generations are harmless;
- all queues, retained sets, tasks, leases, and artifacts stay within declared limits.

A failing artifact records seed, Git revision, contract version, sanitized policy/configuration, and the complete bounded schedule. Replaying it twice must reproduce the same verdict, receipt set, intent states, control digest sequence, and final provider-neutral projection without credentials or private identifiers.

## Implementation checklist and orchestration seams

The implementation should be executed in dependency order. Independent lanes may run in parallel only after the shared v3 schema, state vocabulary, error codes, and storage invariants are fixed.

- [ ] **Phase 1 — Freeze interfaces.** Finalize the language-neutral v3 stream, command, event, receipt, policy, capability, and error schemas; update SDK ubiquitous language and North Star references; define Postgres constraints and provider-neutral MediaPlane operations before server or client implementation branches.
- [ ] **Phase 2 — Durable authority.** Implement migrations, Session policy, host/role/admission/display/hand reducer state, satisfied receipts, external intents, deadline generations, recording projection, and real-Postgres semantic tests. This lane owns database and reducer files.
- [ ] **Phase 3 — Live media coordination.** Implement MediaPlane-facing self-media targets, confirmed moderation, directed requests, single-share leases, live media/presence snapshots, and reconciliation. This lane owns the port boundary and sync live-coordination files, not durable reducer internals.
- [ ] **Phase 4 — API lifecycle.** Implement Session creation policy, signed initial/eligible roles, admission producers, tenant host recovery, maximum-duration scheduler, removal/end fencing, and recording orchestration. This lane owns Go/API files and consumes the fixed schema/intents from Phases 1–2.
- [ ] **Phase 5 — SDK runtime.** Implement v3 codec, `SessionSnapshot`, target methods, durable optimistic queue, MediaPlane composition, capability projection, and browser/React Native persistence. This lane owns TypeScript client files and consumes the fixed generated contract.
- [ ] **Phase 6 — Breaker and integration.** Extend the deterministic breaker and independent oracle across all action classes, multi-node/Postgres, MediaPlane failures, and process races; add the real browser core-conference flow.
- [ ] **Phase 7 — Remove v2 and close proofs.** Delete v2 route/schema/generated/runtime/storage surfaces after equivalent v3 tests pass; run all focused and repository gates, one bounded top-level code review, staging-only canary proofs, and document any unavailable production proof as not done.

One implementation agent owns each file set. Every implementation spawn uses `agent_type: default`, model `gpt-5.6-sol`, reasoning effort `high`, service tier `standard`, and `fork_turns: none`; no implementation lane uses Luna. The parent provides a self-contained brief, fixes shared interfaces before parallel work, integrates cross-lane seams, reads authority/security changes line by line, and runs the final end-to-end proof. At most three implementation agents run concurrently because the parent occupies the fourth slot. A separate advisor may critique authorization, external-effect reconciliation, and invariants but does not implement. Implementation agents do not spawn agents, run `codex review`, edit another lane’s files, or invent schema changes locally; a required interface change returns to the parent before dependent work continues.

## Verification gate

Focused automated tests must cover every command’s valid, satisfied, unauthorized, invalid, capacity, duplicate, ID-conflict, retryable, and terminal paths; every immutable policy rule; every host-exit branch; token-eligible promotion; admission races; exact role/host reducer invariants; single-share lease acquisition/expiry; MediaPlane confirmation and ambiguity; directed-request delivery/expiry; recording state transitions; maximum-duration generations; snapshot/replay/live recovery; pending-store rebase; and privacy-safe diagnostics.

End-to-end proof requires observing all of the following:

- Apply and verify every migration against the real isolated sync Postgres database, including receipt, intent, lease, host, policy, and deadline constraints.
- Drive a real `/v3/sync` socket through changed and already-satisfied hand, display-name, admission-policy, and role targets; verify satisfied targets create receipts without events or revision/digest changes.
- Exercise all three admission policies, token-eligible promotion rejection/acceptance, explicit transfer, both host-exit policies, tenant recovery, disconnected-host reconnect, and maximum-duration end.
- Exercise microphone and camera on/off, single screen-share contention and loss, consent requests, confirmed remote microphone/camera/screen stop, removal, and adapter ambiguity through a provider-neutral MediaPlane test adapter.
- Start and stop one Recording, reject a concurrent start, and observe starting/recording/stopping/stopped plus failed/reconciled paths.
- Kill and restart clients, sync nodes, intent workers, and the MediaPlane fake at the specified fault points; recover without acknowledged control loss, false moderation success, stuck leases, or duplicate external effects.
- Run independent multi-node Postgres tests with dropped notifications and authoritative repair; run and replay the seeded breaker matrix.
- Load the local browser conference surface and observe optimistic durable targets, real media-confirmation states, admission, role changes, host transfer, moderation, recording, reconnect overlay, rollback, Leave, and Session end.
- Run contract generation checks, SDK focused tests, `apps/api/scripts/gate.sh`, `apps/sync/scripts/gate.sh`, and root `pnpm run gate`; then run the single bounded top-level automated code review and fix actionable findings within the allowed pass count.

Production deployment is not part of this spec. Any provider smoke test or staging canary requires the exact non-production target and must leave no temporary resources. The status remains not done until every required proof above has been observed; unavailable database, browser, MediaPlane, multi-node, mobile-runtime, staging, or gate evidence is named exactly.

## Non-goals and anti-slop rules

- Do not reference RealtimeKit, Cloudflare SFU, provider meeting IDs, tracks, tokens, presets, or callbacks outside adapter code and opaque adapter metadata.
- Do not make MediaPlane publication state a durable control-log truth, and do not enforce the single-share rule with node-local memory.
- Do not turn socket loss into Leave, host promotion, or Session end.
- Do not allow a role outside signed `eligible_roles`, per-participant capability overrides, moderator renaming, or live mutation of role mappings or host-exit policy.
- Do not force a remote microphone or camera on, infer consent from a capability, or report moderation success before MediaPlane confirmation.
- Do not emit events for satisfied targets, increment revision to acknowledge requests, or treat event history as a request audit log.
- Do not combine chat, reactions, transcripts, files, whiteboard, local devices, layout, or display preferences into the control fold.
- Do not retain compatibility shims, mixed-version negotiation, action-shaped setter aliases, or the v2 pending namespace for an unpublished protocol.
- Do not introduce unbounded work, generic framework abstractions without a concrete v3 consumer, or localhost-only evidence presented as production readiness.

## Settled decisions

- Core conference scope includes media, screen share, hand state, admission, roles/capabilities, moderation, recording, Leave, tenant recovery, and Session end; collaboration streams remain separately owned.
- Public and wire setters are target-shaped. Irreducible lifecycle, consent request, append, and external-process operations remain precisely named and idempotent.
- Roles are host, cohost, and participant presets over immutable per-Session capability mappings. Tokens carry initial and eligible roles; promotion stays inside the signed eligible set.
- Admission is `open | approval | closed`. There is one screen sharer. Participants may rename only themselves. Moderators may stop remote microphone, camera, or screen media and request consent-gated restart, but never force capture on.
- `host_exit_policy` is immutable `require_transfer | promote_cohost`. Presence loss never expires host membership; tenant recovery and the plan-capped maximum duration provide liveness.
- Only the tenant control plane may change the Session deadline. Every Session has a maximum duration.
- Cross-participant media moderation and MediaPlane-backed removal succeed only after provider-neutral confirmation. Recording exposes keyed asynchronous process state.
- Postgres remains the sole durable authority, MediaPlane remains swappable, SyncEngine remains swappable, and the SDK composes their provider-neutral projections.
- V3 uses `/v3/sync`; unpublished v2 is disabled and removed without a compatibility window.
