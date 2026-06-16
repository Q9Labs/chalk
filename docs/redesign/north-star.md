# Chalk — North Star

_Goals & constraints for the ground-up redesign. Read this when a decision feels ambiguous — it breaks the tie._

---

## What Chalk is

A real-time video conferencing platform that is flexible at its core. It runs **standalone or embedded** (via our SDK), and **managed or self-hosted**. The media engine is a **swappable component** — Cloudflare today, something else tomorrow — sitting behind one stable contract.

## The three values (these win every tie-break)

1. **Fast** — everything feels instant.
2. **Correct** — sync is robust and never breaks. Non-negotiable.
3. **Low latency** — joining and streaming are low-latency end to end.

> When two designs compete, the one that better serves **Fast + Correct + Low-latency** wins.

---

## Goals — the end state we're building toward

- **Flexible deployment.** The same product runs in our managed cloud _or_ self-hosted by a customer.
- **Two front doors.** A standalone app _and_ an embeddable SDK — both first-class.
- **Swappable media plane.** CF SFU / RealtimeKit / OSS SFU / our own — all plug into one contract. The rest of the system neither knows nor cares which is underneath.
- **Cross-platform.** Web, desktop, mobile, and future surfaces.
- **Scales by grant, not by rebuild.** The same room serves a 2-person call and a webinar. The difference is permissions, not architecture.
- **Carries its feature surface.** Recordings, transcripts, chat, webhooks, audit — preserved through the redesign, not regressed.

---

## Constraints — the lines we don't cross (this is what stops drift)

1. **Self-host is a v1 requirement.** So the portable core depends on **nothing proprietary**. The durable store is **standard Postgres** — no vendor-specific DB features.
2. **Swappable applies to BOTH planes.** The _media_ plane and the _real-time / coordination_ plane each sit behind an interface. Cloudflare Durable Objects (or any vendor) may be an optional adapter — **never the foundation**.
3. **No provider details in core tables.** Rooms / sessions / participants store only opaque provider refs + a provider enum + provider metadata. Cloudflare IDs never sit in core columns.
4. **Real-time state never touches Postgres.** Presence, active-speaker, track up/down live in the coordination plane. Postgres holds durable facts only.
5. **Token-asserted external identity is the primitive.** The embedding customer signs a token asserting _who / which room / what grants_. Native Chalk accounts are **additive** (the dashboard/host path), not the center of gravity.
6. **Anonymous-first joining.** A joiner needs no account. Authentication is an _upgrade_, never a gate.
7. **One tenancy root.** A single entity = the customer / deployment (and the billing + isolation boundary). Not "org AND tenant." Team / workspace grouping is optional, additive, and works the same for every tenant.
8. **Two model invariants.** **Room ≠ Session** (a durable room hosts many sessions over time) and **Participant ≠ User** (a participant is per-session presence that may _point at_ a user). Never collapse either.
9. **Permissions ride the token.** `canPublish` / `canSubscribe` / `canPublishData` / `isHost`. This is how 2-person and webinar share one shape.

---

## Deliberately NOT doing in v1 (so we don't gold-plate)

- **End-to-end encryption.** Privacy matters, but E2E is out of scope for v1. _Guardrail:_ don't build anything that forecloses it — the server never needs to see plaintext media.
