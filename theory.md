# Chalk — theory

Correct, fast, flexible real-time collaboration. This file owns the product
model and intended behavior. [tracker.yaml](tracker.yaml) owns implementation
status; [tracker-human.md](tracker-human.md)
is its generated view. [design.md](design.md) owns presentation. <!-- invariant:spec-ownership -->

Targets below are requirements, not measured performance claims. <!-- invariant:targets-not-measurements -->

## What Chalk is

Chalk is a real-time collaboration and communication layer. A **Space** is the durable place where Users and Agents participate. An **Episode** is one bounded run of activity in that Space, and it leaves immutable artifacts such as a Recording or Transcript. Chalk can run as a standalone product or as an embedded SDK surface, on managed infrastructure or a customer-operated app tier. <!-- invariant:what-chalk-is-space -->

The media plane is replaceable. Cloudflare SFU is the current adapter, and another provider can implement the same contract without changing Space, Episode, or Participant behavior. <!-- invariant:media-port -->

## The three values

These values win every tie-break, in order: <!-- invariant:the-three-values-these-values-win-every-tie-break-in-order -->

1. **Correct.** Sync is robust and never loses acknowledged state. Correctness gates every other choice. <!-- invariant:the-three-values-correct -->
2. **Fast.** Every state signal feels instant, and the join path carries media with low end-to-end latency. <!-- invariant:the-three-values-fast -->
3. **Flexible.** The media and sync planes stay replaceable, so speed never creates provider lock-in. <!-- invariant:the-three-values-flexible -->

Read the values top down. A less-correct design loses regardless of speed. Among correct designs, the faster one wins, and flexibility breaks the remaining tie. <!-- invariant:the-three-values-read-the-values-top-down -->

## Product goals

- **Flexible deployment.** The same product runs in Chalk's managed cloud or on a customer's own app tier. <!-- invariant:product-goals-flexible-deployment -->
- **Two front doors.** A standalone app and an embeddable SDK are first-class surfaces. <!-- invariant:product-goals-two-front-doors -->
- **One public web surface.** `@q9labsai/chalk-client` supplies `SpaceClient` and `AccessGrant`; `@q9labsai/chalk-react` supplies `ChalkProvider`, the closed hook set, `Entrance`, and the turnkey `<Chalk />` component. <!-- invariant:product-goals-one-public-web-surface -->
- **Cross-platform parity.** React and React Native expose the same component, prop, hook, event, and vocabulary surface, with differences only at OS or rendering seams. <!-- invariant:product-goals-cross-platform-parity -->
- **Polyglot contracts.** The language-neutral contract is the source for generated clients and server bindings. TypeScript is the shipped SDK today; more language targets can consume the same contract when they have complete proof. <!-- invariant:product-goals-polyglot-contracts -->
- **Replaceable media.** A MediaPlane adapter owns provider details while the public model stays Space, Episode, and Participant. <!-- invariant:product-goals-replaceable-media -->
- **Complete collaboration.** Chat, reactions, whiteboard, files, Recording, Transcript, webhooks, diagnostics, and public status remain part of the product surface. <!-- invariant:product-goals-complete-collaboration -->

## Product memory

The clean model carries these behaviors forward: <!-- invariant:product-memory-the-clean-model-carries-these-behaviors-forward -->

- **Space lifecycle.** Create, read, update, list, and archive a durable Space. A join link names a Space slug, never an Episode. <!-- invariant:product-memory-space-lifecycle -->
- **Episode lifecycle.** An Episode emerges when a permitted identity joins a Space without a live Episode. It can end explicitly, naturally after the linger window, or at the Space-configured deadline. An ended Episode is immutable. <!-- invariant:product-memory-episode-lifecycle -->
- **Admission.** Token-asserted external identity, signed Space links, the `Entrance` preparation surface, capacity limits, reconnect grace, and explicit admission outcomes are all part of the join path. <!-- invariant:product-memory-admission -->
- **Participants.** A Participant is a per-Episode seat. User, Agent, and Guest identity kinds can occupy a seat, and the same User on two devices has two Participants. <!-- invariant:product-memory-participants -->
- **Capabilities.** Chalk checks capabilities. Roles are customer-defined bundles, with `owner`, `collaborator`, and `observer` as the neutral defaults. UI reads capability state instead of guessing from role names. <!-- invariant:product-memory-capabilities -->
- **Live sync.** Presence, active speaker, media signals, hand raise, reactions, chat, whiteboard updates, snapshots, recovery, and Episode-end signals travel through the SyncEngine. <!-- invariant:product-memory-live-sync -->
- **Media.** The Cloudflare SFU adapter is first, while provider references remain opaque and the MediaPlane exposes usage and cost signals. <!-- invariant:product-memory-media -->
- **Artifacts.** Recording and Transcript jobs retain provider reconciliation, retries, retention, download links, and immutable Episode attachment. Processing is transcript-first: a Recording prepares audio for its Transcript without rendering video, and an MP4 Export renders only when someone requests it. A finished Export is reused, so a second download does not repeat the work. <!-- invariant:product-memory-artifacts -->
- **Identity and tenancy.** Chalk mints its own IDs but mirrors the customer's `external_id`. A Tenant owns Spaces and tenant-level policy. Each Space owns its configuration and Members. <!-- invariant:product-memory-identity-and-tenancy -->
- **Webhooks.** Customer-facing events use versioned schemas, raw-body signature verification, retries, idempotency, delivery history, and auditability. <!-- invariant:product-memory-webhooks -->
- **Operations.** Health checks, diagnostics, journey telemetry, public status projection, maintenance, incident intake, and useful SDK export context ship with the behavior they explain. <!-- invariant:product-memory-operations -->

## Constraints

1. **Customer-operated app tier is a v1 requirement.** A customer can operate the API, SyncEngine, and standard Postgres while media continues through a configured MediaPlane adapter. Redis holds only short-lived state such as rate limits, OAuth state, and replay nonces; it is never a source of durable authority, and the durable core uses no vendor-specific database features. A Cloudflare-free media adapter remains a separate qualification. <!-- invariant:constraints-customer-operated-app-tier-is-a-v1-requirement -->
2. **Both planes are ports.** `CloudflareMediaPlaneAdapter` and `SyncEngine` are implementations behind stable contracts. Provider specifics stay at adapter boundaries. <!-- invariant:constraints-both-planes-are-ports -->
3. **Core data stays provider-neutral.** Space, Episode, and Participant records hold opaque provider references and provider metadata, never provider-specific identity in the domain model. <!-- invariant:constraints-core-data-stays-provider-neutral -->
4. **Durable facts live in Postgres.** Ordered control state, receipts, lifecycle intent, and Episode artifacts are durable. Presence, active-speaker hints, cursors, and track telemetry remain coordination signals. <!-- invariant:constraints-durable-facts-live-in-postgres -->
5. **AccessGrant is opaque.** A customer's server receives the signed envelope and forwards it unchanged. Browser code never mints or inspects grant contents. <!-- invariant:constraints-accessgrant-is-opaque -->
6. **Join targets the Space.** No explicit create or start operation is a prerequisite for an allowed identity to join. At most one Episode is live in a Space. <!-- invariant:constraints-join-targets-the-space -->
7. **One tenancy root.** A Tenant is the customer and isolation boundary. Optional teams or workspaces group data without creating a second authority. <!-- invariant:constraints-one-tenancy-root -->
8. **Space and Episode own different facts.** Space owns identity, config, members, living chat, and whiteboard content. Episode owns attendance, its config snapshot, and artifacts. A Participant belongs to one Episode and is not a User or Agent row. <!-- invariant:constraints-space-and-episode-own-different-facts -->
9. **Capabilities travel with access.** `SpaceSnapshot` exposes the current capability set; commands use `useCan` or the corresponding `SpaceClient` controller. Client assertions never grant authority. <!-- invariant:constraints-capabilities-travel-with-access -->
10. **Clean break.** The public model has one vocabulary and one set of routes. Compatibility aliases and legacy names are not part of the product. <!-- invariant:constraints-clean-break -->
11. **Retention is tenant-configurable.** A Tenant sets retention per Recording, Transcript, and chat stream. A hard-delete request overrides retention and purges the artifact. <!-- invariant:constraints-retention-is-tenant-configurable -->
12. **Media egress is measurable.** The MediaPlane exposes egress and Participant-minute usage so cost can be measured per Tenant and Episode and bounded by policy. <!-- invariant:constraints-media-egress-is-measurable -->

## Identity and membership

The domain has two durable identity kinds, **User** and **Agent**, plus the temporary **Guest** identity. A **Member** is a durable assignment of a User or Agent to a Space and carries a Role. Chalk mirrors the embedding customer's identity authority and never becomes the source of end-user identity. <!-- invariant:identity-and-membership-user -->

The public SDK uses the same Space model on web and React Native: <!-- invariant:sdk-space-model -->

```tsx
import type { GetAccess } from "@q9labsai/chalk-client";
import { Chalk } from "@q9labsai/chalk-react";

export function SpaceSurface({ getAccess }: { getAccess: GetAccess }) {
  return <Chalk space="design-review" getAccess={getAccess} />;
}
```

For custom UI, create a `SpaceClient`, pass it to `ChalkProvider`, and read the closed hook set: `useSpaceClient`, `useConnection`, `useSelf`, `useParticipants`, `useMedia`, `useChat`, `useReactions`, `useRecording`, `useWhiteboard`, and `useCan`. <!-- invariant:sdk-hooks -->

An embedding customer can reuse one API key across several products, so the SDK carries an optional **app name**: a static label for the calling application. It is one top-level `appName` string with the same name on `createChalkEffectClient`, `createSpaceClient`, and `<Chalk />`, and an optional `app` on an AccessGrant request so the Episode and Participant inherit it. It is deliberately not telemetry configuration: telemetry options cover per-request correlation and exporter setup, while the app name is client identity that must travel even when telemetry is off. The transport sends it beside the journey ID, and the API stamps it on request spans and logs. Because it becomes a metric and log dimension, the server bounds its cardinality: trimmed, normalized to `[a-z0-9._-]`, capped near 64 characters, and dropped when empty. <!-- invariant:app-name -->

## Roles and capabilities

The system checks **Capabilities**, while a customer names bundles as **Roles**. The default role bundles are `owner`, `collaborator`, and `observer`; a customer can define another name without changing enforcement. `Permission` is reserved for OS and browser device grants. <!-- invariant:roles-and-capabilities-capabilities -->

Identity and authority stay separate. A Guest can receive a capability for one Episode, while a Member keeps standing Space access. UI renders from `SpaceSnapshot` and never infers authority from a role label. <!-- invariant:identity-authority -->

## Performance budget

Every state signal is sync-plane and near-instant; media remains physics-bound. <!-- invariant:performance-budget-every-state-signal-is-sync-plane-and-near-instant -->

- **Join path:** click join, fetch an `AccessGrant`, and establish media in under 1 second at p50 and 2.5 seconds at p95. Access lookup stays under 100ms p95, ICE/DTLS to the SFU under 500ms p95, and the first frame uses the remainder. <!-- invariant:performance-budget-join-path -->
- **Sync and control:** mute, hand raise, reactions, active speaker, presence, chat, and screen-share signals target under 100ms p95 in-region. <!-- invariant:performance-budget-sync-and-control -->
- **Media:** glass-to-glass latency targets under 200ms in-region; a newly published track renders for other Participants under 500ms. <!-- invariant:performance-budget-media -->
- **API reads:** Space and Episode reads target under 200ms p95. <!-- invariant:performance-budget-api-reads -->
- **Artifacts:** Recording and Transcript availability is a durability guarantee, not a latency SLO. Providers can determine the eventual completion time. <!-- invariant:performance-budget-artifacts -->

## Sync correctness

Postgres is the durable authority. A transaction locks one Tenant-scoped Episode control row and atomically writes the next event, folded state, and command receipt. WebSocket nodes are disposable fanout: node loss causes reconnect and authoritative recovery without acknowledged state loss. Recovery is a digest-checked snapshot, bounded replay, or up-to-date response, with database notifications treated as hints. <!-- invariant:sync-authority -->

## Deliberate v1 exclusions

- **End-to-end encryption.** The server does not need plaintext media, but full E2E remains outside the v1 proof. <!-- invariant:deliberate-v1-exclusions-end-to-end-encryption -->
- **Webinar broadcasting.** Viewer-only roles and cascade tiers are outside the v1 surface. Existing publish and subscribe capabilities remain the extension seam. <!-- invariant:deliberate-v1-exclusions-webinar-broadcasting -->
- **Enterprise identity federation.** SSO, SAML, and OIDC remain outside the current native auth proof. <!-- invariant:deliberate-v1-exclusions-enterprise-identity-federation -->
- **Legal hold.** Compliance retention that blocks deletion is outside the current retention contract. <!-- invariant:deliberate-v1-exclusions-legal-hold -->
- **Tenant-signed identity assertions.** Per-Tenant, rotatable signing keys for identity assertions come after v1. Until then, one deployment-wide key signs access tokens. <!-- invariant:deliberate-v1-exclusions-tenant-signed-identity-assertions -->

## Tracker maintenance

tracker.yaml owns current status. Each entry is one Participant-visible or operational outcome with a plain title, a one- or two-sentence summary of what exists and what's missing, and the concrete steps left. Entries are deliberately unplanned: scoping and design happen when someone picks the work up. Evidence, test runs and verification logs live in docs or scratch notes, not in the tracker. The owner sets priority.

Split an entry when its steps can ship separately, and merge entries that duplicate work. Put a step in the entry that must finish first. Delete an entry when its work is done: the code is the record of what works.

## Test index

<!-- test:constraints-clean-break sdks/typescript/client/src/access/grant.test.ts#rejects legacy subject aliases instead of widening the current wire contract -->
<!-- test:product-memory-identity-and-tenancy sdks/typescript/client/src/tenant-external-id.test.ts#creates and finds a Tenant with an opaque external account ID through the generated client -->
<!-- test:constraints-one-tenancy-root apps/api/internal/adapters/postgres/authz_route_matrix_test.go#TestAuthorizationRouteMatrix -->
<!-- test:product-goals-polyglot-contracts apps/api/cmd/codegen/contracts_test.go#TestGeneratedOpenAPIMatchesEndpointContracts -->
<!-- test:sync-authority apps/sync/test/chalk_sync/reliability/recovery_contract_test.exs#commands survive every crash boundary -->
