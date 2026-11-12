# Chalk Glossary

The canonical vocabulary for Chalk's domain and contracts: database, API,
sync wire, SDKs, infrastructure, and observability. Keep those names consistent
in code. Vendored standard terms (WebRTC "track", CallKit, Cloudflare SFU
vocabulary) stay foreign and are translated at adapter seams.

Space and Episode are the names used in the model and API contracts. In the
dashboard, a **call** is presented as a reusable link backed by a Space;
**Past sessions** lists that Space's ended Episodes. A call can also mean the
live activity in ordinary conversation, so use the context. These are
user-facing words for the same concepts, not additional domain resources.

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

### Tenant, Dashboard Account, and Tenant access

A **Tenant** is Chalk's customer, deployment, isolation, authorization, and
billing boundary. One Dashboard Account may access several Tenants. A Tenant is
not a Space, Team, Workspace, or customer application's end-user directory.

A **Dashboard Account** is a person who signs in to Chalk's first-party control
plane. It is distinct from a customer application's User, Agent, Guest,
Participant, or Space Member. Product copy may shorten it to Account when the
dashboard context is unambiguous.

**Tenant access** is a Dashboard Account's assignment to a Tenant, including its
control-plane Role. It is not Space membership and never makes the Account a
Space Member or Episode Participant. The `memberships` persistence and route names are
implementation vocabulary; customer-facing contracts use Tenant access.

### Space

The durable place where collaboration happens. The dashboard presents it as a call.

- Identity: Chalk-minted id plus a slug unique per tenant. Join links target
  the Space and never an Episode: member links use the slug, and public invite
  links use the Space's invite code.
- Owns: Roles, Capabilities, admission policy, membership, the canonical chat
  stream and whiteboard scene, the recurring schedule (rrule).
- Lifecycle: created once, lives indefinitely, dormant between Episodes. A
  dormant Space is readable data; nobody is "in" it.
- Relations: has at most one live Episode at any time. Parallel tracks are
  separate Spaces, never parallel Episodes.
- Space is the durable resource; its call link can be reused across sessions.

### Invite code

The short code in a Space's public invite link, such as
`chalkmeet.com/abc-defg-hij`: ten lowercase letters shown in groups of three,
four and three. Chalk derives it from the public invite's current handle, so
rotating the invite replaces the code and disabling the invite stops it
working. An invite code opens a Space's public invite, never an Episode. Older
`/space/{slug}#spaceInviteToken=cspi1...` links keep working until their
invite rotates.

### Episode

One bounded run of live activity inside a Space. The dashboard calls it a session.

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
- Not a snapshot of the Space itself; an Episode contains its own config snapshot.

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

### Recording processing

A **Recording** is the Episode artifact for captured activity. It is not a
synonym for an MP4 file, a browser player, or a particular processing job. A
**Recording presentation** is the frozen description of what that Recording
shows over time: source visibility, layout, shared content, and required assets.

These terms separate the stages of Recording work:

- **Capture** receives and stores authorized source media and the inputs needed to reproduce the Recording presentation. It does not compose video or create a finished file.
- **Preparation** reconstructs usable, correctly timed source media from captured inputs. **Audio preparation** does this for Transcription without producing video frames or an MP4.
- **Rendering** produces output frames from the Recording presentation. The **render job** is the broader execution unit that also prepares, encodes, verifies and uploads, so its elapsed time is not rendering time alone.
- **Export** produces a portable file (an MP4) from a Recording. An existing file is downloaded again without repeating the work, and Export is not a second artifact identity.

Use explicit milestone names in design discussions: **capture complete**,
**preparation complete**, and **export ready**. Do not say "recording ready" to
mean different milestones interchangeably, or invent corresponding API states
without a separate contract change. Use **recorded duration** for source length
and **processing time** for elapsed work; never present one as the other.

### `<Chalk />`

The turnkey UI component: the complete embedded experience dropped into a
customer's app. It is a full name, not a prefix;
its interior tree is platform-named (SpaceView, Stage, panels)
with no `Chalk*` symbols.

### Entrance

A product-owned entry step before joining a Space. The web app asks for a name;
React Chalk joins directly through CallLimbo with the supplied defaults.
The React Native SDK retains its device-preparation Entrance.

### SpaceClient

The public client SDK entry: flat lifecycle (`join`/`leave`/`subscribe`/
`getSnapshot`, `endEpisode`/`extendEpisode`) plus namespaced controllers
`media`, `chat`, `participants`, `reactions`, `whiteboard` (chat files
under `chat.files`). Internally a `Connection`
coordinator owns the state machine, recovery, and access refresh; one
`SpaceSnapshot` store feeds every UI layer. Framework-agnostic; React and
React Native bind to the store, never to Effect internals.

### AccessGrant

The opaque signed envelope the customer's backend receives from the
server SDK and forwards to the client verbatim: sync token, media token,
participant identity, expirations. Customers
never construct or inspect it; the client's `getAccess` callback returns
it and Connection manages its refresh.

## Vendor terms

Vendor names stay foreign and live at adapter seams. Name the exact product,
never the family.

### Cloudflare SFU

Cloudflare Realtime SFU: the media server that receives each Participant's
tracks and forwards them to the others. It is one of Chalk's MediaPlane
adapters (Chalk's own SFU is the other), reached through the HTTPS API at
`rtc.live.cloudflare.com`. Say "Cloudflare SFU", not "Cloudflare Realtime".

- **Cloudflare Realtime** is the product family (formerly Cloudflare Calls):
  Realtime SFU, Realtime TURN, and RealtimeKit. Use it only when you mean
  the family.
- **Cloudflare TURN** is the relay a browser uses when a firewall blocks a
  direct media path. It is separate from the SFU but shares its free egress
  allowance.
- **RealtimeKit** (formerly Dyte) is Cloudflare's ready-made video UI SDK
  built on top of the SFU. Chalk does not use it.
- The `CHALK_CLOUDFLARE_REALTIME_*` environment variables hold Cloudflare SFU
  app credentials despite the family name.

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
5. **Domain names stay consistent.** Space and Episode name those concepts in
   code, API and UI. Everyday language in surrounding copy is unrestricted.

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

- UI shape suffixes: Screen, View, Panel, Dialog, Sheet, Popover, Menu,
  Overlay, Banner, Toast, Picker, Selector, Indicator, Preview. The suffix
  states the shape; the prefix states the subject.
- No `Chalk` prefix on symbols anywhere: the package is the namespace.
  Case-by-case exception only for Go/Elixir internals with real collisions.

## Legacy domain names

| Term                      | Status                                             |
| ------------------------- | -------------------------------------------------- |
| bot, assistant, AI        | Banned as domain nouns; the identity kind is Agent |
| attendee, peer, actor     | Banned roster nouns; the word is Participant       |
| signal (for availability) | Banned; the word is Presence                       |

These mappings describe domain concepts, not forbidden words in user-facing
copy. Product-layer features may carry their own names.
