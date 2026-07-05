# Chalk Core Spec

Chalk Core is the shared promise behind every Chalk meeting. It should make a
room feel easy to enter, calm to stay in, and trustworthy to leave.

This spec replaces the previous package. It is intentionally written in plain
language so the next version can be designed from the desired product
experience rather than from old habits.

## Purpose

Chalk Core should give every Chalk surface the same understanding of a meeting:
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

Chalk Core should support the common ways people communicate during a meeting:
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

Chalk Core should treat trust as part of the meeting experience. Roles,
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

Chalk Core should describe shared meeting behavior. It should not define the
visual style of each app, own platform-specific interface choices, or turn demos
into the source of product truth.

The product surfaces may feel different on web, phone, tablet, and desktop, but
they should agree on the meaning of a room, a person, a permission, a recording,
a message, and a failure.

## Done Means

The next version of Chalk Core is ready when a person can:

- create or receive a room invitation with confidence
- join with clear microphone and camera intent
- understand who is present and what is happening
- communicate through the expected meeting tools
- trust host controls and participant permissions
- recover from common interruptions without losing orientation
- leave without lingering side effects
- get useful, privacy-conscious support when something fails
