# SDK consumer launch audit — 2026-07-20

Status: **not done**. Chalk has useful low-level API, Sync v3, media, telemetry, webhook, and UI package code, but an external consumer cannot install the advertised packages and reach a live meeting through a supported production path.

## Audited launch contract

This audit treats the first launch as the smallest contract that lets a customer embed Chalk in a web application:

1. install public TypeScript and React packages from npm;
2. use a server-held credential to create or select a room and issue short-lived participant access;
3. join from a browser without exposing tenant authority;
4. publish and receive camera and microphone media, receive Sync v3 state, mute or stop video, recover from a transient disconnect, and leave cleanly;
5. diagnose a failed join without exposing credentials or meeting content; and
6. follow a runnable quickstart against a qualified Chalk environment.

React Native is audited because the repository currently advertises it, but it should not be part of the first launch promise unless the waiting customer requires native support. Swift, Kotlin, Python, Go, iframe embedding, recording, transcription, whiteboard, durable chat, webinars, SSO, and a complete first-party hosted app are outside this minimum contract.

## Launch blockers

### 1. The packages do not exist on npm

On 2026-07-20, `npm view` returned `E404 Not Found` for all three advertised package names:

- `@q9labsai/chalk-client`
- `@q9labsai/chalk-react`
- `@q9labsai/chalk-react-native`

The manual [npm workflow](../.github/workflows/npm-publish.yml) builds and checks packages, but no successful publish has occurred. The successful run on 2026-07-06 was a pack-only dry run. The two publish attempts failed: [run 28786211167](https://github.com/Q9Labs/chalk/actions/runs/28786211167) failed with registry `E404`, and [run 28789647227](https://github.com/Q9Labs/chalk/actions/runs/28789647227) failed with `EOTP`, saying the operation required a one-time password.

This is a hard blocker because the install command shown on the public web surface cannot work. Resolve npm organization/package ownership and CI trusted-publishing or automation-token policy early, reserve the names with a release candidate, and do not publish the current functional surface as a stable release.

Done proof: `npm view` resolves the intended release, a fresh project installs it without workspace links, provenance is present, and the installed tarballs pass the consumer smoke test described below.

### 2. There is no shared consumer meeting runtime

The framework-free client contains real generated control-plane contracts, Cloudflare SFU code, Sync v3, telemetry, and webhooks. It does not compose them into the create/join/connect/leave lifecycle promised by its README. The control-plane entry point is also Effect-native in [client.ts](../sdks/typescript/client/src/client.ts), even though the repository standard says the default boundary must be a Promise facade with synchronous snapshots in [code-standards.md](../sdks/typescript/code-standards.md).

The React package is explicitly presentational. Its [README](../sdks/typescript/react/README.md) says it has no meeting provider, hooks, session facade, or turnkey join flow. The local web proof manually performs admission, media setup, development-token construction, Sync setup, and teardown inside [room.tsx](../apps/web/src/routes/room.tsx); that app-only composition is exactly the behavior the shared client is supposed to own.

The React Native public surface is more serious because it looks turnkey while calling placeholders. [internal/core.ts](../sdks/typescript/react-native/src/internal/core.ts) creates inert managers, `join()` and `leave()` resolve without work, `createSession()` returns an empty string, `createJoinToken()` returns an empty token, diagnostics always report disconnected, and every moderation or collaboration method is a no-op. `ChalkNativeProvider` and the first-party mobile meeting screen both use this class.

The earlier `packages/sdk-core` implementation was deliberately replaced by a specification in commit `6f785769`, deleting roughly 25,000 lines of legacy runtime and tests. It is useful as behavioral reference, but restoring it wholesale would reintroduce the old transport and RealtimeKit assumptions instead of composing the current API, Cloudflare SFU boundary, and Sync v3.

Done proof: the default client exports one Promise-based session object that owns credential refresh, admission, SFU setup, Sync setup, state snapshots, media controls, reconnect, telemetry, and teardown. React wraps that object with a provider and hooks. Native either uses the same real core through its media adapter or is removed from the first launch claim.

### 3. The credential and participant-admission path is not safe for an SDK customer

The participant-admission endpoint in [session_lifecycle.go](../apps/api/internal/httpapi/session_lifecycle.go) requires Chalk session/bearer authentication and tenant `writeSessions` authorization. The HTTP authentication middleware in [middleware.go](../apps/api/internal/httpapi/middleware.go) resolves bearer credentials as Chalk user sessions; although API-key principal types, scopes, and a database table exist, the public edge has no API-key verifier and the generated 69-operation API has no API-key lifecycle routes.

The localhost room proof works around this by putting `VITE_CHALK_LOCAL_API_TOKEN` in browser configuration and constructing an unsigned development Sync token in the browser. The route rejects non-local API URLs, so this is valid as a local proof but cannot become customer guidance. The current implementation does not support the repository's claim that anonymous joining is first-class.

Done proof: a consumer backend can authenticate with a rotatable, tenant-scoped server credential and mint or exchange a short-lived, room-scoped participant credential. The browser receives no tenant secret. Admission, SFU signaling, Sync refresh, revocation, and expiry all accept the intended participant authority, with cross-tenant and replay tests.

### 4. There is no qualified environment for customers to call

Both supplied inventories correctly mark managed production deployment, repeatable self-host qualification, Sync production topology and failure recovery, managed telemetry/alerting, and real synthetic recovery as incomplete. A consumer SDK still needs a stable API URL, Sync URL, media provider configuration, migrations, key rotation, CORS policy, health checks, capacity limits, and an operational owner.

Done proof: one named staging environment passes migrations and readiness, uses production token verification and Cloudflare media credentials, survives the documented failure/recovery drill, emits the join journey into the managed observability path, and is promoted through an identified production deployment with rollback evidence. Production must not be touched until its exact target is approved.

### 5. Tests prove packages compile, not that a consumer can call

The focused local package checks are healthy: all three SDKs build; 27 client files with 153 tests, 3 React files with 6 tests, and 39 React Native files with 146 tests pass; `publint`, `attw`, and generated-SDK drift checks pass. The API route-contract test also passes.

Those checks do not detect the inert native session because component/controller tests accept it, and no test installs packed artifacts into a clean consumer application. The checklist already records the missing real-network browser media suite and real-device native media suite. The npm publish workflow runs builds and package-shape checks, but it does not run the full gate or a functional consumer test before publishing.

Done proof: CI packs the release candidate, installs it into a clean example outside the workspace, starts the consumer backend and frontend, and drives two real browser contexts through credential issuance, join, local and remote audio/video, Sync presence, mute/camera changes, one reconnect, and leave. It must assert that media tracks stop, sockets close, secrets stay server-side, and the journey has both success and failure signals. Native needs the equivalent proof on real supported devices before it is advertised.

### 6. There is no usable quickstart or support contract

The root README has development instructions but no customer start. The client README is primarily a product specification and gives no installation-to-call example. The React README documents presentational imports only. React Native has no package README. There is no thin consumer-backend example, credential guide, environment matrix, browser/native support matrix, troubleshooting page, version/deprecation policy, or release migration guide.

Done proof: a new engineer can follow one public web quickstart from an empty application to the two-party call proof without reading repository source. The guide includes server/client boundaries, supported versions, CORS, permissions, error handling, telemetry, teardown, security warnings, and a minimal migration policy.

## Corrections to `product.yaml` and `checklist.md`

The inventories should be corrected before using them to manage launch work:

- Change **React Native provider, hooks, meeting surfaces, and platform bridges** to `false`. Visual surfaces and platform adapters exist, but the exported session they call is placeholder-only, which is explicitly `false` under the inventory's own semantics.
- Change **Anonymous and token-based participant admission** to `false` or split it. Authenticated tenant admission and API-issued Sync tokens exist; anonymous consumer admission does not.
- Change **Integration routes are generated into OpenAPI and SDK artifacts** to `true`. All seven integration operations are present in current generated artifacts.
- Change **All public API routes are represented in OpenAPI and generated SDKs** to `true` if the intended public set is the 69-operation contract asserted by `TestPreviewRouteContracts`. The focused contract test and `pnpm run check:sdk-generated` both passed on 2026-07-20.
- Keep **TypeScript media, sync, and telemetry client** and **Layered React meeting components** as `true`, but do not treat those component-level facts as evidence of an install-to-call SDK.
- Add explicit boolean capabilities for npm publication, the Promise-based meeting facade, production-safe consumer credential exchange, a clean packed-artifact consumer test, a real-network two-party call, and a runnable public quickstart. Their absence let the inventory show strong SDK foundations while missing the actual launch door.

## Recommended finish order

1. **Freeze the first public contract.** Ship managed TypeScript plus React web with room create/join, camera, microphone, Sync presence, reconnect, leave, and safe diagnostics. Defer native and advanced meeting features unless the signed customer requirement says otherwise.
2. **Unblock distribution without publishing stable bits.** Fix npm scope ownership and CI authentication, reserve packages with an `rc` version, and make the workflow run the full release gate plus the clean-consumer test before promotion.
3. **Implement the shared session vertical slice.** Put the Promise facade and state authority in `@q9labsai/chalk-client`; keep React as a thin provider/hooks and presentation layer. Replace the app-local orchestration in the web proof with this public path.
4. **Complete server-to-participant authority.** Add API-key creation, rotation, revocation, hashing, scope enforcement, and HTTP authentication, then implement the short-lived participant credential exchange used by the browser SDK.
5. **Qualify one managed staging stack.** Apply migrations, configure API/Sync token keys and Cloudflare media, add CORS and monitors, run failure/recovery, and prove observability before any production approval.
6. **Make the external example the release test.** Build a tiny consumer backend and React app that depend only on packed artifacts. Drive the two-browser call and failure cases in CI against staging.
7. **Publish the quickstart and release candidate.** Have the waiting consumer install the exact candidate into their application, capture integration failures as tests, then promote the same verified artifacts to the stable tag.

## Launch gate

Chalk's web SDK launch is done only when all of these are observed in the same candidate:

- npm install works from a clean project;
- no workspace imports or tenant secrets reach the browser bundle;
- a consumer backend creates a room/session and issues participant access;
- two browsers join through the public SDK and exchange real camera and microphone media;
- Sync presence and mute/camera state converge, including after one forced reconnect;
- leave stops local tracks, closes media and Sync connections, and prevents stale presence;
- invalid, expired, replayed, and cross-tenant credentials fail with documented typed errors;
- success and failure journeys appear in the qualified observability backend without sensitive data;
- the public quickstart reproduces the flow; and
- the exact published version and qualified production revision are recorded with rollback proof.

Until that gate passes, the accurate customer message is that Chalk exposes development SDK foundations and UI components, not a launch-ready meeting SDK.
