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

## Open decisions (sheet items not yet ruled)

- **§8 Depth of rename**: same canonical roots down to wire frames, DB
  tables/columns, env vars, span names (rec: yes — cheapest day ever) vs
  codegen seam tolerating legacy names underneath.
- **§9 `Chalk` prefix in symbols** (`ChalkSession`, `createChalkServerClient`):
  rec: nowhere (package provides namespace), pragmatic exception for Go/Elixir
  internals where collisions are real. Note `<Chalk />` is a full name, not a
  prefix — consistent with the ban.
- **§10 Grammar ratification**: closed command-verb set, past-tense
  `<Subject><Verb>Event`, `<Noun>Snapshot`, `noun.condition` error codes,
  UI shape suffixes — ratify the v4 doc's grammar half on its merits.
- **SDK runtime handle name**: `ChalkSession` must be renamed (word freed by
  Episode ruling; prefix question pending §9). Candidate direction:
  `SpaceClient` or similar — undecided.
- Host/guest words in UI copy of the `<Chalk />` turnkey: turnkey defines its
  own product copy; specifics undecided.

## Parked concepts (deliberate, revisit later)

- **Member** — durable belonging of a User/Agent to a Space (rosters, standing
  access, "assign an agent to your Space"). Shelved by Hasan for now.
- **Pulse** — Space-level ambient-activity aggregate, product name, built on
  Presence.
- **"Pass the chalk"** — floor-control product feature name.

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
   GPT-5.6-Luna relays (xhigh reasoning), pattern already proven this session.
4. Point AGENTS.md files at the glossary; one-line scratchpad convention note.

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
- **In flight**: Effect `4.0.0-beta.94 → beta.102` upgrade (v4 is NOT GA —
  npm latest is 3.22.1, beta tag is 4.0.0-beta.102) running via Codex in
  `.worktrees/effect-v4`, branch `effect-v4-beta102`: version bumps applied,
  `telemetry/delivery.ts` touched, uncommitted at time of writing.
