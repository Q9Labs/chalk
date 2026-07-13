# @q9labsai/chalk-client

Chalk Client is the shared promise behind every Chalk meeting. It should make a
room feel easy to enter, calm to stay in, and trustworthy to leave.

This spec replaces the previous package. It is intentionally written in plain
language so the next version can be designed from the desired product
experience rather than from old habits.

## Purpose

Chalk Client should give every Chalk surface the same understanding of a meeting:
who is here, what is happening, what each person can do, and how the room should
recover when something goes wrong.

It should make simple things simple: start a room, join a room, invite someone,
talk, listen, share, draw, react, record when allowed, and leave cleanly.

It should also make stressful moments understandable. When a connection is weak,
a device is unavailable, a room is full, or a person does not have permission to
act, Chalk should explain the situation in human terms and offer the safest next
step.

## Product Principles

- A meeting should feel alive, but not noisy.
- Joining should be quick, forgiving, and clear.
- People should always know whether they are visible, audible, connected, or
  waiting.
- Hosts should have confidence that room controls mean what they say.
- Participants should never be surprised by recording, screen sharing, or
  permission changes.
- Recovery should prefer continuity over disruption.
- Leaving should be as deliberate and reliable as joining.
- Troubleshooting should help support teams without exposing private meeting
  content.

## The Room Experience

A room begins before people join it. Chalk should support scheduled rooms,
instant rooms, familiar room names, and shareable invitations that feel safe to
send.

When someone enters, Chalk should help them understand where they are, who they
are joining, and what will happen to their microphone and camera. If entry is
blocked, the reason should be plain: the room ended, the invite is invalid, the
room is not ready, access is missing, or capacity has been reached.

Inside the room, Chalk should keep a shared sense of presence. People should see
who is present, who is speaking, who is sharing, who is having trouble, and who
has recently joined or left. These signals should be steady enough to trust and
quiet enough not to distract.

## Communication

Chalk Client should support the common ways people communicate during a meeting:
voice, camera, chat, reactions, raised hands, transcripts, and shared visual
work.

Each communication mode should respect intent. Muting should mute. Stopping
video should stop video. Sending a chat message should make it clear whether the
message was sent, delayed, or failed. Reactions should feel lightweight and
temporary. Transcripts should make conversations easier to revisit without
making people feel surveilled.

## Shared Work

Chalk meetings often include work that is created together. The room should
support shared drawing, shared attention, and shared context without making one
person's screen the only place where the work feels real.

People should understand when they can contribute, when they are viewing only,
and when a host has changed those permissions. Shared work should survive brief
interruptions and should avoid surprising jumps, duplication, or missing pieces.

## Trust And Control

Chalk Client should treat trust as part of the meeting experience. Roles,
permissions, recording, moderation, and room endings should be clear to everyone
affected by them.

Hosts should be able to guide the room without fighting the product.
Participants should be protected from accidental exposure, unclear recording
states, or hidden changes that affect what they can do.

Where the product cannot be certain, it should say so gently and choose the
least surprising behavior.

## Reliability

Chalk should assume real meetings happen on imperfect networks, busy devices,
and interrupted attention.

Temporary problems should feel temporary. If Chalk can recover, it should keep
people oriented while it recovers. If Chalk cannot recover, it should explain
what changed and help the person rejoin or exit cleanly.

The room should avoid moments where different people see contradictory meeting
reality. When Chalk heals after an interruption, the user experience should make
the healed state feel obvious.

## Support And Diagnostics

When something fails, Chalk should help a person ask for help without needing to
understand internals. A support report should describe the shape of the problem,
the timeline of user-visible events, and the safe context needed for a support
team to investigate.

Support information should avoid private conversation content, secrets, raw
customer identifiers, or anything that would make a participant less safe.

## Boundaries

Chalk Client should describe shared meeting behavior. It should not define the
visual style of each app, own platform-specific interface choices, or turn demos
into the source of product truth.

The product surfaces may feel different on web, phone, tablet, and desktop, but
they should agree on the meaning of a room, a person, a permission, a recording,
a message, and a failure.

React, React Native, web, and demo surfaces should not invent meeting behavior
just to make a screen appear connected. If the shared behavior does not exist
yet, the surface should stay presentational and receive real data from its
caller. It should not keep fake hooks, fake managers, fake sessions, fake
diagnostics, or placeholder meeting flows that look like a future core.

The UI packages should own reusable visual pieces, shared styles, shared
assets, and small presentation constants such as reaction choices. They should
not own room truth, joining, permissions, transport, diagnostics, recording,
chat delivery, transcript state, or meeting recovery.

Every public import should be intentional. Importing a small visual layer should
not quietly bring in a full meeting experience. Importing an Android surface
should not bring in iOS surfaces. Importing a React visual package should not
bring in React Native visuals. The package surface should make those choices
plain so applications only carry what they actually use.

There should be no placeholder logic kept as a reminder of what core might do
later. The reminder belongs here, in this spec. The code should either be real
owned behavior in the right package or no behavior at all.

## SyncEngine v3

`V3SyncClient` is the provider-neutral conference state client. Point it at the
exact `/v3/sync` websocket endpoint and supply a participant token plus a
platform websocket factory. Applications that use self-media setters must also
install a `V3ClientMediaPlane` adapter. The server result authorizes the live
target, then the same stable operation ID is passed to
`setLocalPublicationTarget`; the Promise resolves only after both halves report
`confirmed` or `satisfied`, so wire permission never masquerades as a real
microphone, camera, or screen change. The adapter exposes read-only local and
remote publication observations and deliberately has no remote force-on method.

The Session snapshot composes durable control state with replace-latest media
and presence projections. Capabilities are always derived from the durable role
map, and directed media requests remain live-only.
The snapshot keeps canonical `control` separate from `optimisticControl`, so a
pending target never masquerades under the authoritative revision and digest.

Durable setters and operations accept an optional stable `commandId`; otherwise
the client generates one. The five durable target methods are
`setHandRaised`, `setDisplayName`, `setAdmissionPolicy`, `setParticipantRole`,
and `transferHost`. Local media uses `setMicrophoneEnabled`,
`setCameraEnabled`, and `setScreenShareEnabled`. Remote media can only be
stopped through the moderation methods or requested through `requestUnmute`
and `requestStartCamera`; the SDK has no remote force-on surface.

## Core-Owned Behaviors

Chalk Client should own the behaviors that make every surface agree on how a
meeting begins, who may enter, and what happens when access changes.

Core should own invitation understanding. A Chalk invite should mean the same
thing on web, React, React Native, plain JavaScript, or an embedded surface. A
surface may decide how to display an invite, but Core should decide whether the
invite is recognizable, usable, expired, invalid, or points to a room that can
actually be joined.

Core should own access and token lifecycles. Hosts, guests, refreshed access,
expired access, and failed access should behave consistently across platforms.
An app should not have to invent its own idea of when access is fresh enough to
reuse, when it must be refreshed, or when a person needs to start over.

Core should own room creation. Starting a meeting should produce the same kind
of room identity, room name, host access, and shareable invitation no matter
which surface started it. Apps may choose the button, flow, and wording, but
not the meeting truth.

Core should own join resolution. A person who follows an invite should arrive at
the same room, with the same role and same understandable failure reasons, on
every surface. The surface can decide whether that appears as a lobby, sheet,
modal, or full screen.

Core should own diagnostics meaning. Support information should describe the
safe shape of a failure, the broad timeline of what happened, and the current
meeting state without leaking private content or secrets. Platform packages may
add device context, but Core should define the shared support story.

Core should own friendly room identity. Human-readable room names, canonical
room identity, and invite identity should not drift between apps. If two
surfaces refer to the same room, people should see a consistent meeting
identity.

## Done Means

The next version of Chalk Client is ready when a person can:

- create or receive a room invitation with confidence
- join with clear microphone and camera intent
- understand who is present and what is happening
- communicate through the expected meeting tools
- trust host controls and participant permissions
- recover from common interruptions without losing orientation
- leave without lingering side effects
- get useful, privacy-conscious support when something fails
