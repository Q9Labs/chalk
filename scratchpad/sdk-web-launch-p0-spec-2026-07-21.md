# Managed web SDK launch P0 specification

**Project:** Chalk
**Date:** 2026-07-21
**Status:** implementation complete; release proof pending
**Source audit:** `scratchpad/sdk-web-launch-implementation-board-2026-07-20.md`

The repository P0 implementation is complete and the canonical full gate passes. Production go-live is not complete: the current task does not authorize a deployment or live Cloudflare verification, and Firefox/WebKit smoke coverage must still pass in CI. NPM publication and its token repair remain release plumbing after those proofs.

## Background

Chalk already has a production-shaped Sync v3 engine, participant lifecycle persistence, generated API contracts, Cloudflare SFU control-plane signaling, a browser WebRTC adapter, React presentation components, and an npm package. These pieces pass their current focused tests, but a customer cannot yet install the SDK, authenticate a backend with a Chalk API key, hand a browser safe participant credentials, and run one durable meeting object through join, media changes, reconnect, and Leave.

The current web room proves the lower layers by manually wiring them together. It exposes tenant authority to browser configuration, constructs development credentials, owns Sync and media independently, and cannot represent the complete lifecycle as one consumer-facing contract. That is useful development evidence, but it is not a safe SDK launch path.

The desired state is a managed web SDK in which a customer backend holds one scoped Chalk API key, creates or admits a participant, and returns a short-lived participant access bundle to the browser. A framework-free `ChalkSession` owns media, Sync, credential refresh, recovery, diagnostics, and teardown. React only projects that session. A clean consumer fixture installs packed artifacts and proves the complete flow in two real browsers without source-tree imports or tenant secrets.

## Definition of done

This specification is complete only when all of the following are observed in the current repository state:

- [x] A raw `chalk_sk_…` key can be created once, used from a customer backend, scoped to one tenant, rotated, listed without its secret, and revoked.
- [x] Participant admission and refresh issue distinct short-lived Sync and media credentials; neither credential grants tenant authority.
- [x] Cloudflare SFU signaling accepts the media credential only when its audience and tenant, room, session, participant, and generation claims match the route and live participant.
- [x] The TypeScript server entry point provides Promise-based room, session, admission, access-refresh, and end-session methods without exposing Effect or entering browser bundles.
- [x] The Cloudflare SFU browser adapter refreshes credentials per request, reconciles authoritative remote publications, supports screen sharing, reports connection failure, can be rebuilt, and completely tears down owned resources.
- [x] One `ChalkSession` owns permission, media, Sync v3, refresh, reconnect, public meeting methods, diagnostics, and durable Leave.
- [x] React exposes a provider and hooks over `ChalkSession` without owning networking, credentials, WebRTC, or lifecycle behavior.
- [x] The first-party web room uses only the public SDK surfaces and contains no tenant bearer, token signer, development token constructor, or direct media/Sync orchestration.
- [x] Durable participant Leave reaches `left` through an authenticated Sync-to-API provider bridge that closes active Cloudflare publications before finalization; a missing bridge cannot remain hidden behind green readiness.
- [x] A clean packed-artifact fixture proves two isolated Chromium contexts exchanging audio/video, one screen-share cycle, remote removal, credential refresh, forced Sync recovery, forced SFU recovery, denied access, and Leave with no live tracks, sockets, or timers.
- [x] The public quickstart reproduces the verified backend and browser flow, with recording and React Native explicitly outside this launch contract.
- [x] Focused API, Sync, TypeScript, React, and web tests pass; API performance profiling passes; `pnpm run gate -- --full` passes; the bounded Codex review has no unresolved blocker or major finding.

Release proof remains deliberately separate from repository completion:

- [ ] Firefox and WebKit smoke flows pass in CI using packed artifacts.
- [ ] An explicitly authorized production deployment proves the real Cloudflare path and deployed revisions end to end.
- [ ] The scoped packages publish successfully after the NPM token is repaired.

NPM publication is release plumbing after these checks. Production deployment and production-secret changes require separate explicit approval and are not authorized by this specification.

## Scope

### In scope

- Managed web SDK on modern Chromium, Firefox, and Safari-compatible WebRTC APIs.
- API-key authentication and lifecycle for customer backends.
- Browser-safe participant access for Sync v3 and Cloudflare SFU.
- Promise-based server SDK, framework-free browser session, React bindings, first-party web proof, diagnostics, quickstart, and packed-artifact end-to-end proof.
- Camera, microphone, screen sharing, participant state, admission/moderation methods already supported by Sync v3, reconnect, Leave, and session end.

### Non-goals

- Recording and transcription surfaces.
- React Native launch readiness.
- Alternative self-hosted SFU adapters.
- Production deployment, account changes, customer migration, or npm publication.
- Rewriting Sync v3 or moving meeting behavior into React or the demo app.

## Canonical language and source-of-truth rules

| Term               | Meaning and owner                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant API key     | A long-lived, tenant-scoped server credential. The Go API and `api_keys` table own it. It never enters a browser response, bundle, log, trace, metric, fixture, or example.  |
| Participant access | One short-lived bundle containing independent Sync and media credentials plus provider bootstrap data. The Go API owns issuance; the browser treats it as replaceable input. |
| Sync credential    | An Ed25519-signed participant credential with the Sync audience. Only Sync v3 accepts it.                                                                                    |
| Media credential   | An Ed25519-signed participant credential with the media audience. Only participant-bound SFU signaling accepts it.                                                           |
| `ChalkSession`     | The framework-free browser meeting runtime and sole owner of lifecycle state.                                                                                                |
| Snapshot           | The synchronous, immutable public view of the current session state. React subscribes to this view.                                                                          |
| Durable Leave      | The Sync v3 participant Leave operation and acknowledgement. Socket loss is not Leave.                                                                                       |

The API owns authorization and credential truth. Sync owns replicated meeting truth. The media adapter owns observed WebRTC truth. `ChalkSession` composes those truths without manufacturing success. React and apps render them without becoming new authorities.

## Public contract

### Server boundary

The package exports a server-only entry point:

```ts
import { createChalkServerClient } from "@q9labsai/chalk-client/server";

const chalk = createChalkServerClient({
  apiKey: process.env.CHALK_API_KEY!,
  tenantId: process.env.CHALK_TENANT_ID!,
  apiBaseURL: "https://api.chalk.video",
});

const room = await chalk.rooms.create(input);
const session = await chalk.sessions.create(room.id, input);
const admission = await chalk.participants.admit(room.id, session.id, input);
const access = admission.access;
await chalk.sessions.end(room.id, session.id, input);
```

The entry point accepts an API key, attaches it only to server requests, maps generated errors to a stable `ChalkAPIError`, and is guarded from browser and React Native bundles.

`participants.issueAccess` is a refresh operation for the same persisted live participant and generation; callers do not invoke it immediately after admission. Ordinary refresh supplies the current signed media credential so Chalk can verify and reuse its exact provider connection. Explicit SFU recovery requests replacement access, which creates a new provider connection instead of trusting a caller-supplied connection ID. A customer access endpoint authenticates its own application user, resolves the permitted participant from server-side state, and never trusts meeting identity values supplied by the browser.

### Participant-access wire shape

```ts
type ParticipantAccess = {
  readonly subject: {
    readonly tenantId: string;
    readonly roomId: string;
    readonly sessionId: string;
    readonly participantSessionId: string;
    readonly participantGeneration: number;
  };
  readonly sync: {
    readonly token: string;
    readonly expiresAt: string;
  };
  readonly media: {
    readonly token: string;
    readonly expiresAt: string;
    readonly provider: "cloudflare_sfu";
    readonly clientPayload: CloudflareSFUBootstrap;
  };
};
```

Sync and media credentials use different audiences and cannot substitute for one another. Both expire within five minutes. A refreshed bundle must preserve the same live participant subject and may replace provider bootstrap data.

Both credentials have an exact five-minute lifetime, permit at most 30 seconds of clock skew, and are refreshed when 60 seconds or less remain. Media verification accepts a configured `kid` keyset containing current and previous public keys; an outgoing key remains accepted for at least five minutes and 30 seconds.

### Browser boundary

```ts
const session = new ChalkSession({
  access: () => fetch("/api/chalk/access").then(requireParticipantAccess),
  syncURL: "wss://sync.chalk.video/v3",
  apiBaseURL: "https://api.chalk.video",
});

await session.join();
await session.setMicrophoneEnabled(false);
await session.setCameraEnabled(false);
await session.startScreenShare();
await session.stopScreenShare();
await session.leave();
```

`join()` and `leave()` are concurrency-safe and idempotent. Every command resolves only after the owning lower layer confirms the requested result or rejects with a stable error. The root browser surface exposes Promises and plain types, not Effect.

### React boundary

```tsx
<ChalkProvider session={session}>
  <Meeting />
</ChalkProvider>
```

The launch hooks are `useChalkSession`, `useChalkSnapshot`, `useParticipants`, `useLocalMedia`, `useRemoteMedia`, and `useChalkActions`. Hooks subscribe and select; they do not fetch access, open sockets, create peer connections, or issue lifecycle operations independently.

## Required behavior

### API-key lifecycle

Raw keys use `chalk_sk_<prefix>.<secret>` and are returned only from create or rotate. Storage contains the prefix and SHA-256 hash, never the raw key. Authentication performs an indexed prefix lookup, constant-time comparison, expiry and revocation checks, usage attribution, and construction of an `authentication.PrincipalAPIKey` with concrete scopes.

For the launch contract, rotation invalidates the previous key immediately because the existing table stores one prefix and hash. Create requires an explicit expiry no more than 365 days in the future; rotation preserves the existing expiry unless the request supplies a new valid expiry. Tenant owners and admins can bootstrap and manage keys through user Sessions. An API-key caller must hold the operation's `api_keys:*` scope and may create, rotate, or revoke only keys whose scopes are a subset of its own scopes; rotation never changes scopes. Last-used attribution is best-effort after successful authentication: a failed touch is observable but does not turn a valid request into an authentication failure.

Create accepts `{ name, scopes, expires_at }`; rotate accepts `{ expires_at? }`; both return key metadata and one new raw secret. List is cursor-paginated and returns metadata including the prefix, never the raw secret or hash. Revoke returns no body. The secret is 32 cryptographically random bytes encoded as unpadded base64url, the independently generated prefix is collision-retried, and the hash covers the complete canonical raw credential. Create and rotate are not automatically retried by the Promise client because a lost one-time-secret response cannot be replayed.

The routes are:

- `POST /v1/tenants/{tenant_id}/api-keys`
- `GET /v1/tenants/{tenant_id}/api-keys`
- `POST /v1/tenants/{tenant_id}/api-keys/{api_key_id}/rotate`
- `DELETE /v1/tenants/{tenant_id}/api-keys/{api_key_id}`

Creation and rotation require `api_keys:write`, listing requires `api_keys:read`, and revocation requires `api_keys:delete`. User-session owners and admins may grant any non-empty, duplicate-free subset of `authentication.AllScopes`. A recognized `chalk_sk_` value never falls through to user-session authentication. Cross-tenant, wrong-scope, expired, revoked, malformed, and unknown keys fail with constant-shape responses. Credentials and hashes are absent from observability.

### Participant access and SFU authorization

Successful admission returns `ParticipantAccess`. A tenant-authenticated access route reissues a bundle for a persisted live participant and requires the expected participant generation. For ordinary refresh, the request includes the current signed media credential; the API verifies its route subject and reuses the credential's exact connection. For SFU recovery, the request explicitly requests replacement and the API creates a fresh provider connection. The API never signs an arbitrary caller-supplied existing connection ID. The media token has an explicit media audience and exact subject claims. SFU track, renegotiation, and publication routes authenticate that media token before any tenant lookup or provider call, then confirm the route subject and live participant generation.

Media credentials are route-scoped and never become an `authentication.Principal`, satisfy general authentication, or reach non-media routes. An explicit participant-media contract verifies algorithm, key ID, signature, issuer, exact audience, time, complete participant subject, provider, and Cloudflare connection ID before installing a dedicated typed context. Tracks, close, and renegotiation requests must use that same connection. Rate limiting uses verified tenant and participant IDs.

Media tokens cannot call Room, Session, participant lifecycle, moderation, recording, or Sync routes. Sync tokens cannot call SFU routes. Invalid signature, wrong audience, expiry, route mismatch, generation mismatch, removed participant, and cross-tenant access fail before Cloudflare receives a request.

### Cloudflare SFU adapter

Every signaling request asks an async credential provider for the current media token. The adapter publishes immutable snapshots covering lifecycle, peer state, ICE state, local publications, remote publications, and the latest stable failure code.

Remote publication snapshots are authoritative. Each participant/source has at most one publication. Within one incarnation only non-decreasing sequences apply; a newer incarnation replaces prior state. Removal or replacement stops and deletes the old remote track and allows the replacement to be pulled. Screen sharing prepares and publishes a distinct `screen` sender and stops it cleanly. Peer or ICE failure becomes a recoverable adapter failure so `ChalkSession` can obtain fresh access, build a new adapter, restore prepared local tracks, and return to live only when both media and Sync are healthy.

The API exposes a participant-media-authenticated idempotent close-tracks route that proxies Cloudflare's close operation and records the affected publication as `enabled=false` with no publication ID. Provider “already absent” is success; a retry after provider success must finish the registry update without republishing. Local media keeps any provider publication reference internally, but the V3-facing projection emits `publicationId: null` whenever disabled. Re-enabling publishes a new provider track and ID. Screen video is in scope; independent screen audio is not part of the current one-source contract.

Sync finalizes durable Leave only after the media provider has confirmed cleanup. Production Sync calls a separate private API listener over TLS 1.3 mutual authentication; the client certificate carries the configured environment's Sync SPIFFE identity. The listener is never mounted on the public API router. Its Cloudflare SFU executor reads the authoritative publication observation, closes the exact active MID values grouped by provider connection, records each publication disabled, and treats an already-clean participant as satisfied. Missing or unreachable bridge configuration fails Sync readiness instead of leaving operations pending behind a healthy probe. Each operation propagates its journey and W3C trace ancestry with bounded outcome metrics.

`stop()` is idempotent and clears polling, subscriptions, transceivers, senders, owned local tracks, remote tracks, credentials, and the peer connection.

### `ChalkSession` lifecycle

The public states are `idle`, `joining`, `live`, `reconnecting`, `leaving`, `left`, and `failed`. Constructor options include initial microphone and camera intent, both enabled by default. `join()` requests only those tracks before calling the access provider, so permission denial creates no participant. After access, Sync and media may start concurrently. A later startup failure attempts durable Leave before teardown; if Sync never authenticates or Leave is not acknowledged within five seconds, local cleanup completes and join rejects with `join_cleanup_unconfirmed`.

Sync and media startup may proceed concurrently only after access and local permission succeed. The session becomes `live` when both are healthy. A Sync reconnect refreshes access when the cached Sync credential is near expiry. A dead SFU peer refreshes access and rebuilds media without changing durable membership. Recovery is single-flight, increments a runtime epoch, and ignores completions from older epochs. The default retry budget is three attempts within ten seconds with injectable clock and backoff. Retry exhaustion moves to `failed` with a stable diagnostic code.

`join()` while joining returns the same Promise, while live resolves immediately, and while leaving rejects `invalid_state`; idle, left, and fully cleaned failed states may start again. `leave()` while joining cancels and waits for cleanup; live, reconnecting, and failed states share one Leave Promise; idle and left resolve immediately. Leave unsubscribes observers, sends and awaits durable Sync Leave for up to five seconds, stops Sync, stops SFU, stops owned tracks, clears timers and credentials, and publishes `left`. A timeout publishes `left` with `leave_unconfirmed`, completes local teardown, and rejects the Leave Promise. Socket loss never calls Leave and never changes durable membership. Each screen-share start requests a new video-only display track; the browser-ended event uses the same stop path as an explicit call.

### Diagnostics and observability

All HTTP requests propagate `x-chalk-journey-id`, `traceparent`, and `tracestate`. API-key authentication records bounded success/rejection class and latency without key prefix, raw key, hash, scopes-as-free-text, IP, or request body. Participant-access issuance and rejection expose bounded audience/failure attributes without token material. SFU and session diagnostics expose lifecycle transitions, retry counts, peer/ICE summaries, and cleanup completion without SDP, media contents, display names, or credentials.

The execution trace harness includes one API-key-authenticated customer flow and one rejected-scope flow. The local observability proof exercises a successful participant-access/SFU authorization path and a wrong-audience rejection.

API-key create, rotate, and revoke emit durable audit records for success and authorization failure using the repository's existing mutation-audit policy. Records contain tenant, actor kind and identifier, action, target key identifier when known, and a bounded outcome; they never contain the raw key, hash, prefix, body, or free-text scopes.

## Failure behavior

| Failure                                            | Required outcome                                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| API key malformed, unknown, expired, or revoked    | `401`; no session-auth fallback; no resource lookup.                                                                   |
| API key valid but wrong tenant or scope            | `403`; no domain mutation.                                                                                             |
| Participant access wrong audience or route subject | `401` or `403` according to the existing API contract; no Cloudflare call.                                             |
| Access provider unavailable during initial join    | Join fails and releases permission tracks, sockets, peer connections, timers, and cached credentials.                  |
| Sync drops                                         | Session enters `reconnecting`, preserves durable membership, refreshes as needed, and rejoins within its retry budget. |
| SFU peer or ICE fails                              | Session enters `reconnecting`, rebuilds the adapter with fresh media access, and reconciles publications.              |
| Remote publication disappears                      | Remote track stops and disappears from the next snapshot.                                                              |
| Screen-share track ends from browser chrome        | Screen publication is stopped, Sync target is reconciled, and the session remains live.                                |
| Leave acknowledgement times out                    | Local teardown still completes; the result exposes a stable timeout diagnostic.                                        |

## Implementation phases and orchestration

Workers are not alone in the codebase. Each worker owns only the listed files, must preserve concurrent edits, must not revert or reformat unrelated work, and must not commit.

### Phase 1 — Contract freeze

- [x] Primary agent owns shared `ParticipantAccess`, session snapshot, error vocabulary, package exports, and generated-contract integration decisions.
- [x] Type-only tests prove the root browser import contains no Effect type and invalid mixed credential shapes do not compile.

### Phase 2 — Independent foundations, parallel

- [x] API-key worker owns new `internal/apikeys`, `db/queries/api_keys.sql`, generated sqlc API-key files, the Postgres adapter slice, focused tests, and new `httpapi/api_keys.go`. It does not edit shared middleware, router, contracts, or `cmd/main.go`.
- [x] Participant-access worker owns new `internal/participantaccess`, its focused tests, and signing/verification changes that can be isolated from shared HTTP files. It does not edit shared middleware, router, contracts, session lifecycle, SFU signaling, or `cmd/main.go`.
- [x] SFU worker owns `sdks/typescript/client/src/media/**` and focused SDK tests. It does not edit Go, generated code, React, or app files.

### Phase 3 — Shared API integration

- [x] Primary agent exclusively owns shared router, middleware, composition root, endpoint aggregation, package export maps, root indexes, and aggregate generated files; workers never edit those files concurrently.
- [x] Primary agent wires API-key authentication, services, repositories, routes, authorization, contracts, trace harness, audit records, and observability.
- [x] Primary agent wires participant access into admission/refresh and moves SFU routes to participant-media authentication.
- [x] Primary agent adds participant-media-authenticated close-tracks signaling and authoritative publication removal before the browser proof.
- [x] Primary agent wires the private mTLS Sync provider bridge and a real Cloudflare SFU cleanup executor so durable Leave reaches its terminal state in the production topology.
- [x] Generate sqlc, OpenAPI, and TypeScript artifacts once after the shared API shape is stable.

### Phase 4 — Consumer runtime, dependency-ordered

- [x] Server-SDK worker owns the new server-only Promise entry point, package exports, server guard, and focused package fixture after generated contracts land.
- [x] Session worker owns framework-free `ChalkSession` files and tests after participant-access types and SFU behavior are stable.
- [x] Diagnostics worker owns SDK diagnostics integration and focused tests after session lifecycle is stable.
- [x] React worker owns `sdks/typescript/react` provider/hooks/tests after the snapshot contract is stable.

### Phase 5 — First-party and release proof

- [x] Web worker replaces direct room orchestration with public SDK surfaces and adds a localhost backend access proxy.
- [x] E2E worker owns the clean packed-artifact fixture and proves the full refresh/recovery matrix in two isolated Chromium contexts.
- [ ] Firefox and WebKit run join, camera/microphone control, one screen cycle, and Leave smoke flows in CI.
- [x] Documentation worker updates the quickstart from the tested fixture and records the explicit non-goals.

### Phase 6 — Integration gates

- [x] Primary agent reads every diff, reconciles shared interfaces, and runs focused tests.
- [x] Apply and verify any required migration; no schema change is expected unless implementation discovers a missing constraint.
- [x] Run `apps/api/scripts/perf-local.sh` and inspect the result.
- [x] Run the real packed two-context Chromium proof and inspect success and forced-failure paths.
- [x] Run `pnpm run gate -- --full`.
- [x] Run one `codex review` over the integrated change, fix real findings, and run at most one re-review.
- [x] Update CHANGELOG, spec/companion status, and session log; stage exact paths with `git add -p`; commit conventionally; do not push.

## Test matrix

| Layer                      | Required proof                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API-key service/repository | Create, one-time secret, list redaction, rotate invalidation, revoke, expiry, malformed prefix, constant-time comparison shape, usage update, cross-tenant isolation.                            |
| API middleware/routes      | Login session unchanged; valid key accepted; recognized invalid key does not fall back; 401 anonymous; 403 wrong scope; rate limiting keys by API-key ID; trace context preserved.               |
| Participant access         | Separate audiences, expiry, signature rotation overlap, exact route binding, generation mismatch, removed participant, no provider call on rejection.                                            |
| SFU adapter                | Camera/mic publication, screen start/stop, remote add/remove/re-add, token refresh per request, renegotiation failure, peer/ICE failure, rebuild inputs, idempotent complete stop.               |
| `ChalkSession`             | Concurrent join, partial startup failure, refresh, Sync recovery, SFU rebuild, every public method, screen ended event, Leave ACK/timeout, double Leave, thrown observer, zero leaked resources. |
| React                      | Stable provider identity, hook selection, rerender behavior, action errors, no direct networking or WebRTC.                                                                                      |
| Packed E2E                 | Install tarballs into clean fixture; backend API key never enters browser; two browsers exchange media; refresh and both recovery paths pass; denied access starts nothing; Leave leaks nothing. |

## Anti-slop rules

- Do not add a second meeting runtime in React or the web app while waiting for `ChalkSession`.
- Do not let the browser accept tenant API keys, local system tokens, signing keys, or fallback credential families.
- Do not report media or lifecycle commands as successful before the owning layer confirms them.
- Do not rebuild Sync v3, duplicate its authorization decisions, or equate WebSocket closure with Leave.
- Do not hand-edit generated sqlc, OpenAPI, or TypeScript contract files.
- Do not log credentials, key prefixes, hashes, SDP, display names, media contents, or sensitive payloads.
- Do not weaken tests to fit implementation, introduce broad refactors, upgrade dependencies without need, or format unrelated files.
- Do not claim launch readiness from unit tests alone; packed artifacts and real browsers are the release proof.

## Stop boundary

The work stops after the managed web P0 implementation is committed locally with the full repository gate and Chromium lifecycle matrix passing. Firefox/WebKit CI, NPM publication, pushing, deployment, production configuration, live Cloudflare proof, and customer rollout remain separate authorized actions.
