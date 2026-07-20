# Chalk web SDK launch implementation board

- Status: **ready for implementation**
- Launch scope: managed TypeScript and React web SDK
- Explicitly deferred: recording, React Native launch parity, hosted meeting product, and collaboration features outside the existing Sync v3 core conference contract

## Background

### Current state

Chalk already has the hard lower-level pieces: generated API contracts, participant lifecycle persistence, API-issued five-minute Sync tokens, a production Sync v3 protocol and replica, Cloudflare SFU signaling, browser WebRTC code, telemetry primitives, and presentational React components. Those pieces are individually tested.

They do not form a consumer SDK. The local room manually admits a participant, exposes a tenant bearer in browser configuration, constructs a development Sync token instead of consuming the real API token, starts the SFU and Sync clients independently, bypasses Sync authorization when muting or stopping video, and stops local resources without committing the durable participant Leave operation. The React package has no provider or hooks. The default TypeScript API boundary exposes Effect instead of the promised Promise facade.

### Desired state

A customer backend holds one tenant-scoped API key and uses the server-only TypeScript surface to create Rooms, create Sessions, and issue a short-lived participant access bundle. The browser receives only that participant bundle. One `ChalkSession` owns media permission, Cloudflare SFU signaling, Sync v3, refresh, reconnection, state composition, diagnostics, and teardown. React subscribes to that framework-free session without inventing meeting behavior.

The launch proof installs packed packages into an application outside the workspace and drives two browsers through join, media exchange, Sync convergence, moderation, one forced reconnect, and Leave. The candidate is publishable only after that proof passes. npm authentication is a release-engineering task, not the product implementation critical path.

## Scope and stopping point

In scope:

- a server-only Promise client for Room, Session, and participant-access operations;
- tenant API-key creation, authentication, rotation, revocation, expiry, and scope enforcement;
- separate short-lived Sync and media-signaling participant credentials;
- a browser `ChalkSession` facade over participant access, Cloudflare SFU, and Sync v3;
- microphone, camera, screen share, hand state, display name, admission, roles, host transfer, moderation, reconnect, Leave, and end-for-all;
- React provider and hooks over the framework-free session;
- privacy-safe diagnostics and existing journey telemetry integration;
- a clean packed-artifact consumer example and two-browser release test; and
- npm release-candidate publishing after the product gate passes.

Out of scope:

- recording, even though low-level Sync v3 recording frames currently exist;
- React Native launch parity or repair of the placeholder native session;
- chat, reactions, transcription, whiteboard, files, backgrounds, or advanced device UI;
- hosted Chalk meeting UI;
- production deployment or production mutation; and
- restoring the deleted `packages/sdk-core` implementation. Its tests are behavioral reference only.

## Canonical boundaries and sources of truth

| Concern                   | Owner                                           | Rule                                                                                                                                   |
| ------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Customer authority        | Go API and Postgres `api_keys`                  | Raw API keys exist only at creation and on the customer backend.                                                                       |
| Participant access        | Go API participant-access issuer                | Sync and media tokens are short-lived, audience-specific, and bound to one tenant, Room, Session, participant Session, and generation. |
| Durable conference state  | Postgres through Sync Stateholder               | Roles, capabilities, admission, hand state, display name, moderation facts, Leave, and Session end come from the Sync v3 control fold. |
| Actual media              | Cloudflare SFU plus browser `RTCPeerConnection` | A command is not reported as successful until the media adapter observes the requested result.                                         |
| Browser meeting lifecycle | `@q9labsai/chalk-client` `ChalkSession`         | It is the only component allowed to coordinate participant access, media, Sync, retry, diagnostics, and teardown.                      |
| React state               | `useSyncExternalStore` over `ChalkSession`      | React renders snapshots and invokes methods; it owns no transport or meeting truth.                                                    |

## Public contract to freeze before implementation branches

The default package surface is browser-safe and Promise-based. Server credentials live behind an explicit server-only entry point. Effect-native APIs move to the existing `effect` subpath.

```ts
// Customer backend only.
import { createChalkClient } from "@q9labsai/chalk-client/server";

const chalk = createChalkClient({
  baseUrl: process.env.CHALK_API_URL!,
  apiKey: process.env.CHALK_API_KEY!,
});

const access = await chalk.sessions.createParticipantAccess({
  tenantId,
  roomId,
  sessionId,
  participantSessionId,
  displayName,
  initialRole: "participant",
  eligibleRoles: ["participant"],
  idempotencyKey,
});
```

```ts
// Browser application. The callback calls the customer's own backend.
import { createChalkSession } from "@q9labsai/chalk-client";

const session = createChalkSession({
  apiUrl: "https://api.chalk.example",
  syncUrl: "wss://sync.chalk.example/v3/sync",
  access: ({ reason }) => fetch(`/api/chalk/access?reason=${reason}`, { method: "POST" }).then(requireParticipantAccess),
  initialMedia: { microphone: true, camera: true },
});

await session.join();
await session.setMicrophoneEnabled(false);
await session.setScreenShareEnabled(true);
await session.leave();
```

```ts
export type ParticipantAccess = {
  readonly tenantId: string;
  readonly roomId: string;
  readonly sessionId: string;
  readonly participantSessionId: string;
  readonly participantSessionGeneration: number;
  readonly sync: { readonly token: string; readonly expiresAt: string };
  readonly media: {
    readonly token: string;
    readonly expiresAt: string;
    readonly provider: "cloudflare_sfu";
    readonly clientPayload: CloudflareSFUBootstrap;
  };
};

export type ParticipantAccessProvider = (request: { readonly reason: "join" | "refresh" | "reconnect" }) => Promise<ParticipantAccess>;
```

```ts
export type ChalkSession = {
  join(): Promise<void>;
  leave(): Promise<void>;
  getSnapshot(): ChalkSessionSnapshot;
  subscribe(listener: () => void): () => void;
  getDiagnostics(): ChalkSessionDiagnostics;

  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  setCameraEnabled(enabled: boolean): Promise<void>;
  setScreenShareEnabled(enabled: boolean): Promise<void>;
  setHandRaised(raised: boolean): Promise<void>;
  setDisplayName(displayName: string): Promise<void>;
  setAdmissionPolicy(policy: V3AdmissionPolicy): Promise<void>;
  setParticipantRole(participantSessionId: string, role: V3AssignableRole): Promise<void>;
  transferHost(participantSessionId: string): Promise<void>;
  admit(admissionRequestId: string): Promise<void>;
  deny(admissionRequestId: string): Promise<void>;
  muteParticipant(participantSessionId: string): Promise<void>;
  stopParticipantCamera(participantSessionId: string): Promise<void>;
  stopParticipantScreenShare(participantSessionId: string): Promise<void>;
  requestUnmute(participantSessionId: string): Promise<void>;
  requestStartCamera(participantSessionId: string): Promise<void>;
  removeParticipant(participantSessionId: string): Promise<void>;
  endSession(): Promise<void>;
};
```

Recording methods are intentionally absent from `ChalkSession`. Existing low-level v3 recording operations may remain temporarily under the advanced Sync subpath, but no first-launch facade, React hook, documentation, or acceptance test advertises them.

## Execution checklist

- [ ] Phase 1 — Freeze the participant access schema, error vocabulary, public facade, and package boundaries.
- [ ] Phase 2 — Implement tenant API-key authentication and lifecycle.
- [ ] Phase 3 — Implement browser-safe participant media access and refresh.
- [ ] Phase 4 — Complete the Cloudflare SFU browser adapter.
- [ ] Phase 5 — Implement the Promise server client and `ChalkSession` facade.
- [ ] Phase 6 — Add React provider/hooks and replace app-local orchestration.
- [ ] Phase 7 — Wire diagnostics and run the clean-consumer two-browser proof.
- [ ] Phase 8 — Publish the verified release candidate and quickstart.

## Board import summary

Sizes are relative implementation weight, not calendar estimates. `P0` means the managed web SDK cannot launch without the card; `Release` means the work is necessary to distribute the proven build but is not evidence that the product works.

| Card      | Lane                | Priority | Size | Start condition                                                   |
| --------- | ------------------- | -------- | ---- | ----------------------------------------------------------------- |
| SDK-001   | Client contract     | P0       | S    | Now                                                               |
| API-001   | API/auth            | P0       | M    | SDK-001 vocabulary frozen                                         |
| API-002   | API/access          | P0       | L    | SDK-001 schema frozen; API-001 authenticates the customer path    |
| SDK-002   | Server SDK          | P0       | M    | API-002 generated contract available                              |
| SDK-003   | Media SDK           | P0       | L    | SDK-001 media-access shape frozen; API-002 integration can follow |
| SDK-004   | Client composition  | P0       | XL   | API-002 and SDK-003 behavior available                            |
| OBS-001   | Observability       | P0       | M    | SDK-004 lifecycle stable                                          |
| REACT-001 | React SDK           | P0       | M    | SDK-004 snapshot contract stable                                  |
| WEB-001   | First-party proof   | P0       | M    | SDK-002, SDK-004, OBS-001, and REACT-001 available                |
| E2E-001   | Release proof       | P0       | L    | All implementation cards available                                |
| DOC-001   | Documentation       | P0       | M    | E2E-001 tested snippets available                                 |
| REL-001   | Release engineering | Release  | S    | E2E-001 and DOC-001 pass                                          |

## Implementation cards

### SDK-001 — Freeze the access and session contracts

**Outcome:** Dependent API, Sync, media, React, and test work compiles against one reviewed contract. No lane invents a local token shape or lifecycle vocabulary.

**Owns:**

- `contract/schema/participant-access.json` (new language-neutral schema)
- `sdks/typescript/client/src/session/types.ts` (new)
- `sdks/typescript/client/src/session/errors.ts` (new)
- `sdks/typescript/client/src/session/index.ts` (new)
- `sdks/typescript/client/src/index.ts`
- `sdks/typescript/client/src/effect.ts`

**Pseudodiff:**

```diff
+ export type ChalkSessionPhase =
+   | "idle" | "joining" | "live" | "reconnecting"
+   | "leaving" | "left" | "failed";
+
+ export type ChalkSessionSnapshot = {
+   readonly phase: ChalkSessionPhase;
+   readonly sync: V3SessionSnapshot | null;
+   readonly media: CloudflareSFUSnapshot | null;
+   readonly localTracks: Readonly<Record<V3MediaSource, MediaStreamTrack | null>>;
+   readonly remoteTracks: readonly ChalkRemoteTrack[];
+   readonly lastFailure: ChalkSessionFailure | null;
+ };
+
+ export class ChalkSessionError extends Error {
+   constructor(
+     message: string,
+     readonly code:
+       | "access_failed" | "access_expired" | "permission_denied"
+       | "media_failed" | "sync_failed" | "join_failed"
+       | "not_live" | "leave_unconfirmed",
+     readonly retryable: boolean,
+   ) { super(message); }
+ }
```

```diff
- export * from "./generated/http-api";
- export * from "./generated/schemas";
+ export * from "./session";
  export * from "./media";
  export * from "./sync";

// sdks/typescript/client/src/effect.ts
+ export { createChalkEffectClient } from "./effect-client";
+ export * from "./generated/http-api";
+ export * from "./generated/schemas";
```

**Acceptance:** Type-only tests prove the root import contains no Effect type, `ParticipantAccess` rejects missing or cross-shaped credentials, and recording is absent from `ChalkSession`.

### API-001 — Make tenant API keys real HTTP credentials

**Depends on:** SDK-001 error and scope vocabulary.

**Outcome:** A customer backend authenticates with a rotatable `chalk_sk_…` credential scoped to one tenant. The existing `api_keys` table becomes executable instead of aspirational.

**Owns:**

- `apps/api/internal/apikeys/service.go` and tests (new)
- `apps/api/db/queries/api_keys.sql` (new)
- generated `apps/api/internal/adapters/postgres/sqlc/*`
- Postgres API-key repository adapter and tests
- `apps/api/internal/httpapi/api_keys.go` and transport tests (new)
- `apps/api/internal/httpapi/middleware.go`
- `apps/api/internal/httpapi/router.go`
- `apps/api/internal/httpapi/contracts.go`
- generated OpenAPI and TypeScript artifacts
- trace-harness API-key authentication scenario

The table already exists, so this card adds no migration unless implementation discovers a missing constraint. If a constraint is required, add a new migration and keep `db/schema.sql` synchronized.

**Pseudodiff:**

```diff
+ type APIKeyAuthenticator interface {
+   AuthenticateAPIKey(
+     context.Context,
+     string,
+     net.IP,
+   ) (authentication.Principal, error)
+ }

- func requireAuthentication(sessions AuthenticationService) middleware
+ func requireAuthentication(
+   sessions AuthenticationService,
+   apiKeys APIKeyAuthenticator,
+ ) middleware {
+   raw := requireBearerOrCookie(request)
+   switch {
+   case strings.HasPrefix(raw, "chalk_sk_"):
+     principal := apiKeys.AuthenticateAPIKey(ctx, raw, requestIP(request))
+     return withPrincipal(principal)
+   default:
+     session := sessions.AuthenticateSession(ctx, raw)
+     return withPrincipal(sessions.PrincipalForSession(session.Session))
+   }
+ }
```

```diff
+ -- name: GetAPIKeyByPrefix :one
+ select id, tenant_id, key_hash, scopes, expires_at, revoked_at
+ from api_keys
+ where key_prefix = $1;
+
+ -- name: TouchAPIKeyLastUsed :exec
+ update api_keys
+ set last_used_at = $2, last_used_ip = $3, updated_at = $2
+ where id = $1;
+
+ -- name: RevokeAPIKey :one
+ update api_keys
+ set revoked_at = $3, updated_at = $3
+ where tenant_id = $1 and id = $2 and revoked_at is null
+ returning *;
```

Raw key creation returns `chalk_sk_<prefix>.<32-byte-random-secret>` once. Authentication parses the prefix, performs one indexed lookup, compares the SHA-256 hash in constant time, rejects revoked or expired keys, and constructs `PrincipalAPIKey` with tenant and concrete scopes. It never falls back to user-session authentication after recognizing the API-key prefix.

**Routes:**

- `POST /v1/tenants/{tenant_id}/api-keys`
- `GET /v1/tenants/{tenant_id}/api-keys`
- `POST /v1/tenants/{tenant_id}/api-keys/{api_key_id}/rotate`
- `DELETE /v1/tenants/{tenant_id}/api-keys/{api_key_id}`

Creation and rotation require a user Session or an API key with `api_keys:write`; revocation requires `api_keys:delete`; list requires `api_keys:read`. Responses never return a stored hash or previous raw key.

**Acceptance:** Focused service, repository, middleware, route-contract, cross-tenant, wrong-scope, expiry, revocation, malformed-prefix, and constant-shape unauthenticated tests pass. The trace harness shows one success and one rejected scope without the raw key. `apps/api/scripts/gate.sh` passes.

### API-002 — Issue browser-safe participant access for both Sync and media

**Depends on:** SDK-001; API-001 for the customer-backend path.

**Outcome:** Admission returns everything a browser meeting runtime needs, but none of it grants tenant authority. Cloudflare signaling accepts only a short-lived media credential bound to the exact route identity.

**Owns:**

- `apps/api/internal/participantaccess/issuer.go` and `verifier.go` with tests (new)
- `apps/api/internal/synctokens/service.go` only where shared signing primitives are extracted
- `apps/api/internal/httpapi/session_lifecycle.go`
- `apps/api/internal/httpapi/session_lifecycle_transport.go`
- `apps/api/internal/httpapi/sfu_signaling.go`
- `apps/api/internal/httpapi/middleware.go`
- `apps/api/internal/httpapi/contracts.go`
- API configuration for separate `chalk-sync` and `chalk-media` audiences
- generated OpenAPI and TypeScript artifacts
- API/Sync real-wire participant-access proof

**Pseudodiff:**

```diff
- type participantLifecycleResponse struct {
-   SyncToken string `json:"sync_token,omitempty"`
-   ExpiresAt string `json:"expires_at,omitempty"`
-   MediaPlane *mediaPlaneResponse `json:"media_plane,omitempty"`
- }
+ type participantLifecycleResponse struct {
+   Participant participantSessionResponse `json:"participant"`
+   Intent lifecycleIntentResponse `json:"lifecycle_intent"`
+   AdmissionRequest *admissionRequestResponse `json:"admission_request,omitempty"`
+   Access *participantAccessResponse `json:"access,omitempty"`
+ }
+
+ type participantAccessResponse struct {
+   Sync credentialResponse `json:"sync"`
+   Media mediaCredentialResponse `json:"media"`
+ }
+
+ type mediaCredentialResponse struct {
+   Token string `json:"token"`
+   ExpiresAt string `json:"expires_at"`
+   Provider string `json:"provider"`
+   ClientPayload map[string]any `json:"client_payload"`
+ }
```

```diff
- POST .../participants/{participant_session_id}/sync-token
+ POST .../participants/{participant_session_id}/access

- issue only Sync token
+ reload persisted participant subject
+ issue aud=chalk-sync token
+ issue aud=chalk-media token
+ resolve fresh media join payload when required
+ return one ParticipantAccess bundle
```

```diff
- authorizeTenant(ctx, authorizer, request.TenantID, writeSessionsPermission)
+ claims := participantAccessFromContext(ctx)
+ requireExactRouteBinding(claims, request.TenantID, request.RoomID,
+   request.SessionID, request.ParticipantID)
+ requireAudience(claims, "chalk-media")
```

SFU track, publication, and renegotiation routes move out of the tenant-authenticated route group and into a participant-media-authenticated group. Media credentials cannot call Room, Session, participant lifecycle, moderation, recording, or tenant routes. Sync credentials cannot call SFU routes. Both expire within five minutes and preserve the existing Ed25519 key-rotation overlap.

**Acceptance:** Admission and refresh return two independently verifiable tokens; wrong audience, expired token, invalid signature, route mismatch, generation mismatch, cross-tenant access, and revoked/removed participant all fail before a provider call. No token appears in telemetry or errors. API and Sync focused gates plus the packaged real-wire token proof pass.

### SDK-002 — Add the server-only Promise control client

**Depends on:** SDK-001 and generated API-002 contract.

**Outcome:** A customer backend can perform the five launch operations without importing Effect or reconstructing generated request shapes.

**Owns:**

- move current Effect client code to `sdks/typescript/client/src/effect-client.ts`
- `sdks/typescript/client/src/server/client.ts` and tests (new)
- `sdks/typescript/client/src/server/types.ts` (new)
- `sdks/typescript/client/src/server/index.ts` (new)
- `sdks/typescript/client/src/server-only.ts` (new browser guard)
- `sdks/typescript/client/package.json` export/build entries
- clean consumer compile fixture

**Pseudodiff:**

```diff
+ export function createChalkClient(options: ChalkServerClientOptions): ChalkServerClient {
+   const generated = Effect.runSync(
+     createChalkEffectClient({
+       baseUrl: options.baseUrl,
+       auth: { type: "apiKey", token: options.apiKey },
+       fetch: options.fetch,
+     }),
+   );
+
+   return {
+     rooms: {
+       create: (input) => Effect.runPromise(generated.rooms.createRoom(mapRoom(input))),
+       get: (input) => Effect.runPromise(generated.rooms.getRoom(mapRoomID(input))),
+       list: (input) => Effect.runPromise(generated.rooms.listRooms(mapRoomList(input))),
+     },
+     sessions: {
+       create: (input) => Effect.runPromise(generated.roomSessions.createRoomSession(mapSession(input))),
+       createParticipantAccess: (input) => Effect.runPromise(generated.lifecycle.admitSessionParticipant(mapAdmission(input))),
+       refreshParticipantAccess: (input) => Effect.runPromise(generated.lifecycle.issueSessionParticipantAccess(mapAccessRefresh(input))),
+       end: (input) => Effect.runPromise(generated.roomSessions.endRoomSession(mapEnd(input))),
+     },
+   };
+ }
```

The exact generated group name is taken from regenerated output during implementation; the public methods and arguments above are the stable contract. Mappers live in focused files only when reused or when they isolate generated wire naming.

```diff
+ "./server": {
+   "browser": "./dist/server-only.js",
+   "import": "./dist/server/index.js",
+   "types": "./dist/server/index.d.ts"
+ }
```

**Acceptance:** A Node fixture imports only `@q9labsai/chalk-client/server`, calls all five methods through a fake fetch server, receives typed tagged errors as `ChalkAPIError`, and proves the raw API key never appears in returned values or logs. A browser-bundle fixture importing `/server` fails with the intentional server-only guard. Build, `publint`, and `attw` pass.

### SDK-003 — Complete the Cloudflare SFU browser adapter

**Depends on:** SDK-001 and its frozen media credential shape. Integration against the real issuer is blocked on API-002, but adapter behavior can be built in parallel.

**Outcome:** The media adapter represents actual browser media truth, supports every non-recording launch media method, and can be safely rebuilt after a connection failure.

**Owns:**

- split `sdks/typescript/client/src/media/cloudflare-sfu.ts` into focused `client.ts`, `transport.ts`, `tracks.ts`, and `types.ts`
- `sdks/typescript/client/src/media/index.ts`
- focused fake-`RTCPeerConnection` tests
- real two-browser media test fixture

**Required corrections:**

- Replace the fixed `bearerToken` transport option with `credential: () => Promise<string>` so refresh applies to every signaling request.
- Track publication replace/remove events instead of append-only remote state. A publication disappearing from the authoritative list removes and stops its remote track.
- Expose `getSnapshot()` and `subscribe()` with connection, local track, remote track, and failure state.
- Add prepared screen-share publication and stop behavior; the current adapter has no screen sender, so `setScreenShareEnabled(true)` always returns `source_unavailable`.
- Observe `connectionstatechange` and `iceconnectionstatechange`; publish a recoverable failure instead of silently polling a dead peer connection.
- Make `stop()` idempotently clear polling, listeners, transceivers, remote tracks, local tracks owned by the adapter, and the peer connection.

**Pseudodiff:**

```diff
  export type CloudflareSFUHTTPTransportOptions = {
-   readonly bearerToken: string;
+   readonly credential: () => Promise<string>;
  };

  const request = async (...) => {
+   const token = await options.credential();
    return fetch(url, {
-     headers: { Authorization: `Bearer ${options.bearerToken}` }
+     headers: { Authorization: `Bearer ${token}` }
    });
  };
```

```diff
+ prepareLocalTrack(source: V3MediaSource, track: MediaStreamTrack): void
+ clearPreparedLocalTrack(source: V3MediaSource): void
+ getSnapshot(): CloudflareSFUSnapshot
+ subscribe(listener: () => void): () => void
+ restart(access: ParticipantAccess["media"]): Promise<void>
```

```diff
- this.#remotePublications = [...this.#remotePublications, ...newTracks]
+ const next = reconcilePublicationSnapshot(authoritative, this.#remoteTracks)
+ stopRemovedTracks(next.removed)
+ this.#remoteTracks = next.current
+ this.#emit()
```

**Acceptance:** Tests cover initial microphone/camera publication, mute/camera target confirmation, screen-share start/stop, remote addition/removal/re-addition, token refresh on signaling, failed renegotiation, dead peer recovery, and idempotent stop. A real two-browser local proof exchanges audio and video, shares one screen, and observes removal when the share stops.

### SDK-004 — Implement the `ChalkSession` lifecycle facade

**Depends on:** SDK-001, API-002, and SDK-003. It consumes the existing `V3SyncClient`; it does not rewrite Sync v3.

**Outcome:** One framework-free object owns the meeting lifecycle and exposes every non-recording launch method through Promises and synchronous snapshots.

**Owns:**

- `sdks/typescript/client/src/session/session.ts` (new)
- `sdks/typescript/client/src/session/create.ts` (new)
- `sdks/typescript/client/src/session/access-manager.ts` (new)
- `sdks/typescript/client/src/session/snapshot.ts` (new)
- `sdks/typescript/client/src/session/diagnostics.ts` (new)
- focused lifecycle and race tests

**Join pseudocode:**

```ts
async join(): Promise<void> {
  return this.#joinLock.run(async () => {
    if (this.#snapshot.phase === "live") return;
    this.#transition("joining");
    const journey = this.#telemetry?.startJourney({ kind: "meeting.join" });

    try {
      const access = await this.#access.get("join");
      const localMedia = await this.#mediaDevices.getUserMedia(this.#initialMedia);
      const media = this.#createMedia(access.media, localMedia);
      const sync = createV3SyncClient({
        url: this.#syncUrl,
        token: () => this.#access.syncToken("reconnect"),
        mediaPlane: media,
        persistenceScope: access.participantSessionId,
      });

      this.#installRuntime({ access, localMedia, media, sync });
      await media.start(localMedia);
      await sync.start();
      await this.#waitForSyncPhase("live");
      this.#transition("live");
      journey?.terminal("succeeded");
    } catch (cause) {
      await this.#disposeRuntime();
      const failure = normalizeSessionFailure(cause);
      this.#transition("failed", failure);
      journey?.terminal("failed", { failure_code: failure.code });
      throw failure;
    }
  });
}
```

**Leave pseudocode:**

```ts
async leave(): Promise<void> {
  return this.#leaveLock.run(async () => {
    if (this.#snapshot.phase === "idle" || this.#snapshot.phase === "left") return;
    this.#transition("leaving");
    let leaveConfirmed = false;

    try {
      if (this.#runtime?.sync.getSnapshot().connection.phase === "live") {
        await withDeadline(this.#runtime.sync.leave(), this.#leaveAckTimeoutMs);
        leaveConfirmed = true;
      }
    } finally {
      await this.#disposeRuntime();
      this.#transition("left", leaveConfirmed ? null : leaveUnconfirmedFailure());
    }
  });
}
```

The `finally` cleanup order is: unsubscribe observers, stop Sync, stop SFU, stop every remaining local/remote track owned by the session, clear timers, clear credential material, then publish the terminal snapshot. Socket loss never calls `leave()` and never changes durable membership.

**Method delegation:** Durable and moderation methods delegate to `V3SyncClient` and normalize ACK outcomes into `void` or `ChalkSessionError`. Microphone and camera use existing v3 live-target methods, never call the media adapter directly. Screen-share enable obtains and prepares the display track before the v3 target; any rejection stops and clears the prepared track. Screen-share disable waits for the v3/media result before clearing the track. Recording methods are not added.

**Reconnect:** A Sync reconnect uses the access provider when the cached Sync credential is near expiry. A dead SFU peer causes `reconnecting`, refreshes participant access, rebuilds the media adapter with current local tracks, reattaches it to the session, and returns to `live` only after both Sync and media are healthy. Retry budget exhaustion moves to `failed` with a stable diagnostic code.

**Acceptance:** Focused tests cover concurrent join, join after failure, partial media startup, access refresh, Sync reconnect, SFU rebuild, every public method, screen-share cleanup, leave ACK success, leave ACK timeout, double leave, teardown after thrown callbacks, and zero live tracks/sockets/timers after exit. The class remains split across focused files and the root surface contains no Effect type.

### OBS-001 — Connect existing telemetry and diagnostics to the session

**Depends on:** SDK-004 public lifecycle.

**Outcome:** A customer and Chalk support can tell which phase failed without receiving tokens, SDP, media content, display names, or raw identifiers.

**Owns:**

- `sdks/typescript/client/src/session/diagnostics.ts`
- `sdks/typescript/client/src/telemetry/journey.ts` only for missing bounded event vocabulary
- `sdks/typescript/client/src/sync/v3-types.ts` and client only for an optional telemetry observer
- Cloudflare SFU connection/RTC summary observation
- journey-intake integration proof

**Pseudodiff:**

```diff
+ export type ChalkSessionDiagnostics = {
+   readonly phase: ChalkSessionPhase;
+   readonly syncPhase: V3ConnectionPhase | null;
+   readonly mediaConnection: RTCPeerConnectionState | null;
+   readonly credentialFreshness: "fresh" | "refreshing" | "expired" | "unknown";
+   readonly pendingCommandCount: number;
+   readonly lastFailureCode: string | null;
+   readonly timeline: readonly ChalkDiagnosticEvent[]; // bounded to 100
+ };
```

```diff
+ journey.phase("access")
+ journey.phase("media")
+ journey.phase("signaling")
+ journey.recordSyncFrame({ direction, frameType })
+ journey.recordRtcSummary(peerState, await peer.getStats())
+ journey.recordDiagnostic({ category, code, state })
+ journey.terminal("succeeded" | "failed" | "cancelled")
```

**Acceptance:** Success, credential rejection, media permission denial, Sync rejection, reconnect, and leave-unconfirmed paths emit bounded timelines and correlated journey events. A secret-canary test fails if a token, authorization header, SDP, display name, tenant/Room/Session/participant ID, or track label appears in diagnostic serialization or telemetry attributes.

### REACT-001 — Add provider and hooks without moving authority into React

**Depends on:** SDK-004.

**Outcome:** React consumers can render and control a real session with standard external-store semantics. The provider does not auto-join, auto-leave, fetch credentials, or own transport.

**Owns:**

- `sdks/typescript/react/src/session/ChalkSessionProvider.tsx` (new)
- `sdks/typescript/react/src/session/useChalkSession.ts` (new)
- `sdks/typescript/react/src/session/useChalkSessionSnapshot.ts` (new)
- `sdks/typescript/react/src/session/index.ts` (new)
- `sdks/typescript/react/src/index.ts`
- `sdks/typescript/react/package.json`
- provider/hook tests

**Pseudodiff:**

```diff
+ const ChalkSessionContext = createContext<ChalkSession | null>(null);
+
+ export function ChalkSessionProvider({
+   session,
+   children,
+ }: PropsWithChildren<{ readonly session: ChalkSession }>) {
+   return <ChalkSessionContext value={session}>{children}</ChalkSessionContext>;
+ }
+
+ export function useChalkSession(): ChalkSession {
+   const session = use(ChalkSessionContext);
+   if (!session) throw new Error("useChalkSession requires ChalkSessionProvider");
+   return session;
+ }
+
+ export function useChalkSessionSnapshot(): ChalkSessionSnapshot {
+   const session = useChalkSession();
+   return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
+ }
```

`ChalkSession.subscribe` is bound or exposed as a stable arrow function so passing it to `useSyncExternalStore` does not lose `this`. The React package adds `@q9labsai/chalk-client` as a peer dependency and workspace development dependency. No hook uses `useEffect`.

**Acceptance:** Tests prove initial snapshot rendering, one re-render per session emission, provider replacement, missing-provider failure, action delegation, SSR snapshot stability, and unsubscribe on unmount. React build, package lint, and type-resolution checks pass.

### WEB-001 — Replace the localhost room's private orchestration with the public SDK

**Depends on:** SDK-002, SDK-004, OBS-001, and REACT-001.

**Outcome:** Chalk's own web proof becomes an honest consumer and cannot use private shortcuts that customer code lacks.

**Owns:**

- `apps/web/src/routes/room.tsx`
- a localhost-only backend access proxy under the web development server or an API test helper
- focused web tests

**Pseudodiff:**

```diff
- import { CloudflareSFUClient } from "@q9labsai/chalk-client/media";
- import { createV3SyncClient } from "@q9labsai/chalk-client/sync";
- const syncToken = createDevSyncToken(...);
- await media.start(local);
- await sync.start();
+ import { createChalkSession } from "@q9labsai/chalk-client";
+ import {
+   ChalkSessionProvider,
+   useChalkSession,
+   useChalkSessionSnapshot,
+ } from "@q9labsai/chalk-react";
+
+ const session = createChalkSession({
+   apiUrl: localConfig.apiURL,
+   syncUrl: localConfig.syncURL,
+   access: () => fetch("/api/local-chalk-access", { method: "POST" }).then(requireAccess),
+   initialMedia: { microphone: true, camera: true },
+ });
```

```diff
- activeRuntime.media.setLocalPublicationTarget(...)
+ session.setMicrophoneEnabled(next)
+ session.setCameraEnabled(next)

- runtime.sync.stop(); runtime.media.stop(); tracks.stop()
+ await session.leave()
```

The browser bundle contains no `VITE_CHALK_LOCAL_API_TOKEN`, tenant bearer, API key, token signer, or development token constructor. The localhost backend proxy is the only local holder of tenant authority.

**Acceptance:** Browser tests prove the UI uses only root session/React imports, mute and camera travel through Sync live-target authorization, Leave commits before teardown when reachable, and a static bundle scan contains no configured server secret.

### E2E-001 — Make the clean consumer application the release gate

**Depends on:** all implementation cards above.

**Outcome:** The thing being sold—not the monorepo workspace—proves the launch contract.

**Owns:**

- `tools/sdk-consumer-proof/` isolated backend and React fixture (new)
- `scripts/sdk-consumer-proof.mjs` orchestrator (new)
- root `test:sdk-consumer` command
- smart-gate routing and CI workflow wiring
- private raw artifacts under ignored output; redacted summary only in tracked files

**Pseudodiff:**

```diff
+ pnpm --filter @q9labsai/chalk-client pack --pack-destination "$TEMP/packages"
+ pnpm --filter @q9labsai/chalk-react pack --pack-destination "$TEMP/packages"
+ create clean fixture outside workspace
+ pnpm add "$TEMP/packages/q9labsai-chalk-client-<version>.tgz" ...
+ start isolated API + Postgres + Sync + consumer backend + consumer frontend
+ launch two Chromium contexts
+ drive participant A and B through the public package surface
+ assert media, Sync, moderation, reconnect, and teardown
+ inspect browser bundles and telemetry for secret canaries
+ stop every spawned process and verify cleanup
```

**Required scenario:**

1. The consumer backend authenticates with a scoped API key, creates a Room and Session, and issues two participant access bundles.
2. Two browsers join with microphone and camera, each sees and hears the other, and both observe the same Sync participant state.
3. A raises a hand and changes display name; B observes both.
4. A mutes and unmutes, stops and restarts camera, starts and stops screen share; B observes converged media state and real track changes.
5. The host requests unmute, stops the participant camera, and exercises one role or admission operation.
6. One Sync socket and one peer connection are forcibly interrupted; the affected browser refreshes access, reconnects, and converges.
7. Both call `leave()`; local tracks end, remote tracks disappear, sockets close, presence clears, and no timer or process remains.
8. Invalid, expired, wrong-audience, replayed where forbidden, cross-tenant, and path-mismatched credentials fail with typed public errors.

**Acceptance:** `pnpm run test:sdk-consumer` passes from a clean commit and writes a unique redacted summary containing package tarball hashes and service revisions. The full root gate passes. This card is not done if camera/microphone permission or real WebRTC transport was mocked.

### DOC-001 — Publish the exact install-to-call quickstart

**Depends on:** E2E-001 so documentation copies tested code rather than anticipated code.

**Outcome:** A customer engineer can reproduce the consumer proof without reading Chalk source.

**Owns:**

- `apps/docs` SDK quickstart pages
- client and React package READMEs
- version/support matrix
- generated API links
- troubleshooting and typed-error table

The quickstart shows the customer-backend API key boundary, access endpoint, browser session construction, React provider/hooks, media permission timing, reconnect UI, and Leave. It explicitly says recording and React Native are not in the first launch contract.

**Acceptance:** Documentation snippets are extracted into or imported from the clean consumer fixture and compile in CI. A fresh engineer follows the page against the qualified non-production environment and completes the same two-browser proof.

### REL-001 — Fix npm publishing after the candidate passes

**Depends on:** E2E-001 and DOC-001.

**Outcome:** The already-small npm authentication problem cannot publish an unverified implementation.

**Owns:**

- `.github/workflows/npm-publish.yml`
- npm organization/package ownership and trusted-publishing configuration
- release-candidate tag and provenance verification

**Pseudodiff:**

```diff
  - name: Verify release
+   run: pnpm run gate -- --full && pnpm run test:sdk-consumer

  - name: Publish packages
-   run: pnpm ... publish --access public --no-git-checks
+   run: pnpm ... publish --access public --provenance --tag rc --no-git-checks
```

**Acceptance:** `npm view` resolves the exact `rc`, a fresh external project installs it, provenance is present, the tarball hashes match the E2E evidence, and promotion to `latest` reuses the same verified artifacts rather than rebuilding them.

## Dependency order

```text
SDK-001 contract freeze
├── API-001 customer API keys ── API-002 participant access ──┬── SDK-002 server client ─────────────┐
│                                                            └── SDK-004 ChalkSession ── OBS-001 ──┤
└── SDK-003 SFU completion ────────────────────────────────────────┘                    REACT-001 ──┼── WEB-001
WEB-001 ── E2E-001 ── DOC-001 ── REL-001
```

API-001 and SDK-003 can run in parallel after SDK-001. API-002 consumes the fixed access schema and coordinates with Sync verification. SDK-002 can begin after generated API-002 artifacts exist. SDK-004 waits for real participant-access and media-adapter behavior; REACT-001 and OBS-001 can then proceed in parallel. No React or web lane may create a temporary meeting runtime while waiting for SDK-004.

## Anti-slop rules

- Do not create a second Sync state machine. `V3SyncClient` remains the durable/live conference replica and command client.
- Do not let a UI package call the API, WebSocket, SFU, `getUserMedia`, or token provider directly.
- Do not report a media target as successful from a local boolean; wait for the existing Sync authorization plus actual media-plane confirmation.
- Do not accept tenant API keys, user Sessions, Sync tokens, and media tokens through an ambiguous fallback chain. Recognize credential families explicitly and verify one intended audience.
- Do not put a tenant bearer or API key in browser environment variables, examples, tests, bundles, diagnostics, or telemetry.
- Do not turn socket loss into Leave, participant removal, host transfer, or Session end.
- Do not keep fake or empty-return methods. Implement the method, omit it from the public surface, or throw a typed `unsupported_feature` error at an explicitly advanced boundary.
- Do not restore RealtimeKit-specific legacy SDK runtime code. Reuse only behavioral tests that still match the current provider-neutral contract.
- Do not claim completion from unit tests, package builds, or mocked media. The clean packed-artifact two-browser proof is the stopping gate.

## Definition of done

The web SDK launch implementation is done when every execution checkbox and card acceptance section above is satisfied in one candidate, `pnpm run gate -- --full` is green, `pnpm run test:sdk-consumer` exchanges real media in two browsers from packed artifacts, the public quickstart reproduces that result, and the exact `rc` package versions resolve from npm with provenance.

Production deployment is not part of this board. The project remains not launched until an explicitly approved production revision runs the same consumer proof and has rollback evidence.
