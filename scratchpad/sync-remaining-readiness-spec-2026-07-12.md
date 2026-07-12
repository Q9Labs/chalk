# Chalk Sync Remaining Production Readiness Specification

**Status:** Approved direction; implementation and acceptance evidence pending  
**Decision owner:** Hasan Shoaib  
**Scope:** Production token integration and release-topology failure scheduling  
**Supersedes:** Conflicting sync authority and token language in earlier infrastructure notes

## Readiness Verdict

Chalk Sync is not production-ready until both launch-gate items in this document
have executed successfully and their evidence has been retained.

| Gap                                 | Decision                                                                                                                 | Launch-gate disposition                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Production token integration        | The Go API issues short-lived JWTs from one environment-specific asymmetric platform keyset. Sync verifies them locally. | Blocking until an issued token passes through the packaged production release and every negative case fails closed. |
| Release-topology failure scheduling | A versioned external orchestrator schedules failures around the deterministic breaker and real clients.                  | Blocking until every required schedule passes and produces a complete evidence bundle.                              |

Legacy-data migration, PostgreSQL standby promotion/PITR, and load/soak targets
are excluded by decision. They do not affect the readiness verdict defined by
this document. The final readiness report must disclose these exclusions so the
claim cannot be mistaken for evidence in those areas.

Production deployment and production mutation are outside this specification.
Every launch proof runs against staging or an isolated local environment. A
production action still requires explicit approval in its active thread.

## Product Intent

The remaining work should prove that production identity reaches the sync
boundary and that the packaged release recovers under scheduled topology
failures.

PostgreSQL remains the sole durable authority for Session control state, exact
event history, command receipts, lifecycle intents, and retention checkpoints.
Redis is not part of sync correctness. This specification supersedes the
Redis-Stateholder contract in the existing infrastructure readiness
specification. Before launch proof begins, every governed launch document and
manifest must describe PostgreSQL as the sync authority.

## Non-goals

- Legacy-data migration or populated-data backfill.
- PostgreSQL standby promotion, managed failover, backup, restore, or PITR
  proof.
- Load-envelope qualification or soak testing.
- Per-tenant signing keys or third-party-issued sync tokens.
- Online token introspection on the WebSocket admission path.
- A multi-region database or application deployment.
- Extending the deterministic breaker with provider-control responsibilities.
- Running destructive drills against production.

## Canonical Terms and Authority

- **Release topology:** the packaged production release,
  production-equivalent app node class and configuration, configured database,
  Cloudflare ingress, telemetry exporters, and real WebSocket clients in
  staging.
- **Evidence bundle:** immutable manifest, timestamps, release and configuration
  digests, fault schedule, metrics, logs, invariant verdict, and reproduction
  instructions for one acceptance run.
- **Acknowledged write:** a command whose stable committed receipt was returned
  to the caller before an injected failure.
- **Issuer:** the Go API. No client, web application, or sync node signs tokens.
- **Verifier:** the Elixir sync release, which validates the JWT locally.

## Production Token Integration

### Contract

The Go API owns a dedicated sync-token endpoint behind normal authenticated
tenant and Session authorization. It issues an EdDSA JWT signed with Ed25519.
The verifier allows only that algorithm, rejects an unknown or duplicate `kid`,
rejects unsupported critical headers, and performs no algorithm selection from
untrusted token content.

The JWT contains:

- a fixed environment-specific `iss` value;
- a sync-specific `aud` value;
- `sub` bound to the participant-session identity;
- `tenant_id`, `room_id`, `session_id`, `participant_id`,
  `participant_session_id`, and `participant_session_generation`;
- the admission lifecycle intent identifier required by protocol v2;
- bounded capabilities derived by the API, never copied from client input;
- `iat`, `nbf`, `exp`, and a unique `jti`;
- a `kid` selecting the active key.

Every identity claim has one exact string or UUID representation shared by the
Go and Elixir contract. Issuer and audience comparisons are exact. Tokens have
a maximum lifetime of five minutes. Sync allows at most 30 seconds of clock
skew and requires `nbf` and `iat` no later than now plus that skew and `exp`
later than now minus that skew.

Clients refresh before expiry through the authenticated API and use the
existing `rejoin_required` recovery path. Token expiry prevents new admission
and refresh; it does not rewrite an already committed lifecycle decision.

The client sends the token only in the v2 hello frame over WSS. API responses,
proxies, drivers, traces, logs, metrics, errors, and artifacts redact the token
before serialization.

The signing keyset is scoped per environment. Private keys exist only in the
API runtime secret boundary. Sync receives public keys through rendered release
configuration. Launch adds no network lookup to token verification.

Rotation publishes the new public key before issuance begins. The API then
signs with the new `kid`; sync accepts both keys for at least the maximum token
lifetime plus clock skew; the old public key is removed afterward. Unknown
`kid`, wrong issuer or audience, expired or not-yet-valid token, invalid
signature, missing identity, malformed capabilities, or mismatched route
identity fails closed without opening a subscription.

### Acceptance

- A real API-issued token enters the packaged production release through the v2
  WebSocket route and reaches an authorized, lifecycle-admitted Session.
- The production release refuses the development verifier and refuses boot
  without a non-empty public keyset and issuer/audience configuration.
- Every negative case above is automated at the API, verifier, and real-wire
  boundary.
- Rotation overlap is exercised with an existing connection, a reconnect using
  the old key, a new token using the new key, and final rejection after the old
  key leaves the accepted set.
- No token, signing key, raw identity, or reusable secret appears in logs,
  metrics, traces, breaker artifacts, or the repository.

## Release-Topology Failure Scheduling

A versioned external orchestrator owns provider and process control. The
deterministic breaker remains responsible for commands, receipts, recovery,
folds, replicas, and invariant verdicts. The orchestrator records monotonic and
wall-clock timestamps and emits every scheduled and observed transition into
the same evidence bundle.

The launch campaign schedules at least:

1. SIGTERM and graceful replacement of the sync release under accepted work.
2. Unclean sync process termination and supervisor/release restart.
3. Complete app-node replacement with client reconnect and database authority
   preserved.
4. PostgreSQL notification loss long enough to require authoritative head-read
   repair.
5. Database connection interruption before transaction, during transaction,
   immediately before commit, and after commit before reply.
6. A slow or non-reading peer and an unacknowledged recovery page while healthy
   peers continue.
7. Telemetry exporter unavailability to prove bounded buffering or drop
   behavior without hiding readiness or correctness evidence.

Database connection interruption exercises application recovery only. It makes
no standby-promotion, managed-failover, backup, restore, or PITR claim.

Each event has a declared trigger, duration, expected readiness state, expected
client-visible outcome, recovery deadline, and invariant set. A schedule is
invalid if the injection did not occur, its observation is ambiguous, required
telemetry was absent, the topology differed from the manifest, or cleanup was
incomplete. Random timing may supplement these schedules but cannot replace
the deterministic launch evidence.

The full campaign runs before launch and after a material change to sync
protocol, authority transactions, release topology, failure orchestration, or
client recovery. It runs at least quarterly after launch.

## Evidence and Release Gate

Every acceptance bundle identifies the clean commit, unique release artifact,
container or image digest where applicable, protocol version, environment and
topology digests, sanitized configuration, token key IDs without key material,
client and orchestrator versions, schedule, start and end times, metrics,
invariant verdict, and cleanup result.

Any harness error, skipped injection, missing artifact, stale release, dirty
source evidence, unresolved command, failed invariant, or unverified cleanup
fails the gate. Raw artifacts remain ignored and private; the repository
receives a redacted coherent readiness report.

Completion requires the focused API and sync gates, the root gate, real browser
verification, the packaged-release token proof, and the integrated failure
campaign. Nontrivial implementation receives the required automated code
review. Failing tests may not be deleted, skipped, or weakened.

## Implementation Phases

1. **Reconcile authority and readiness documents.** Replace stale
   Redis-authority language with the PostgreSQL authority. Remove legacy-data
   migration, PostgreSQL promotion/PITR, and load/soak qualification from the
   governed sync readiness gate.
2. **Wire production identity.** Add API issuance, Elixir verification,
   production configuration, rotation, negative tests, and packaged real-wire
   proof.
3. **Build the topology orchestrator.** Reuse canonical breaker invariants while
   scheduling and observing release-topology failures.
4. **Execute the launch gate.** Run token, failure, browser-recovery, focused,
   root-gate, and automated-review proofs from clean pinned artifacts.
5. **Publish the binary report.** State production-ready only when both
   launch-blocking items pass. State that legacy migration, PostgreSQL
   promotion/PITR, and load/soak qualification were excluded by decision.

## Done

This specification is implemented only when the production-readiness report
can cite passing evidence for both launch-blocking acceptance items. Writing
code or producing a release artifact without the token and integrated failure
proofs does not satisfy readiness.
