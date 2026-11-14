# Chalk — theory

Correct, fast, flexible real-time collaboration. This file owns the product
model and intended behavior. [design.md](design.md) owns presentation, and
[tracker.yaml](tracker.yaml) lists remaining work. <!-- invariant:spec-ownership -->

## What Chalk is

Chalk is a real-time collaboration and communication layer. A **Space** is the durable place where Users and Agents participate. An **Episode** is one bounded run of activity in that Space, and it leaves immutable artifacts such as a Recording or Transcript. Chalk can run as a standalone product or as an embedded SDK surface, on managed infrastructure or a customer-operated app tier. <!-- invariant:what-chalk-is-space -->

The media plane is replaceable. Cloudflare SFU and the Chalk SFU are adapters behind the same contract, so a provider change never changes Space, Episode, or Participant behavior. <!-- invariant:media-port -->

## The three values

These values win every tie-break, in order: <!-- invariant:the-three-values-these-values-win-every-tie-break-in-order -->

1. **Correct.** Sync is robust and never loses acknowledged state. Correctness gates every other choice. <!-- invariant:the-three-values-correct -->
2. **Fast.** Every state signal feels instant, and the join path carries media with low end-to-end latency. <!-- invariant:the-three-values-fast -->
3. **Flexible.** The media and sync planes stay replaceable, so speed never creates provider lock-in. <!-- invariant:the-three-values-flexible -->

Read the values top down. A less-correct design loses regardless of speed. Among correct designs, the faster one wins, and flexibility breaks the remaining tie. <!-- invariant:the-three-values-read-the-values-top-down -->

## Product goals

- **Flexible deployment.** The same product runs in Chalk's managed cloud or on a customer's own app tier. <!-- invariant:product-goals-flexible-deployment -->
- **Two front doors.** A standalone app and an embeddable SDK are first-class surfaces. <!-- invariant:product-goals-two-front-doors -->
- **Cross-platform parity.** React and React Native expose the same component, prop, hook, event, and vocabulary surface, with differences only at OS or rendering seams.
- **Polyglot contracts.** The language-neutral contract is the source for generated clients and server bindings. TypeScript is the only shipped SDK. <!-- invariant:product-goals-cross-platform-parity -->

## Product memory

These behaviors are part of the product model: <!-- invariant:product-memory-the-clean-model-carries-these-behaviors-forward -->

- **Space lifecycle.** Create, read, update, list, and archive a durable Space. A join link names a Space slug, never an Episode. <!-- invariant:product-memory-space-lifecycle -->
- **Episode lifecycle.** An Episode emerges when a permitted identity joins a Space without a live Episode. It can end explicitly, naturally after the linger window, or at the Space-configured deadline. An ended Episode is immutable. <!-- invariant:product-memory-episode-lifecycle -->
- **Admission.** Token-asserted external identity, signed Space links, the Entrance step before joining, capacity limits, reconnect grace, and explicit admission outcomes are all part of the join path. <!-- invariant:product-memory-admission -->
- **Participants.** A Participant is a per-Episode seat. User, Agent, and Guest identity kinds can occupy a seat, and the same User on two devices has two Participants. <!-- invariant:product-memory-participants -->
- **Capabilities.** Chalk checks capabilities. Roles are customer-defined bundles, with `owner`, `collaborator`, and `observer` as the neutral defaults. UI reads capability state instead of guessing from role names. <!-- invariant:product-memory-capabilities -->
- **Artifacts.** Recording and Transcript jobs retain provider reconciliation, retries, retention, download links, and immutable Episode attachment. Processing is transcript-first: a Recording prepares audio for its Transcript without rendering video, and an MP4 Export renders only when someone requests it. A finished Export is reused, so a second download does not repeat the work. <!-- invariant:product-memory-artifacts -->
- **Identity and tenancy.** Chalk mints its own IDs but mirrors the customer's `external_id`. A Tenant owns Spaces and tenant-level policy. Each Space owns its configuration and Members. <!-- invariant:product-memory-identity-and-tenancy -->

## Constraints

1. **Customer-operated app tier is a v1 requirement.** A customer can operate the API, SyncEngine, and standard Postgres while media continues through a configured MediaPlane adapter. Redis holds only short-lived state such as rate limits, OAuth state, and replay nonces; it is never a source of durable authority, and the durable core uses no vendor-specific database features. <!-- invariant:constraints-customer-operated-app-tier-is-a-v1-requirement -->
2. **Durable facts live in Postgres.** Ordered control state, receipts, lifecycle intent, and Episode artifacts are durable. Presence, active-speaker hints, cursors, and track telemetry remain coordination signals. <!-- invariant:constraints-durable-facts-live-in-postgres -->
3. **AccessGrant is opaque.** A customer's server receives the signed envelope and forwards it unchanged. Browser code never mints or inspects grant contents. <!-- invariant:constraints-accessgrant-is-opaque -->
4. **Join targets the Space.** No explicit create or start operation is a prerequisite for an allowed identity to join. At most one Episode is live in a Space. <!-- invariant:constraints-join-targets-the-space -->
5. **One tenancy root.** A Tenant is the customer and isolation boundary. Optional teams or workspaces group data without creating a second authority. <!-- invariant:constraints-one-tenancy-root -->
6. **Space and Episode own different facts.** Space owns identity, config, members, living chat, and whiteboard content. Episode owns attendance, its config snapshot, and artifacts. A Participant belongs to one Episode and is not a User or Agent row. <!-- invariant:constraints-space-and-episode-own-different-facts -->
7. **Capabilities travel with access.** `SpaceSnapshot` exposes the current capability set; commands use `useCan` or the corresponding `SpaceClient` controller. Client assertions never grant authority. <!-- invariant:constraints-capabilities-travel-with-access -->
8. **Clean break.** The public model has one vocabulary and one set of routes. Compatibility aliases and legacy names are not part of the product. <!-- invariant:constraints-clean-break -->
9. **Retention is tenant-configurable.** A Tenant sets retention per Recording, Transcript, and chat stream. A hard-delete request overrides retention and purges the artifact. <!-- invariant:constraints-retention-is-tenant-configurable -->
10. **Media egress is measurable.** The MediaPlane exposes egress and Participant-minute usage so cost can be measured per Tenant and Episode and bounded by policy. <!-- invariant:constraints-media-egress-is-measurable -->

## Identity and membership

The domain has two durable identity kinds, **User** and **Agent**, plus the temporary **Guest** identity. A **Member** is a durable assignment of a User or Agent to a Space and carries a Role. Chalk mirrors the embedding customer's identity authority and never becomes the source of end-user identity. <!-- invariant:identity-and-membership-user -->

## Roles and capabilities

The system checks **Capabilities**, while a customer names bundles as **Roles**. The default role bundles are `owner`, `collaborator`, and `observer`; a customer can define another name without changing enforcement. `Permission` is reserved for OS and browser device grants. <!-- invariant:roles-and-capabilities-capabilities -->

Identity and authority stay separate. A Guest can receive a capability for one Episode, while a Member keeps standing Space access. UI renders from `SpaceSnapshot` and never infers authority from a role label. <!-- invariant:identity-authority -->

## Sync correctness

Postgres is the durable authority. A transaction locks one Tenant-scoped Episode control row and atomically writes the next event, folded state, and command receipt. WebSocket nodes are disposable fanout: node loss causes reconnect and authoritative recovery without acknowledged state loss. Recovery is a digest-checked snapshot, bounded replay, or up-to-date response, with database notifications treated as hints. <!-- invariant:sync-authority -->

## Deliberate v1 exclusions

- **End-to-end encryption.** The server does not need plaintext media, but full E2E remains outside the v1 proof. <!-- invariant:deliberate-v1-exclusions-end-to-end-encryption -->
- **Webinar broadcasting.** Viewer-only roles and cascade tiers are outside the v1 surface. Existing publish and subscribe capabilities remain the extension seam. <!-- invariant:deliberate-v1-exclusions-webinar-broadcasting -->
- **Enterprise identity federation.** SSO, SAML, and OIDC remain outside the current native auth proof. <!-- invariant:deliberate-v1-exclusions-enterprise-identity-federation -->
- **Legal hold.** Compliance retention that blocks deletion is outside the current retention contract. <!-- invariant:deliberate-v1-exclusions-legal-hold -->
- **Tenant-signed identity assertions.** Per-Tenant, rotatable signing keys for identity assertions come after v1. Until then, one deployment-wide key signs access tokens. <!-- invariant:deliberate-v1-exclusions-tenant-signed-identity-assertions -->
