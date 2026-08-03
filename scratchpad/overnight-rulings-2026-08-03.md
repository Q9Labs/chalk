# Overnight rulings — 2026-08-03

Hasan runs waves 1–6 overnight with another agent. Every decision the wave
prompts defer to him is closed HERE, tonight. Each item: recommendation +
his ruling. When ruled, Claude writes the results into `GLOSSARY.md`,
strips the corresponding blockers from the wave prompts, and commits —
only then is the overnight run unblocked.

## D1 — Elixir "session" true names (blocks wave 1)

Ground truth: `Sessions.Reducer` state is participants/roles/admission
(all Episode-owned); `Sessions.Coordinator` is a disposable node-local
delivery coordinator; `Sessions.CommandAdmission` is command
backpressure (name collides with participant admission);
`Live.Session` is per-run media/presence/directed-requests (all
"exists only inside a live Episode" state).

RECOMMENDED (Scheme A, Episode-rooted):

- `Live.Session` → `Live.Episode`
- `Sessions.Coordinator` → `Episodes.Coordinator`
- `Sessions.Reducer` → `Episodes.Reducer`
- `Sessions.CommandAdmission` → `Episodes.CommandIntake`
- `Stateholder.SessionKey` → `Stateholder.EpisodeKey`
  Commits wave 1 to a per-Episode control stream (fresh each run,
  continued across blip-rejoin within linger). Alternative (Scheme B,
  function-rooted): `Delivery.Coordinator`, `Delivery.CommandIntake`,
  `Control.Reducer`, `Live.Presence`.

RULING: **\_\_**

## D2 — React / React Native platform parity (waves 3–4)

RECOMMENDED: identical public surface — same component names, props,
hooks, events, vocabulary in both packages; both bind to the one
SpaceClient/SpaceSnapshot store so parity is structural. Divergence in
exactly two documented places: implementation seams (CallKit/OS
permissions; CSS custom properties on web vs mapped style values on RN
— same token names) and a small platform delta in `features` where a
capability genuinely doesn't exist. Never a shape difference.

RULING: **\_\_**

## D3 — React hook names (blocks wave 3)

RECOMMENDED (hooks mirror the snapshot slices; no Chalk prefix — the
package is the namespace):

- `useSpaceClient()` — the client, for commands
- `useConnection()`, `useSelf()`, `useParticipants()`, `useMedia()`,
  `useChat()`, `useReactions()`, `useWhiteboard()` — one per slice
- `useCan(capability)` — sugar over the self slice's `can()`
  No other public hooks; anything else a component needs comes from these.

RULING: **\_\_**

## D4 — RN ClientSession true name (blocks wave 3)

RECOMMENDED: it dies with no successor. Its duties (pre-join
credentials) are exactly Connection's access loop + AccessGrant in the
shared core; RN keeps no platform-specific credential holder.

RULING: **\_\_**

## D5 — Broker "MeetingSession" true name (blocks wave 5)

Ground truth: a Cloudflare Durable Object, one per live run — mints
access via the server SDK, creates client sessions, and expires the run
by alarm (`meetingLifetimeSeconds` is the Episode deadline policy at
the edge). The audit called it an edge lease, and that is what it is: a
bounded, expiring edge claim embodying one live Episode.

RECOMMENDED:

- DO `MeetingSession` → `EpisodeLease`
- `MeetingStore` → `LeaseStore`; `meetingLifetimeSeconds` →
  `episodeDeadlineSeconds`
- package `infrastructure/meeting-broker` → `infrastructure/episode-broker`
  (worker/stack/env names follow)
  Alternative flavors if Lease reads wrong: `SpaceGate` (admission-flavored)
  or `access-broker` (function-flavored package name).

RULING: **\_\_**

## D6 — Version and publish (blocks wave 2 merge)

RECOMMENDED: all `@q9labsai/*` packages jump to `4.0.0` in wave 2 (one
version, one breaking change, matches the V4 restructure); npm publish
is a separate manual step after wave 4 lands and Hasan's verification
pass — nothing publishes overnight.

RULING: **\_\_**

## D7 — Turnkey copy overnight rule (wave 4)

RECOMMENDED: the wave-4 agent drafts copy in glossary vocabulary,
neutral in tone, and lists every string it wrote in its report for
Hasan's morning review — no invented product voice ships unreviewed.

RULING: **\_\_**

## Confirmed defaults (already described, restated for the record)

- Wave 1 owns ALL server-side work in one pass (DB, Go API, contracts,
  Elixir adoption) + mechanical downstream compatibility only.
- Waves 5 ∥ 6; both after their stated prerequisites.
- Claude's marketing/docs pass runs AFTER the overnight waves land, not
  concurrently — no file collisions with the running agent.
