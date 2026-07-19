# Chalk — North Star

_Goals & constraints for the ground-up redesign. Read this when a decision feels ambiguous — it breaks the tie._

> This document describes the intended end state, not current release readiness. See [`product.yaml`](../../product.yaml) or [`checklist.md`](../../checklist.md) for the evidence-backed implementation inventory.

---

## What Chalk is

A real-time video conferencing platform that is flexible at its core. It runs **standalone or embedded** (via our SDK), and **managed or self-hosted**. The media engine is a **swappable component** — Cloudflare today, something else tomorrow — sitting behind one stable contract.

## The three values (these win every tie-break, in this order)

1. **Correct** — sync is robust and never breaks. **Non-negotiable; gates first.** A faster or simpler design that weakens correctness loses outright.
2. **Fast** — perceived responsiveness. Every state signal feels instant; the join funnel and media are low-latency end to end.
3. **Flexible** — the swappable planes and dual front doors stay swappable. We don't buy speed with lock-in.

> Read top-down, not as a sum. Correct gates: if a design is less correct, it loses no matter how fast. Among correct designs, the faster one wins; Flexible breaks remaining ties.

---

## Goals — the end state we're building toward

- **Flexible deployment.** The same product runs in our managed cloud _or_ self-hosted by a customer.
- **Two front doors.** A standalone app _and_ an embeddable SDK — both first-class.
- **Polyglot SDKs.** The embeddable SDK ships in **many languages**, not just TypeScript — TS today, then Swift / Kotlin / Python / Go and beyond. The client↔server contract is therefore **language-neutral by construction**: no SDK language is privileged, and the server's own language is an internal implementation detail decoupled from any SDK's. One schema source of truth generates every SDK _and_ the server's contract types — adding a language is a new generation target, never a protocol fork.
- **Swappable media plane.** CF SFU / self-hosted OSS SFU / our own — all plug into one contract. The rest of the system neither knows nor cares which is underneath.
- **Cross-platform.** Web, desktop, mobile, and future surfaces.
- **Scales by grant, not by rebuild.** One room shape serves a 2-person call today; webinars (deferred) slot onto the same shape later via grants, not a rebuild.
- **Carries its feature surface.** Recordings, transcripts, chat, webhooks, audit, whiteboard, files, diagnostics, and public status — preserved through the redesign, not regressed.

---

## Rebuild memory — do not forget these surfaces

The old API and Terraform stack are being torn down. This is the product/control-plane memory to carry forward into the clean rebuild.

- **Meeting core:** create, schedule, list, update, end, and reuse rooms through the stricter **Room -> Session -> ParticipantSession** model; anonymous join stays first-class.
- **Join/admission:** token-asserted external identity, signed public join links, host-created invite tokens, lobby/waiting room, capacity limits, duplicate external-user handling, reconnect grace, and explicit admission failure reasons.
- **Roles/capabilities:** org roles stay separate from meeting capabilities; host/co-host/participant presets resolve to server-enforced capability bits.
- **Live sync:** WebSocket/control-plane state for presence, active speaker, media signals, hand raise, reactions, chat, recording state, whiteboard grants, snapshots, reconnect/resume, and room-end signals.
- **Media plane:** Cloudflare SFU adapter first, but provider references stay opaque and the MediaPlane contract exposes usage/cost signals.
- **Recordings:** host-controlled start/stop, one active recording per session, provider webhook/reconciliation, stalled-recording recovery, download/share links, archival/retention, hard delete, and R2-backed artifact storage.
- **Transcription:** this must survive the rewrite. Include live transcript persistence, post-meeting transcription queueing, provider registry, callback verification, retry/dead-letter semantics, transcript lookup by recording, status/progress, language/provider metadata, and future summarization hooks.
- **Chat and files:** durable room chat, read state, attachments, whiteboard file upload/download, storage access through presigned URLs, and tenant retention rules.
- **Whiteboard:** collaboration state, persisted snapshots, file assets, draw grants, and multi-instance-safe permission enforcement.
- **Tenant/admin:** tenant root, API key rotation, token-signing key rotation, tenant config, allowed origins/CORS management, workspace/team grouping, usage and artifact retention.
- **Internal app:** native Chalk user sessions, Google sign-in path, access-token refresh, internal meetings list, share pages, and first-party hosted app auth.
- **Webhooks:** customer-facing post-meeting and recording webhooks with signed delivery, retries, idempotency, delivery history, and auditability.
- **Ops/diagnostics:** health/debug endpoints, client incident intake, public status page/card, ops ingest, maintenance/incidents, and enough debug export context for SDK/mobile support.
- **Security/privacy:** audit logs, scoped tokens, revocation/kick semantics that immediately affect REST and WS, no raw logs/secrets in public repo, tenant isolation, retention caps, hard-delete override.

Non-goal for the rebuild: preserve today's tables, route shapes, Terraform modules, or worker implementations. Preserve the product behavior and hard-won lessons, not the old code.

---

## Constraints — the lines we don't cross (this is what stops drift)

1. **Self-host is a v1 requirement — in two tiers.** _v1 (app-tier self-host):_ the customer self-hosts the **app tier** (API + WS sync + Postgres) and embeds the SDK; media still flows through CF SFU via the MediaPlane adapter. Redis is an optional accelerator, never a required authority. _Later (full self-host):_ Cloudflare-free, including the media plane (DigitalOcean SFU adapter). Either way the portable core depends on **nothing proprietary** — the durable store is **standard Postgres**, no vendor-specific DB features. _Don't block v1 launch waiting on the fully-self-hosted media tier._
2. **Swappable applies to BOTH planes — two ports.** **MediaPlane** (primary: `CloudflareMediaPlaneAdapter`, CF SFU direct; later: DigitalOcean self-hosted SFU) and **SyncEngine** (primary: custom WebSocket sync + Postgres; later: `DurableObjectSyncAdapter`). Vendor specifics live in adapters — **never the foundation**. Stack details: `scratchpad/chalk-architecture-decision-2026-06-16.md`.
3. **No provider details in core tables.** Rooms / sessions / participants store only opaque provider refs + a provider enum + provider metadata. Cloudflare IDs never sit in core columns.
4. **Durable sync facts live in Postgres; volatile signals do not.** Ordered control state, receipts, and lifecycle intent are durable facts. Presence, active-speaker, cursor, and track telemetry live only in the coordination plane.
5. **Token-asserted external identity is the primitive.** The embedding customer signs a token asserting _who / which room / what grants_. Native Chalk accounts are **additive** (the dashboard/host path), not the center of gravity.
6. **Anonymous-first joining.** A joiner needs no account. Authentication is an _upgrade_, never a gate.
7. **One tenancy root.** A single entity = the customer / deployment (and the billing + isolation boundary). Not "org AND tenant." Team / workspace grouping is optional, additive, and works the same for every tenant.
8. **Two model invariants.** **Room ≠ Session** (a durable room hosts many sessions over time) and **Participant ≠ User** (a participant is per-session presence that may _point at_ a user). Never collapse either.
9. **Permissions ride the token.** `canPublish` / `canSubscribe` / `canPublishData` / `isHost`. The grant seam that lets webinars slot in later (deferred) without a rebuild.
10. **Clean break.** No migration, no backward-compat with today's schema — design the ideal model; we owe the old tables nothing.
11. **Retention is tenant-configurable.** Each tenant sets retention per artifact (recordings / transcripts / chat). Two fixed guardrails: hard-delete-on-request always overrides retention and truly **purges**; a plan quota may cap the configurable maximum.
12. **Tenants sign their own participant tokens** with **per-tenant, rotatable** keys (overlapping keys during rotation, zero downtime). Chalk never accepts client-asserted identity without a valid signature.
13. **Media-egress cost is a first-class constraint.** The dominant cost is media egress, and it never gets to hide. The **MediaPlane contract must expose usage signal** (egress GB, participant-minutes) so cost is measurable per tenant / session and a ceiling can be enforced — no adapter may bury it. Cost never overrides **Correct**, but among correct designs it is a real input, not an afterthought (see media cost calculator).

---

## Tenancy & identity

Internal names: **Tenant** (the root) and **User** (the person). "Org / account / workspace / team" are UI words mapped onto these — never new tables.

- **Tenant** _(UI: Organization)_ — the root: isolation + billing boundary; holds API keys / token-signing creds + media config. **Required** — every tenant-scoped resource belongs to exactly one. SDK customer, self-host install, and one person's personal space are all the same Tenant, distinguished by `kind`.
- **User** _(UI: Account)_ — a native authenticated person; a **global** identity (one per human/email) belonging to 0..N tenants via Membership. **Optional** — SDK and anonymous paths never need one. _The one exception to "everything belongs to a tenant": identity sits above tenancy._
- **Workspace** _(UI: Team)_ — optional sub-grouping inside a tenant; a tenant may have zero.
- **Membership** — binds a User into a Tenant (and optionally a Workspace) with an **org role** (owner / admin / member). No membership = a floating identity.

**Two identity planes, never mixed:** a **User** is who you are _to Chalk_ (global, optional); a **Participant** is who you are _in one meeting_ (per-session; token-asserted claim is the primitive; may link to a User; may be anonymous). A participant may point at a user — it is never the same row.

---

## Roles & permissions

**Two role planes, independent:** _org roles_ (on Membership — power over the tenant) vs _meeting roles_ (on the participant/token, per session — power inside a call). A tenant-owner is **not** automatically host of someone else's meeting.

**Identity ⊥ role:** anonymous / user / external-identity is _who you are_; host / co-host / participant is _what you can do_. A guest can be a host; a logged-in user can be a plain participant. "Guest" is never a role.

**Core meeting roles** (webinars deferred → no viewer tier):

- **Host** — the Session's one host authority; may transfer host when the immutable role mapping grants the corresponding capability.
- **Co-host / moderator** — delegated conference authority within the immutable Session capability mapping; never acquires host authority implicitly except through the configured host-exit policy.
- **Participant** — the ordinary conference preset, with its exact authority determined by the same Session mapping.

**Mechanics:** a role is a named **preset over a capability set**. A tenant-signed participant token carries `initial_role` and `eligible_roles`; the immutable Session role-to-capability mapping resolves current authority. MediaPlane / SyncEngine derive and enforce that authority server-side on every operation, never from client-asserted capabilities. Webinar roles can slot in later as new presets without changing that enforcement boundary.

**Core-conference capabilities:** `publishAudio` · `publishVideo` · `publishScreen` · `subscribe` · `raiseHand` · `renameSelf` · `manageAdmission` · `promoteDemote` · `transferHost` · `muteOthers` · `stopVideoOthers` · `stopScreenOthers` · `requestMediaOthers` · `removeParticipant` · `manageRecording` · `endMeeting`. Chat, reactions, drawing, and other collaboration capabilities remain owned by their separate streams.

**Settled for Sync v3:** admission is `open | approval | closed`; screen sharing has one serialized active lease; a no-account guest can be host because authority comes from the signed role envelope rather than identity; and host succession is an immutable per-Session policy. `require_transfer` rejects the sole host's explicit leave until host authority is transferred or the Session ends. `promote_cohost` atomically promotes the longest-tenured active co-host, using Participant ID as the deterministic tie-breaker, and falls back to `require_transfer` when no co-host is active. A disconnect is presence loss rather than an explicit leave, so it never transfers host authority or ends the meeting. Only the tenant control plane may change a Session deadline, and every change advances its durable generation exactly once.

---

## Performance budget (the SLOs)

**The rule: every state _signal_ is sync-plane and near-instant; only audio/video _media_ is physics-bound.**

- **Join funnel** (the money path): click-join → media flowing **< 1s p50 / < 2.5s p95** — token + session lookup/create < 100ms p95 · ICE/DTLS to SFU < 500ms p95 · first frame = remainder.
- **Sync / control plane — < 100ms p95** (aim ~50ms in-region): mute, hand-raise, reactions, active-speaker, presence, chat & data, screen-share signals. _(Active-speaker carries an intentional ~150ms detection debounce on top — UX, not latency.)_
- **Media plane — physics-bound:** glass-to-glass < 200ms same-region; a newly-published track renders for others < 500ms.
- **Dashboard / API reads — < 200ms p95** (aim < 100ms).
- **Recording / transcript ready — _not_ a latency SLO:** a durability + eventual-availability guarantee (never silently lost; soft target ≤ ~1× media duration; gated on external providers).

---

## Sync correctness (value #2, made concrete)

- **Postgres is the single durable authority.** A semantic transaction locks one tenant-scoped Session control row and atomically writes the exact-next event, folded state, and stable command receipt.
- **WS nodes are disposable fanout.** A connection is sticky to its node, while coordinators and queues remain rebuildable projections. Node loss causes reconnect and authoritative recovery with zero acknowledged state loss.
- **Postgres serializes each Session.** Connections and commands may reach any node; no application writer lease or cluster-wide process identity exists.
- **Reconnect is digest-checked snapshot, bounded replay, or up-to-date recovery.** PostgreSQL notifications are hints and periodic head reads repair every missed hint.

---

## Deliberately NOT doing in v1 (so we don't gold-plate)

- **End-to-end encryption.** Privacy matters, but E2E is out of scope for v1. _Guardrail:_ don't build anything that forecloses it — the server never needs to see plaintext media.
- **Webinars** — and with them the **viewer / audience (watch-only) role** and any broadcast / cascade tier. The `canPublish` / `canSubscribe` grants stay as the seam so it's additive, not foreclosed.
- **SSO / SAML / OIDC** — native auth stays email/OAuth-simple; don't foreclose it.
- **Legal hold** (compliance block-on-deletion, the inverse of retention) — later, enterprise.
