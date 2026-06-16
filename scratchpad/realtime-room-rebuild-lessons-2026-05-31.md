# Realtime Room Rebuild Lessons

Date: 2026-05-31

This note was rewritten with `gemini-3.1-pro-preview` from the earlier Chalk realtime architecture research. It is framed for greenfield ideation, not migration.

## One Sentence

Building a stable realtime room means treating connection state, user permissions, and session lifecycles as explicit, server-authoritative state machines rather than implicitly trusting network presence and client-side events.

## The Mental Model

When you build your first video conferencing app, the intuitive approach is to map everything to the physical world: a room is a place, and people are either in it or they are not. In software, this translates to a single database row for the "room" and a simple boolean for "connected."

This model works perfectly until the internet gets involved. In a real-world production environment, "connected" is not a single state. A user can have a valid access token, a dead WebSocket, a reconnecting media transport, stale permissions, and a disabled camera, all at exactly the same time. If your architecture compresses all of these realities into a single active flag, your application will constantly lie to your users.

Instead of thinking of a meeting as a single monolithic switch, think of it as a stack of independent lifecycles. First, there is the room itself, a stable, reusable identity like a URL or a calendar invite. Second, there is the room session, a specific, time-bound occurrence of a meeting that has a clear beginning and end. Third, there is the user's identity, who they are in your system. Finally, there is the participant session, the specific instance of that user joining, dropping, reconnecting, and eventually leaving the current room session.

When you separate these concepts, you stop tearing down entire meetings just because the network hiccupped. The server becomes the absolute source of truth for who is allowed to be there and what they are allowed to do. The client's job is simply to reflect that truth, degrade gracefully when the network gets choppy, and explicitly track when it has fallen out of sync.

## The Lessons

**Never Trust Network Disconnects as Intentional Leaves**

The most common mistake in realtime architecture is assuming that a closed socket means the user walked away. In reality, laptops go to sleep, mobile phones switch from Wi-Fi to cellular, and home routers reset. If your server treats a dropped signaling or media connection as a voluntary departure, it triggers a destructive chain reaction: it broadcasts a participant-left event, recalculates the active roster, and if the roster hits zero, it might permanently end the room and finalize the recording. When the user reconnects three seconds later, the meeting they were just in has been destroyed. You must build an explicit reconnecting state with a grace period. A participant only truly leaves when they explicitly request to, or when their grace period expires.

**Permissions Cannot Live Only in the Token**

In early iterations, it is tempting to bake a user's role and capabilities, like host or recording privileges, directly into their JWT access token. This is fast and stateless, but it means the token itself becomes the source of truth. If a rogue participant is kicked from the room, or if a host is demoted, their existing token remains valid until it expires. They can simply reconnect their WebSocket and continue using old authority. Permissions and moderation actions must be treated as durable room-control events. Every sensitive action must be evaluated against a live, server-side policy state, ensuring that revocation is instant and absolute across all layers of the application.

**Clients Should Propose, Not Decide**

Client applications should never have the authority to declare their own state or permissions. If your join flow allows the client to dictate its role, you have built an escalation vulnerability. Similarly, if the client optimistically updates its own media state, like declaring its camera is now on, without receiving a definitive confirmation from the authoritative system, late-arriving network events can easily overwrite that state, leading to a confusing, flickering UI. The client's job is to propose an intent. The server decides the outcome, logs the transition, and broadcasts the new authoritative reality.

**Media Health is Separate from Meeting Lifecycle**

A user's journey into a meeting is multi-staged: they authenticate with your API, they establish a control signaling channel, and they negotiate a media bridge for audio and video. If these stages are implicitly linked, failure in one can mask the state of another. For example, if a user passes API admission but their corporate firewall blocks the WebRTC media bridge, the backend might still consider them an active participant. The rest of the room sees a ghost tile of a user who never fully arrived. Your architecture needs a granular connection vector that tracks signaling, media transport, device health, and room control independently, allowing the UI to explain exactly where the failure occurred.

**Snapshots Need Generations, Not Just Timestamps**

When a client drops offline and reconnects, it needs to know what it missed. A common, flawed approach is to ask the server for all events since a last-seen timestamp. Wall-clock time is unreliable in distributed systems. It leads to missed events, duplicated actions, and subtle state corruption. Instead, every room session must have a monotonic revision number or generation ID. When the client reconnects, it reports the last revision it saw. The server can then reliably send exactly the deltas required, or recognize that the gap is too large and send a fresh, authoritative snapshot.

## What To Copy From Production Systems

**LiveKit and Twilio Video**

These platforms teach us to treat reconnection as a primary feature, not an edge-case error. They explicitly distinguish between a signaling disconnect and a media disconnect. They do not just emit a generic error; they provide granular events for connection quality shifts, track publication changes, and device failures. This allows the application to communicate clearly with the user before a hard disconnect happens.

**AWS Chime**

Chime separates the lifecycle of the meeting from the connection health of the individual participant. It emits specific observer callbacks for poor connections, allowing the UI to suggest actionable remedies, like prompting the user to turn off video to preserve audio quality. It also clearly distinguishes between a clean, intentional stop and a failure-induced stop.

**Jitsi**

Jitsi's architecture is useful because it separates the application control plane from the media routing bridge. By ensuring that media bridge state does not pollute the room's control state, temporary media routing failures do not silently destroy the logical integrity of the meeting.

**Matrix, Convex, and Zero**

These synchronization systems demonstrate the power of treating the client view strictly as a projection of server truth. They rely on explicit synchronization cursors and gap-aware incremental state. They assume that events will arrive out of order or go missing, and they build their foundational sync protocols to detect and heal these discrepancies automatically.

**Google Meet**

Looking at Google Meet through public APIs and support documentation, the useful lesson is separation. Stable collaborative spaces are not the same as individual meeting instances. User identity is not the same as participant sessions. Troubleshooting separates sender-side issues, receiver-side issues, devices, networks, and bottlenecks. The product goal is graceful degradation that keeps communication flowing as long as possible.

## What We Should Decide Before Building

Before writing code, the architecture team needs to agree on several definitions.

First, what exactly is a session? Is it tied to the media provider's lifecycle, or is it a strict, database-backed server epoch that decides when a meeting truly begins and ends?

Second, who owns truth for roster and presence? The clean answer is the Chalk control plane. The media provider and client can provide evidence, but they should not be the final authority.

Third, what is the reconnect grace period? We need to decide how long a transport can drop before we officially declare a participant left, and what the rest of the room sees during that limbo.

Fourth, how do we resolve conflicting realities? If the media bridge says a user is still transmitting but the control plane says they were kicked, the control plane must win and sever the media session.

Finally, what is hard revocation? When a host clicks remove, we need the exact sequence that invalidates the participant session, closes WebSockets, rejects token refresh, and ejects them from the media provider.

## The First Version Should Be Boring

When building a realtime system, the temptation is to employ clever optimizations: deeply optimistic UIs, custom protocols, or distributed state reconciliation before the core model is stable. Resist this urge.

The first version of a new realtime architecture should be aggressively boring. Use explicit, typed state machines with rigid transition boundaries. Force every state change to include a documented cause. If a user disconnects, do not guess their intent. Transition them to reconnecting, start a strict countdown, and wait.

Keep the data model relational and unforgiving. Rooms must have distinct room sessions. Users must have distinct participant sessions. Every action must validate against the current active session. If the foundation is boring, predictable, and server-authoritative, the resulting frontend experience can feel seamless, stable, and quietly magical.
