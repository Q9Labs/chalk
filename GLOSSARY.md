# Chalk Glossary

The canonical vocabulary for every Chalk surface: database, API, sync wire,
SDKs, UI, infrastructure, observability, docs, and marketing copy. One concept
has one name, and the name goes all the way down: wire frames, table names,
env vars, span names, stack names. Vendored standard terms (WebRTC "track",
CallKit, Cloudflare SFU vocabulary) stay foreign and are translated at adapter
seams.

Provenance: the rulings behind every entry, with reasoning and rejected
candidates, live in
`scratchpad/ubiquitous-language-decision-session-log-2026-08-03.md`. The
superseded `sdks/ubiquitous-language.md` is deleted; its UI shape catalog
remains in git history as input for the React-wave design sheet. A CI
ratchet (per-surface banned-term counts that may only decrease) enforces this
glossary. Until a count reaches zero the glossary states the target, not the
present.

## The model

Chalk is a real-time collaboration and communication layer, not a meetings
product. The trunk sentence: **a Space where Users and Agents participate;
each bounded run of activity is an Episode, and Episodes leave artifacts.**
With durability: **a Space is identity + config + members + persistent
content; an Episode is an immutable-policy run that emerges on join and
leaves artifacts.**

The ownership law: the Space owns what IS (identity, configuration, members,
living content); the Episode owns what HAPPENED (attendance, config snapshot,
artifacts, frozen forever). Test for any new field: can it change after the
Episode ends? Yes means it belongs to the Space, no means the Episode.

## Core nouns

### Space

The durable place where collaboration happens. Replaces Room.

- Identity: Chalk-minted id plus a slug unique per tenant. Join links target
  the slug and nothing else.
- Owns: Roles, Capabilities, admission policy, membership, the canonical chat
  stream and whiteboard scene, the recurring schedule (rrule).
- Lifecycle: created once, lives indefinitely, dormant between Episodes. A
  dormant Space is readable data; nobody is "in" it.
- Relations: has at most one live Episode at any time. Parallel tracks are
  separate Spaces, never parallel Episodes.
- Not: a Room, a meeting, a call, a channel.

### Episode

One bounded run of live activity inside a Space. Replaces Session.

- Identity: Chalk-minted id, belongs to exactly one Space. Never a join
  target: joining targets the Space, and "join an episode" is never uttered.
  Episode links are read-only history ("Tuesday's recording").
- Owns: per-participant attendance records (join/leave, role, published
  media), an immutable snapshot of Space config taken at start, and its
  artifacts.
- Lifecycle: emerges when someone holding the start capability joins a Space
  with no live Episode; an explicit `start_episode` call exists for ceremony
  and warm-up but is never a prerequisite. Ends explicitly
  (capability-gated `end_episode`), naturally (last leave plus a configurable
  linger window, so a blip rejoin continues the same Episode), or by deadline
  (Space-configured default duration, capability-gated live extensions, hard
  tenant ceiling). Strictness is Space configuration, not platform dogma.
- After end: frozen forever. Nothing on an ended Episode changes.
- Not: a snapshot of the Space, a session, a call, a meeting.

### Participant

The sole roster noun: anyone or anything present in a live Episode,
kind-neutral over User, Agent, and guest.

- Identity: a per-Episode seat with its own id, stable across reconnects, new
  on rejoin. The same User on two devices is two Participants.
- Relations: local and remote projections share the Participant base;
  attendance history belongs to the Episode.
- Not: Peer, Actor, Attendee, Member (that is durable belonging, below), or
  User/Agent used as a roster word.

### User and Agent

The two durable identity kinds. An Agent is a full peer of a User: same
lifecycle, same capabilities, same media rights. Proactive assistants are
products built on Agent. Bot, Assistant, and AI are banned as domain nouns.

- Identity: Chalk mints its own ids. Chalk never owns end-user identity: the
  embedding application is the identity authority, and a registered identity
  is keyed by the customer's `external_id`, a unique-per-tenant reference
  that is never the primary key.

### Guest

An unregistered visitor admitted to the current Episode with a role that
expires with it. That is everything a guest gets. Promotion to Member happens
by backend API call, by in-UI promotion (requires resolving the guest to a
registered identity through the customer's identity system), or by self-serve
request plus approval. There is no auto-enroll.

### Member

A durable assignment of a User or Agent to a Space, carrying a Role. Members
get standing access (the link just works), a durable Role across Episodes,
roster visibility while the Space is dormant, continuous identity in history,
and addressability (assign, pre-authorize, mention). Guests get none of that.

### Presence

Live availability of a Participant: online, speaking, last activity. Presence
exists only inside a live Episode; there is no ambient presence in a dormant
Space. You become visible by joining.

### Capability and Role

A Capability is what the system checks: the mechanical answer to "may this
identity do this action now". A Role is a customer-definable named bundle of
capabilities. Chalk ships three use-case-neutral defaults: **owner**,
**collaborator**, **observer**. There is no built-in host, admin, or member
role; customers may name their own roles anything, including "host". UI
renders from capabilities and never infers authority from role names.
Permission is reserved for OS and browser device grants.

### Artifact

What an Episode leaves behind: a **Recording** (captured media) and a
**Transcript** (ordered attributed text; Transcription names the process).
Artifacts attach to the Episode and are frozen with it. Space chat and
whiteboard are not artifacts: they are the Space's living content, which
Episodes write into while live and reference by range or capture afterward.
Space content is never derived by merging per-episode copies.

### `<Chalk />`

The turnkey UI component: the complete embedded experience dropped into a
customer's app. Replaces VideoConference. It is a full name, not a prefix;
its interior tree is platform-named (SpaceView, Stage, Entrance, panels)
with no `Chalk*` symbols.

### Entrance

Where a visitor prepares before joining a Space: name, devices,
self-preview — and where knock-admission waiting happens. One place for
both pre-live states, so the lobby/pre-join split other products have
does not exist. Replaces PreJoinScreen; a place-noun like Stage, no shape
suffix. `entrance: false` on `<Chalk />` means walk straight in.

### SpaceClient

The public client SDK entry: flat lifecycle (`join`/`leave`/`subscribe`/
`getSnapshot`, `endEpisode`/`extendEpisode`) plus namespaced controllers
`media`, `chat`, `participants`, `reactions`, `whiteboard` (chat files
under `chat.files`). Replaces ChalkSession. Internally a `Connection`
coordinator owns the state machine, recovery, and access refresh; one
`SpaceSnapshot` store feeds every UI layer. Framework-agnostic; React and
React Native bind to the store, never to Effect internals.

### AccessGrant

The opaque signed envelope the customer's backend receives from the
server SDK and forwards to the client verbatim: sync token, media token,
participant identity, expirations. Replaces ParticipantAccess. Customers
never construct or inspect it; the client's `getAccess` callback returns
it and Connection manages its refresh.

### EpisodeLease

The broker's Durable Object: a bounded, expiring edge claim embodying
one live Episode — it mints AccessGrants, creates client sessions with
the media plane, and expires the run by alarm. Replaces the broker's
MeetingSession. A lease is not an Episode; it is the edge's claim on
media infrastructure for one. `MeetingStore` → `LeaseStore`,
`meetingLifetimeSeconds` → `episodeDeadlineSeconds`, and the package is
`infrastructure/episode-broker` (worker/stack/env names follow).

### React bindings

`@q9labsai/chalk-react` and `@q9labsai/chalk-react-native` expose an
**identical public surface**: same component names, props, hooks,
events, vocabulary. Both bind to the one SpaceSnapshot store, so parity
is structural. Divergence is allowed in exactly two documented places —
implementation seams (CallKit/OS permissions; CSS custom properties on
web vs mapped style values on RN, same token names) and a small platform
delta inside `features` where a capability genuinely doesn't exist —
and is never a shape difference.

The public hooks are a closed set: `useSpaceClient()` (the client, for
commands); one hook per snapshot slice — `useConnection()`, `useSelf()`,
`useParticipants()`, `useMedia()`, `useChat()`, `useReactions()`,
`useWhiteboard()`; and `useCan(capability)` as sugar over the self
slice's `can()`. No `Chalk` prefix (the package is the namespace), and
no other public hooks: anything a component needs comes from these.

## The five "sessions", resolved

The five internal abstractions that shared the banned word each have a
ruled true name:

| Old name                      | True name                                                                  |
| ----------------------------- | -------------------------------------------------------------------------- |
| Go `sessionlifecycle`         | Episode-named lifecycle package                                            |
| Broker `MeetingSession` (DO)  | `EpisodeLease` (see entry)                                                 |
| RN `ClientSession`            | Dies, no successor — its duties are Connection's access loop + AccessGrant |
| Elixir `Live.Session`         | `Live.Episode`                                                             |
| Elixir `Sessions.Coordinator` | `Episodes.Coordinator`                                                     |

The Elixir rename is Episode-rooted throughout: `Sessions.Reducer` →
`Episodes.Reducer`, `Sessions.CommandAdmission` → `Episodes.CommandIntake`
(ending the collision with participant admission), `Stateholder.SessionKey`
→ `Stateholder.EpisodeKey`. The control stream is per-Episode: fresh each
run, continued across a blip-rejoin within the linger window.

## Laws

1. **Join targets the Space.** Always, everywhere: links, APIs, SDK calls,
   copy. Therefore at most one live Episode per Space, or the join would be
   ambiguous.
2. **Episode config is a snapshot.** Space config edits take effect next
   Episode; a running Episode's policy is immutable.
3. **No one allowed in is ever turned away because nobody ran a create
   call.** Episodes emerge on join; explicit start is an option, never a
   prerequisite.
4. **Chalk mirrors identity, never owns it.** Registered identities reference
   the customer's `external_id`; Chalk mints its own primary keys.
5. **Names go all the way down.** No legacy vocabulary survives at any layer.
   The only exception is vendored standards at adapter seams.

## Naming grammar

Every name is a domain root crossed with a layer shape:

| Layer        | Shape                                          | Example                       |
| ------------ | ---------------------------------------------- | ----------------------------- |
| Event        | `<Subject><PastTenseVerb>Event`, past tense    | `EpisodeEndedEvent`           |
| Snapshot     | `<Noun>Snapshot`, immutable consistent view    | `EpisodeSnapshot`             |
| Error code   | `noun.condition`, underscores in the condition | `episode.not_found`           |
| HTTP route   | plural resource path                           | `/spaces/{id}`                |
| DB table     | plural snake_case                              | `episodes`, `space_members`   |
| UI component | shape suffix states the form                   | `ChatPanel`, `SettingsDialog` |

- Command verbs are a closed set: `join`/`leave`, `set`, `enable`/`disable`,
  `select`, `start`/`stop`, `send`, `admit`/`deny`, `remove`, `end`. No
  `toggle`, `handle`, `process`, or `do` in public commands.
- UI shape suffixes: Screen, View, Panel, Dialog, Sheet, Popover, Menu,
  Overlay, Banner, Toast, Picker, Selector, Indicator, Preview. The suffix
  states the shape; the prefix states the subject.
- No `Chalk` prefix on symbols anywhere: the package is the namespace.
  Case-by-case exception only for Go/Elixir internals with real collisions.
- Protocol versioning restarts honestly: the sync protocol is v1 (the former
  v3 renumbered; legacy v1 and the never-shipped "v2" are deleted), and
  `state_schema_version` is 1.

## Banned terms

| Term                        | Status                                                                           |
| --------------------------- | -------------------------------------------------------------------------------- |
| meeting                     | Dead everywhere: code, infra, docs, and marketing copy                           |
| room                        | Replaced by Space                                                                |
| session                     | Replaced by Episode; the five internal "session" abstractions are resolved above |
| call, conference            | Banned as domain nouns; the platform speaks Space/Episode                        |
| host, admin                 | Banned as built-in roles; fine as customer-defined role names                    |
| bot, assistant, AI          | Banned as domain nouns; the identity kind is Agent                               |
| attendee, peer, actor       | Banned roster nouns; the word is Participant                                     |
| signal (for availability)   | Banned; the word is Presence                                                     |
| VideoConference             | Replaced by `<Chalk />`                                                          |
| pre-join, lobby, green room | Banned; the place is the Entrance                                                |
| ParticipantAccess           | Replaced by AccessGrant                                                          |
| ChalkSession                | Replaced by SpaceClient                                                          |

Product-layer names built on top of the platform (a future floor-control
feature, a future activity aggregate) may carry their own names, but the
platform vocabulary itself has zero exceptions.
