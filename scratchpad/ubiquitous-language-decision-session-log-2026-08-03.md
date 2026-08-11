# Ubiquitous language decision session — 2026-08-02/03

Hasan + Claude, live working session with pen and paper. This log records the
rulings, the reasoning, and the method so the work can continue in any future
session without re-litigating. The rulings here are Hasan's; the repo-root
glossary drafted from them will be the normative home. Until then this log is
the most current statement of the language.

## Vision (Hasan's framing, verbatim in spirit)

Chalk is **not** a video-conferencing or meetings product. It is a **real-time
collaboration and communication layer**, tailored to many use cases: video
conferences, classrooms, embedded collaboration surfaces inside other software.
The core primitive is **joining a shared place** and communicating visually,
audibly, textually — plus screen share and (future) whiteboard. **Agents are
first-class**: proactive assistants and representatives participate as peers,
not as bolted-on bots. Naming must reflect this breadth, not the meetings past.

Positioning vs Miro (asked during session): layer vs destination;
communication-first vs canvas-first; agents as participants vs AI-as-tool; and
Chalk's persistent artifacts are what _happened_ (Episodes → recordings,
transcripts), not just what was made. True head-to-head competitors are
LiveKit/Daily/100ms; the differentiators are turnkey experiences, first-class
agents, and coherent language.

## Method / philosophy established

- Two distinct diseases: **language drift** (one concept, many names) needs
  central taste decisions; **bad names** (lying/mechanical names) is per-surface
  hygiene work delegable after the vocabulary is fixed.
- Ubiquitous language is per bounded context. Chalk has **one core context**
  spanning DB → API → sync wire → SDK → UI → docs → marketing → agents.
  Vendored/standard terms (WebRTC "track", CallKit, Cloudflare SFU) stay foreign
  with translation tables at adapter seams.
- **Naming grammar**: every name = _domain root_ × _layer shape_
  (`EpisodeSnapshot`, `EpisodeEndedEvent`, `episode.not-found`, `/spaces/{id}`,
  plural-snake tables, UI shape suffixes Panel/Dialog/Screen/Picker/Indicator).
- **Incumbents must earn their seat** — tests used per candidate: fit-to-vision,
  collision (esp. within Chalk's own stack), verb naturalness, artifact
  phrasing, seriousness/register, industry legibility. Majority usage in the
  codebase does **not** decide (Hasan's explicit rule — the census measures the
  past, naming serves the direction).
- **Layer/product split**: the platform speaks the domain language with zero
  exceptions; packaged experiences and future product features may carry their
  own names built on top.
- Docs are pointers, never sources of truth. A doc may be _normative_ only if
  something enforces it (CI, codegen); otherwise it is a dated descriptive
  snapshot. `sdks/ubiquitous-language.md` (v4) is explicitly **not** SOT —
  its _grammar_ half is good and likely to be ratified; its _vocabulary_ is
  superseded by the rulings below.
- No users yet → outright renames everywhere, no compat aliases, no versioned
  seams. Enforcement plan: repo-root glossary + CI **ratchet** (banned-term
  counts per surface may only decrease; waves drive them to zero, then lock).

## Rulings (locked)

| #   | Question                                     | Ruling                                                                                                                         | Key reasoning / rejected candidates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The durable place                            | **Space**                                                                                                                      | Matches "collaboration space" vision verbatim; use-case-neutral. Rejected: Room (meeting-flavored incumbent), Board (collides with whiteboard feature).                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2   | The bounded episode of live activity         | **Episode**                                                                                                                    | Hasan's own out-of-box idea, survived testing: collision-free (unlike session: auth/HTTP/WebRTC/`ChalkSession` overload), best artifact story ("episode recording", a Space's history is a series). Condition: **join targets the Space**, never the episode, so "join an episode" is never uttered. Rejected: Session (overloaded), Gathering (clunky derivatives).                                                                                                                                                                                                                                                      |
| 3   | Fate of "meeting"                            | **Dead everywhere** — code, infra, docs, _and_ marketing copy                                                                  | Hasan chose the strictest option over my rec (allow in use-case prose). Store listing and all copy get reworded around Spaces/Episodes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | Turnkey UI component (was `VideoConference`) | **`<Chalk />`**                                                                                                                | The turnkey IS Chalk-in-your-app; Intercom-widget / `<Cal />` pattern; "drop a `<Chalk />` into your app" is demo+README+pitch. Interior tree is platform-named (`SpaceView`, `Stage`, panels) since `Chalk*` prefixes are banned on shared symbols. Rejected: Slate (Slate.js `<Slate>` provider collision), Surface (design-system vocab), Studio (editor-tool connotation), Venue (fourth place-noun confusion), Chalkboard (whiteboard collision), Agora (competitor).                                                                                                                                                |
| 5   | Roster + identities                          | **Participant** (sole roster noun, kind-neutral) over **User / Agent / guest**; **Bot, Assistant, AI banned as domain nouns**  | Participant earned its seat: native verb, kind-neutral, industry-legible, collision-free. Rejected: Peer (RTCPeerConnection), Actor (Elixir actor-model collision in sync), Collaborator (durable-relationship reading), Attendee (meeting-scented). **Member split (durable Space belonging) considered and shelved "not for now"** — revisit when Space ACLs force it. Agent = durable non-human identity, full peer of User: same lifecycle, capabilities, media rights. Proactive assistants are products built on Agent.                                                                                             |
| 6   | Live availability                            | **Presence**                                                                                                                   | Earned incumbent (XMPP/Matrix/Slack precision). Rejected: Signal (RTC signaling — fatal), Heartbeat/Liveness (infra collisions), Aura (register), Occupancy (facilities tone). **Pulse parked** as future product name for the Space-level aggregate ("the pulse of a Space").                                                                                                                                                                                                                                                                                                                                            |
| 7   | Authority                                    | **Capability** (mechanics) + **Role** (customer-definable named bundle) + shipped defaults **owner / collaborator / observer** | Capabilities are what the system checks; roles are what humans name; UI renders from capabilities, never infers from role names. No built-in "host"/"admin"/"member". Customers name their own roles ("teacher", "host" become _their_ config vocabulary). Defaults are Google-Docs-legible and use-case-neutral; apply to Agents equally. Rejected: Keys (credential collision), Powers (viable, Matrix precedent, but less precise), Grants (OAuth), Privileges/Rights (stale registers). **"Pass the chalk" parked** as the future floor-control feature name (product layer only — the word is taken by `<Chalk />`). |

Trunk sentence: **a Space where Users and Agents participate; each bounded run
of activity is an Episode, and Episodes leave artifacts.**

## Rulings continued — 2026-08-03 (morning session)

- **§8 Depth of rename: LOCKED — all the way down, no mercy.** Same canonical
  roots to wire frames, DB tables/columns, env vars, span names, infra stack
  names. Nothing survives. Only the previously ruled vendored-term exception
  (WebRTC/CallKit/Cloudflare vocabulary at adapter seams) stands.
- **Legacy protocol versions: LOCKED — delete entirely.** The Elixir sync
  service still ships the whole legacy V1 architecture (`rooms/room.ex`,
  `rooms/room_server.ex`, `transport/socket.ex`) alongside V3; disabled in
  production, pure clutter. Remove it and any client remnants outright.
  **Renumbering LOCKED: current v3 becomes v1** ("we will go from V1 to V3,
  but it doesn't make sense to keep calling it V3"). The version-archaeology
  report is execution inventory only, not a pending decision.
- **§9 `Chalk` prefix in symbols: LOCKED — nowhere.** The package provides
  the namespace; pragmatic case-by-case exception for Go/Elixir internals
  with real collisions. `<Chalk />` is a full name, not a prefix.

### Boundary findings (Hasan agreed the diagnoses are valid)

CORRECTION 2026-08-03: an earlier revision of this section over-recorded the
ChalkSession split as ratified. Hasan agreed the survey's _findings_ are
valid problems; the _fixes_ below are locked only where he explicitly
endorsed one. The ChalkSession split is Claude's recommended fix and is
**NOT yet ruled**.

- **ChalkSession split: LOCKED (Hasan: "Without a question, option A")** —
  the god object (~6 fused concerns: connection/access lifecycle, media
  session, sync replica, room-control facade, chat/reaction state machine,
  snapshot store + diagnostics) is split into a narrow connection coordinator
  plus feature controllers (chat, room actions, whiteboard) composed into one
  UI-facing store. Name the pieces, not the fusion. Part of the SDK wave.
- **The five "session" concepts get true names**: Go `sessionlifecycle`
  (→ Episode), broker `MeetingSession` (edge lease), RN `ClientSession`
  (pre-join credential client), Elixir `Live.Session` (media/presence
  process), Elixir `Sessions.Coordinator` (socket delivery). One word was
  carrying five abstractions; this coupling is the core disease.
- **Media-plane contract ownership**: wrong today — media's own interface
  lives in `sync/v3-types.ts`. Media gets a neutral contract of its own.
- **UI primitive double-ownership**: React SDK must import from
  `packages/ui`; its local duplicate primitives (`react/src/components/ui`)
  are wrong and go away. Hasan: "super sad… not good."
- **Forwarding disease is layered and must be cured**: sync client (~22-method
  flat mirror) → ChalkSession one-line forwards → React hooks and RN hooks
  each hand-mirroring the entire action surface. One command currently means
  four synchronized edits. Hasan is "especially not happy" with this.
- **`tools/contract-codegen` renamed to its real role** (it validates a proof
  fixture; HTTP contracts come from Go OpenAPI, sync/whiteboard from
  checked-in JSON schemas). Folded into the SDK rename wave.
- Remaining survey suspects (httpapi composition god package,
  ParticipantAccess envelope fusion, room-actions four-owner split, whiteboard
  vocabulary overlap) agreed valid as diagnoses; fixes and their order decided
  during execution planning.
- **Method consequence**: rename waves and boundary redraws are the same
  waves — never touch the system twice.

## Space durability decision sheet

Context: schema audit shows the durable shell exists but is empty. `rooms` has
id/slug/status/metadata/recurring_policy; ALL policy (role capability grids,
host-exit, durations) lives per-`room_sessions` (immutable via trigger); chat
streams and whiteboard scenes are keyed per session and die with it;
`memberships` are tenant-level only; participants are per-session seats.

- **D1 Config home: LOCKED** — Roles/Capabilities/admission defined on the
  Space; each Episode snapshots them immutably at start; edits take effect
  next Episode.
- **D2 Membership: LOCKED — Member un-parked.** Durable User/Agent assignment
  to a Space with a Role; guests stay Episode-scoped.
- **D3 Content: LOCKED — whiteboard AND chat are Space-scoped** and survive
  between Episodes (Hasan went further than the rec). Optional explicit
  "clear Space state" action for resetting content; clearing is a choice,
  never automatic. Open corollary (minor, decide during design): whether
  _posting_ chat requires a live Episode (rec: initially yes — read anytime,
  write while joined — to stay out of async-messaging scope for now).
- **D4 Episode start model: LOCKED (Hasan: "pretty sound")** — emergent
  semantics with explicit start as an option. Join always works: if no
  Episode is live and the joiner holds the start capability, joining starts
  one. An explicit `start episode` API remains as a ceremony/warm-up hook,
  never a prerequisite. Scheduled/warmed starts ride the Space
  `recurring_policy` rrule. Invite links target the durable Space slug, so
  distribution never needs pre-provisioning. Invariant: no one who is allowed
  in is ever turned away because nobody ran a create call. Derived law
  (entailed by "join targets the Space"): **at most one live Episode per
  Space** — otherwise "join the Space" is ambiguous.
- **D5 Presence without Episode: LOCKED — no.** See "Later rulings" below;
  Pulse demoted to consideration-only.

Trunk sentence v2: **Space = identity + config + members + persistent
content; Episode = an immutable-policy run that emerges on join and leaves
artifacts.**

**§10 Grammar: LOCKED with one amendment** — closed command-verb set,
past-tense `<Subject><Verb>Event`, `<Noun>Snapshot`, UI shape suffixes all
ratified. Error codes are `noun.condition` with **underscores in the
condition**: `episode.not_found`, `space.access_denied` (Hasan: no dashes).

## Later rulings — 2026-08-03 (continued)

- **D5: LOCKED — no ambient presence.** A dormant Space is readable data;
  you become visible only by joining (which starts/enters an Episode).
  Important amendment: Pulse is demoted from "build later" to a mere
  consideration — Hasan is not sure he wants that direction at all.
- **End policy: LOCKED — mechanism from platform, strictness from customer.**
  Three ends: explicit `end_episode` (capability-gated); natural (last leave +
  configurable linger window so blips/rejoins continue the same Episode);
  deadline (Space-config default duration, capability-gated live extensions,
  hard tenant ceiling). Keep the existing deadline-generation machinery.
- **Link policy (clarification, entailed by §2)**: join links target the
  Space slug only; Episodes are addressable read-only for history/artifacts
  ("Tuesday's recording"), never joinable.
- **Content canonicality (clarification of D3, Hasan confirmed)**: Space
  chat stream and whiteboard scene are the canonical single copies; Episodes
  write INTO them while live and reference ranges/captures afterward. Space
  content is never derived by merging per-episode copies.
- **Metrics**: Episode records are per-participant (join/leave, role,
  published media), not just aggregates; observability carries both episode
  and participant dimensions. Hasan agreed.
- **One live Episode per Space confirmed by Hasan** ("just creating new
  space"); parallel tracks are separate Spaces.

## Open decisions

**2026-08-03, post-compaction: Hasan locked the last open ruling ("agree with
that open ruling") — the decision phase is CLOSED.** Both Member/guest bullets
below are now LOCKED as written; the promotion-path set is accepted as
proposed (all three paths, auto-enroll still excluded). Only in-wave design
details remain (SDK piece names under §9, turnkey copy, D3 posting corollary).

- **Member/guest identity direction — LOCKED**: Chalk never owns end-user
  identity; embedding app
  is the identity authority. What a Member gets over a guest (enumerated for
  the glossary): standing access (link just works), durable Role across
  Episodes, roster presence while dormant, continuous identity in history
  ("attended all 12 classes"), addressability (assign/pre-authorize/mention).
  A guest gets exactly one thing: admittance to the current Episode with a
  role that expires with it. Two integration depths: ephemeral guest grant
  (drop-in path) vs registered identity keyed by the customer's external id
  (Stripe-customer pattern; external_id is a unique reference per tenant,
  NEVER the primary key — Chalk mints its own ids). Members then attach
  Space+Role to registered identities.
- **Guest→Member promotion paths — LOCKED as the proposed set**:
  (a) backend API call (register identity + add membership); (b) in-UI
  promotion by a holder of `manage_members` — requires resolving the guest to
  a registered identity via a handshake with the customer's identity system
  (callback/webhook), since anonymous guests have nothing durable to attach
  membership to; (c) self-serve request + owner approval (admission-like
  flow). Auto-enroll policies deliberately not proposed for now.
- **SDK piece names** from the ChalkSession split: coordinator candidates
  `SpaceConnection` / `SpaceClient` + controller names — decided during SDK
  wave design under §9 (no Chalk prefix).
- Host/guest words in UI copy of the `<Chalk />` turnkey: turnkey defines its
  own product copy; specifics undecided.
- **`state_schema_version: 3` / `chalk-sync-state-v3`** — **LOCKED (Hasan,
  2026-08-03): reset to 1** with the protocol renumber. No exemption; §8 goes
  all the way down.

## Parked concepts and considerations (revisit only deliberately)

- **Pulse** — Space-level ambient-activity aggregate. A consideration only;
  Hasan explicitly unsure he wants this direction at all (2026-08-03).
- **"Pass the chalk"** — floor-control product feature name.
- **Breakout/station concept** — if it ever exists it is a product-layer
  arrangement of multiple Spaces (never multiple Episodes in one Space) and
  gets a fresh name. Whether to build it at all is undecided.
- **Agent integration standards** (Hasan, 2026-08-03, "write it down"):
  beyond the native path (Agents join as first-class participants through the
  same SDK), consider supporting external agent standards so customers can
  bring their own agents — candidates: MCP (tools layer), A2A, ACP. Landscape
  still churning in 2026; native-first, adapters later, proper research pass
  before any commitment.
  - **Expanded (Hasan dictation, post-compaction 2026-08-03):** realization
    that none of the candidate standards may support **video and audio** —
    they are text/JSON-RPC-shaped. Question raised: would Chalk have to
    engineer its own custom standard? The agent requirement, wherever the
    agent lives ("we want the agent, and we don't care where it lives"; it
    brings its own tools and does its own stuff): (1) communicate through
    video and audio; (2) share results in an integrated way so outputs appear
    in the Space/Episode; (3) send chat messages in the Space/Episode;
    (4) write on the whiteboard. Second agent kind also floated: an agent
    that lives entirely **on Chalk** (e.g. a virtual box Chalk hosts) rather
    than elsewhere. Claude's read, recorded for later evaluation: the AV gap
    is real but doesn't demand a new cross-vendor standard — the native
    server-side SDK **is** the standard for capabilities 1–4 (the agent is
    just a Participant with credentials publishing WebRTC tracks and holding
    the same chat/whiteboard/artifact contract as any client); MCP remains a
    complementary text-layer bridge (expose chat/whiteboard/artifact writes
    as tools) for agents that can't hold a media connection. Chalk-hosted vs
    externally-hosted is a deployment option, not a protocol difference.
    Still consideration-only; no commitment.
- (Member left the parked list — un-parked and LOCKED as D2.)

## After the rulings close: execution plan

1. Draft repo-root glossary from rulings — structured entries: definition,
   identity rule, lifecycle, owning surface, relations, non-examples. Supersede
   `sdks/ubiquitous-language.md`.
2. CI ratchet: per-surface banned-term counts (meeting, conference, room,
   session, call, host as domain nouns…) that may only decrease; exclude
   CHANGELOG/scratchpad; wire into the existing smart gate.
3. Rename waves, each independently green: contract/schema first (codegen
   propagates), then client SDK, React/RN UI (`<Chalk />`), web+mobile apps,
   infra (`managed-meeting`→, `meeting-broker`→, `bootstrap-meeting`→),
   observability names, marketing/store listing, DB last. Grunt work via Codex
   GPT-5.6-Luna relays. Standing rule (Hasan, 2026-08-03): implementation
   workers always run at **max** reasoning effort (a real Codex level above
   xhigh), with codex stdout redirected to a file so the harness output cap
   can't kill long runs.
4. Point AGENTS.md files at the glossary; one-line scratchpad convention note.

## Execution state — 2026-08-03 afternoon (for post-compaction pickup)

Decision phase fully closed, including all five schema DECIDE items in
`scratchpad/space-episode-schema-design-2026-08-03.md` (ratified design for
the contract wave). Landed on master: `GLOSSARY.md` (canonical), AGENTS.md
pointers, superseded banner on `sdks/ubiquitous-language.md`.

Three Luna workers in flight, each in its own worktree/branch:

- `.worktrees/ui-primitives` / `refactor/ui-primitives-consolidation` —
  React SDK primitives into packages/ui, restyled to the mockup design
  system (xhigh; predates the max rule).
- `.worktrees/sync-renumber` / `refactor/sync-v1-renumber` — wave zero:
  legacy sync deletion + v3→v1 renumber. Killed twice by the harness output
  cap (~242-file uncommitted diff preserved); third run resumes at **max**
  reasoning with stdout redirected to disk.
- `.worktrees/language-ratchet` / `tooling/language-ratchet` — banned-term
  ratchet wired into the root gate (xhigh).

Merge order when reports land: ratchet → wave zero (tighten baseline at
merge) → UI primitives. Then launch the contract/schema wave from the
ratified design doc (Luna at max), then client SDK wave (ChalkSession
split), React/RN `<Chalk />`, apps, infra, observability, marketing, DB
last. Reports land at /tmp/codex-\*.md. Nothing awaits a Hasan decision.

**Update (post-compaction pickup, same day):** ratchet and UI-primitives
workers finished with green gates but could NOT commit — the codex sandbox
cannot write linked-worktree git metadata (`.git/worktrees/<name>` lives in
the main repo; complaint #3347). Claude reviewed and committed both:
`62b2a40d` on `tooling/language-ratchet` (merged to master as `46484b09`;
`pnpm run language:ratchet` green on master after merge) and `f60a4b8f` on
`refactor/ui-primitives-consolidation` (awaits merge until after wave zero).
Ratchet realities: baseline counts are large (session ~5.5k in api alone);
noisy terms call/host/peer/bot/ai deliberately excluded from v1. The
sync-renumber worker (max) is still running; expect to commit for it too
when its report lands at /tmp/codex-sync-renumber.md.

**Worker-survival lesson (2026-08-03 night):** the third sync-renumber run
died silently ~13:15 — background tasks launched via relay-agent
run_in_background die when the launching session compacts. Fourth run
launched DETACHED from the main agent: `nohup codex exec … > stream.log
2>&1 < /dev/null & disown` — survives compaction, zero context bloat since
all output goes to disk. This is now the launch pattern for long workers;
relays (Haiku) remain for short-lived delegation. Worker prompts now also
say DO NOT git commit (sandbox can't write worktree git metadata; the
orchestrator reviews and commits). Report → /tmp/codex-sync-renumber.md,
stream → /tmp/codex-sync-renumber-stream.log; on pickup, check pgrep
'gpt-5.6-luna' — a missing process with no report means it died again.

**Corrections + rulings (Hasan, 2026-08-03 late evening):**

- Model roles corrected: **Sol high is the MOST capable Codex model; Luna
  max is the mechanical workhorse** (Claude had it backwards). ALL
  mechanical execution → Luna max, with Codex's own auto-review pass (by
  Luna) as the quality gate; a few Sol-high workers only where capability
  is genuinely needed. **Relay agents are Haiku** now, not Sonnet. Every
  worker prompt carries a STRICT SCOPE clause — no changing DB fields or
  anything outside the stated scope.
- **Schema walkthrough held and closed**: all five scrutiny points
  confirmed (single `config_snapshot` jsonb; guests rowless; live-Episode-
  only content writes — emphatic, there is no Space-direct media/sync
  connection path at all; console as separate context + Chalk-as-tenant;
  the 23-capability set). Recorded in the design doc. The contract wave is
  now gated only on wave zero merging.
- Endgame division of labor: Claude finishes execution orchestration;
  Hasan takes UI, product QA, reliability, bug fixing. Hasan asked to be
  kept accountable; his UI work is sequenced after the React/RN wave.
- Client SDK split co-design started live:
  `scratchpad/client-sdk-split-design-2026-08-03.md` (six DECIDE items).
- **Client SDK split design FULLY RATIFIED in the live session** (all
  seven DECIDE items + R1 access-refresh requirement + controller
  communication law; Effect core with Promise facade confirmed). The
  design sheet is the implementation brief. Both co-design gates are now
  closed — schema walkthrough AND client SDK split. Remaining pipeline is
  pure execution: wave zero merges → tighten ratchet → merge UI
  primitives → contract wave (Sol high candidate, Hasan approves
  assignment) → client SDK wave → React/RN → apps → infra →
  observability → marketing. Hasan's UI work starts after React/RN.

**Design-sheet rule (Hasan raised, 2026-08-03, pre-compaction): abstractions
are designed, never just renamed — and designed WITH Hasan.** Every wave
carrying a boundary redraw gets a code-grounded design worked through in a
live session (pen-and-paper style, like this session's decision sheets):
Claude brings code reality and candidate shapes, Hasan co-designs and holds
final decision on every piece; the DECIDE format is the record of what was
settled, not the process. Only then does a worker launch; Luna implements
ratified designs, it never designs. Amendment: the schema design was ratified
checkbox-style, so before the contract wave launches, walk that design
through with Hasan and revise freely — the wave does NOT launch without that.
Note: no vocabulary renaming has started; wave zero is version plumbing only.
`space-episode-schema-design-2026-08-03.md` is the template. Design status:
contract wave designed+ratified; **client SDK split is the next sheet to
draft** (coordinator responsibility line, controller set + boundaries, single
UI-facing store shape, snapshot/subscription contract, the forwarding cure so
one command ≠ four edits, §9 piece names, media contract extraction) — draft
it while the contract-wave worker runs. React/RN wave is half-designed (the
ratified UI-shape grammar of the superseded SDK doc is component canon; delta
= Space/Episode mapping + hooks-derive-from-store strategy). Go API redraws
(httpapi god package, ParticipantAccess fusion, room-actions four-owner
split) get short sheets folded into their waves. The five "sessions" get
their true names inside their waves' sheets.

## Work landed this session (already on master)

- `35427f71` — API scratchpad consolidated into root scratchpad; empty `hey.md`
  and stale `todo.md` deleted. (Root-only scratchpad is the convention.)
- `99715502` — doc-rot audit (Codex GPT-5.6-Luna, xhigh): sync docs verified
  accurate; api workflow docs + design/sound/CI-errors/quickstart demoted to
  dated snapshots with surgical fixes (PlanetScale→managed Postgres,
  `ProviderName`, `chalkmeet.com` URLs, 2026-08-01 board = visual canon);
  `composio-integrations-spec.md` deleted (fully implemented).
- `c21e8f54` — `sdk-generator-proof` experiment deleted (Hasan: concluded
  experiment) + `route-workflow.md` reference removed;
  `docs/chalk-mobile-whiteboard/` deleted (stale placeholder doc).
- `43a86326` — Effect `4.0.0-beta.94 → beta.102` upgrade landed on master
  (v4 is NOT GA — npm latest 3.22.1). One real migration: removed
  `Schedule.take(1)` → `Schedule.upTo({ times: 1 })` in telemetry retry.
  Verified independently (client 325 tests + tsc, codegen 33 tests, full
  gate). Worktree and branch removed. Incident during landing: failed hook
  runs in the linked worktree set `core.bare=true` on the MAIN repo config
  (Mix `git init` under hook `GIT_DIR` suspected); fixed with
  `git config core.bare false`; complaints #3305/#3306 filed.

## Model-assignment amendment (Hasan, 2026-08-03 evening)

Hasan amended the wave assignments during the contract-wave approval:

- **Contract wave AND client-SDK wave both go to GPT-5.6 Sol high** (not
  just contract). Client SDK is a boundary redraw too, not pure mechanics.
- **One attempt per worker, not two**: no Codex auto-review second pass on
  these waves. The worker gets a single run; Claude's skeptical diff review
  against the report is the gate.
- Remaining waves (React/RN, apps, infra, observability) stay Luna max.
- Isolation confirmed: every worker runs in its own `.worktrees/<name>` on
  its own branch, launched detached (nohup pattern); waves run sequentially
  because client SDK depends on the contract wave's regenerated types.

## Public-surface co-design OPEN (Hasan, same message)

Hasan: "I still want to discuss the public API surface/shape — the single
component where the user is going to interact — we have to make sure it's
good and coherent." This is a live co-design gate covering the developer
ladder: `<Chalk />` turnkey component, provider+hooks, headless SpaceClient
construction. NOT yet ruled; the SpaceClient construction/auth seam must be
ruled BEFORE the client-SDK wave launches (the ratified split sheet covers
the split, not how a SpaceClient is created or how access is supplied).
Current reality being redesigned: `VideoConferenceProps` has ~45 props with
a `createSession` factory prop, hard-coded `role: "host" | "participant"`,
nine `*Enabled` toggles AND nine `can*` permission booleans (the `can*`
family contradicts capability-driven UI once roles are customer-defined).

## Public-surface gate CLOSED (Hasan, 2026-08-03 night, four rounds)

`scratchpad/public-surface-design-2026-08-03.md` is FULLY RATIFIED.
Headlines: three-rung ladder (`<Chalk />` sugar over `<ChalkProvider>`
sugar over framework-agnostic `SpaceClient`); `space` + `getAccess` →
opaque `AccessGrant` is the entire integration; **the pre-join screen
is the ENTRANCE** ("Entrance is PERFECT!" — green room and lobby
rejected; the entrance also hosts knock-waiting); `defaults` object;
no className ever, `theme` the only styling door (mechanism ruled,
token list awaits Hasan's UI pass); episode lifecycle flat;
`client.on` emitter in core; `features` object; role and all `can*`
props dead. All three co-design gates (schema, client SDK split,
public surface) are now closed. Wave zero sits committed on
`refactor/sync-v1-renumber` (e0931d7f deletion, a536ef51 renumber,
report docs); its master merge waits on Hasan's call about the other
agent's uncommitted README/checklist edits.

## Wave zero + UI primitives MERGED; execution re-scoped (Hasan, 2026-08-03)

Hasan ran the stash-park himself; the merge conflicted only in
`apps/web/src/lib/chalk-access.test.ts` (drifted commit added
`inviteToken` beside a `/v3/sync` URL — resolution keeps both, on
`/v1/sync`). Four `/v3/sync` stragglers from the drifted local-stack
commit (scripts/dev/chalk.mjs, README table) fixed inside the merge.
Gate rounds: ratchet fails closed on IMPROVEMENTS (baseline updated and
staged in-merge); stale `.worktrees/language-ratchet` copy broke the
architecture-worker vitest filter (worktree removed); `packages/ui`
typecheck needed the sequential library-chain build. Landed as 98968f04,
full commit gate green (285s). `refactor/ui-primitives-consolidation`
then auto-merged clean; ui+react build/typecheck/tests verified green.
Other agent's README/checklist edits restored untouched via stash pop.
All three merged worktrees removed (one stray session log preserved
into scratchpad first).

**Re-scope (Hasan)**: no subagent worker machinery at all — Hasan
executes waves 1–6 himself with another agent; Claude keeps merge
chores (done), the execution brief, and the marketing + docs passes
(docs written spec-first from the ratified sheets are acceptance canon).
C1: waves 5 ∥ 6 approved. C2: UI-pass scheduling dropped from the map.
The handoff artifact is `scratchpad/wave-execution-brief-2026-08-03.md`.

## 2026-08-11 addendum: Spinoff and Buzz

Hasan ratified two forward-looking platform nouns; both entries are now
in GLOSSARY.md and the ratchet bans their rivals.

**Spinoff** — a new Space derived from a live or ending Episode, seeded
with invited Participants. Extends the Episode register (broadcast
vocabulary: a spinoff is a new show carrying over part of the cast).
Rejected: breakout (Zoom's word), huddle (Slack's), branch (git owns it
and it is grep-poison in a repo full of git tooling). **Aside** is
deliberately reserved, unused, for a possible in-Episode private lane —
an Aside stays inside the Episode, a Spinoff leaves it.

**Buzz** — a real-time summons that rings a Member's devices and
deep-links them into a Space. Rejected: cue (Hasan vetoed; queue
homophone), ring/call (telephone vocabulary the platform does not
speak), tap (touchscreen-gesture collision), hail (register drift),
page, knock, chime, beckon. OS call chrome (CallKit, Telecom) still
says "call" in system UI; that is vendored vocabulary at an adapter
seam, not ours. Ratchet: breakout and huddle added to TERMS; "huddle"
baselines at 1 in docs (a deliberate store-listing ASO search keyword,
not domain prose) and the tools surface counts the term list itself.
