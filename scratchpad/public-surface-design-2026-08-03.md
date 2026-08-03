# Public surface design — the developer-facing API — 2026-08-03

Co-design sheet for the complete public surface: `createSpaceClient` /
`SpaceClient` (framework-agnostic core), `<ChalkProvider>` + hooks
(React bindings), and `<Chalk />` (turnkey component). Opened at Hasan's
request ("I still want to discuss the public API surface/shape … we
have to make sure it's good and coherent … I want to see all of it.
Leave nothing to chance"). Builds on the fully ratified
`client-sdk-split-design-2026-08-03.md`; the construction/auth seam
here must be ruled BEFORE the client-SDK wave launches.

**STATUS: FULLY RATIFIED (Hasan, live co-design, 2026-08-03 night).**
Every item ruled across four rounds. Final surface: `space` +
`getAccess` (→ `AccessGrant`, opaque) as the only required
integration; flat lifecycle + `endEpisode`/`extendEpisode` flat on the
client; `client.on(...)` typed emitter in the core; the five ratified
controllers; one `features` object; **the pre-join screen is named the
ENTRANCE** (Hasan: "Entrance is PERFECT!" — `entrance?: boolean`,
default true; component `<Entrance />`; the entrance also hosts
knock-admission waiting, unifying both pre-live states);
`defaults?: { microphone?: boolean; camera?: boolean }` (Hasan's own
proposal, keys mirrored in `client.join({ displayName?, microphone?,
camera? })`); NO className/containerClassName ever — `theme` is the
only styling door (mechanism ruled: closed typed token set as CSS
custom properties, CI-enforced token reach; token list arrives with
Hasan's design pass); controlled `phase` dead, `layout` stays
controlled-optional. The client-SDK wave now has its construction/auth
seam; the React wave inherits `<Chalk />` fully specified.

## The three layers and where they live

| Piece                     | Package                             | Framework                                   | What it is                                                                              |
| ------------------------- | ----------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `SpaceClient`             | `@q9labsai/chalk-client`            | agnostic (browser, Node, RN, any framework) | the engine: Connection + controllers + store                                            |
| `<ChalkProvider>` + hooks | `@q9labsai/chalk-react` (+ RN twin) | React                                       | invisible plumbing: context that shares one client with hooks/components                |
| `<Chalk />`               | `@q9labsai/chalk-react` (+ RN twin) | React                                       | the turnkey UI: creates a client, wraps it in the provider, renders the full conference |

`<Chalk />` IS `createSpaceClient` + `<ChalkProvider>` + prebuilt
components composed for you — each rung is sugar over the rung below,
nothing is a separate system. Vue/Svelte/vanilla users get the full
feature set from `SpaceClient` directly: the store's
`subscribe`/`getSnapshot` contract is framework-neutral
(`useSyncExternalStore`-compatible by design, but not React-dependent).
Today's `ChalkProvider` is already only a 14-line context wrapper; the
redesign keeps that honesty.

## The auth seam (Hasan: "I like the getAccess")

One callback powers every rung. The customer's backend mints an access
grant with the server SDK; the client receives:

```ts
getAccess: (ctx: { space: string; reason: "join" | "refresh" | "retry" }) => Promise<AccessGrant>;
```

R1 requires a callback, not a static token: silent pre-join re-fetch,
scheduled refresh, wake/foreground revalidation, and
refresh-once-retry-once all need the ability to ask for fresh access.
`AccessGrant` is the opaque signed envelope the server SDK returns
(sync + media tokens + participant identity); customers never build it
by hand and never inspect it.

## Full surface: `@q9labsai/chalk-client` (framework-agnostic)

```ts
const client = createSpaceClient({
  space: "design-review",   // Space slug — the join target
  getAccess,                // the auth seam above
  baseUrl?: string,         // Chalk environment override
  logger?: ChalkLogger,     // observability taps
  telemetry?: TelemetryOptions,
});

// Lifecycle — flat on the client (ratified: lifecycle stays flat)
await client.join({
  displayName?: string,          // guests; members arrive named via access
  microphoneEnabled?: boolean,   // initial device state
  cameraEnabled?: boolean,
  microphoneDeviceId?: string,
  cameraDeviceId?: string,
});
await client.leave();
client.dispose();
client.subscribe(listener): Unsubscribe;
client.getSnapshot(): SpaceSnapshot;

// Episode lifecycle — flat, capability-gated (PROPOSED: flat, not a controller)
await client.endEpisode();
await client.extendEpisode(minutes);

// Discrete events (PROPOSED: typed emitter in core, not React-only)
client.on("participantJoined" | "participantLeft" | "episodeEnded"
        | "screenShareStarted" | "screenShareStopped" | "error", handler);

// Controllers — namespaced commands (ratified set)
client.media.setMicrophoneEnabled(enabled);
client.media.setCameraEnabled(enabled);
client.media.setScreenShareEnabled(enabled);
client.media.selectMicrophone(deviceId);
client.media.selectCamera(deviceId);
client.media.selectSpeaker(deviceId);
client.media.acceptRequest(requestId);   // incoming request-unmute/camera
client.media.declineRequest(requestId);

client.chat.send({ text, attachments? });
client.chat.loadOlder();
client.chat.markRead(messageId);
client.chat.files.upload(file): Promise<ChatAttachment>;
client.chat.files.url(attachment): string;

client.participants.assignRole(participantId, roleName);
client.participants.mute(participantId);
client.participants.stopVideo(participantId);
client.participants.stopScreenShare(participantId);
client.participants.requestMedia(participantId, "microphone" | "camera");
client.participants.remove(participantId);
client.participants.admit(requestId);
client.participants.deny(requestId);
client.participants.raiseHand();
client.participants.lowerHand();
client.participants.renameSelf(displayName);

client.reactions.send(emoji);

client.whiteboard.transport();  // engine attach point; permissions derive
                                // from capabilities like everything else
```

`SpaceSnapshot` slices (per-slice referential stability, ratified):

- `connection`: status (idle/joining/live/reconnecting/leaving/left/
  failed), episode { id, startedAt, deadline }, lastError
- `self`: participantId, displayName, role, capabilities, handRaised —
  plus `can(capability)` convenience derived from capabilities
- `participants`: roster with per-participant role, media state, hand,
  admission queue
- `media`: local device list + selection, local tracks, remote tracks,
  screen share, incoming media requests
- `chat`: messages, pendingSends, readReceipts, unreadCount, pagination
  cursor
- `reactions`: active expiring reactions
- `whiteboard`: open state, engine status

Errors are tagged with glossary codes (`episode.ended`,
`access.invalid`, `chat.payload_invalid`). Effect-native entry mirrors
the whole surface (D7, ratified). Server SDK (`server` entry) mints
`AccessGrant`s — same package family, Node-only.

## Full surface: `<Chalk />` (React turnkey)

```tsx
<Chalk
  // Integration — the only required props
  space="design-review"
  getAccess={({ space, reason }) => fetchAccess(space)}
  // OR bring a pre-built client instead of the two above:
  client={spaceClient}

  // Identity & pre-join
  displayName?: string
  preJoin?: "always" | "skip"       // replaces autoJoin/initialPhase/phase
  initialSettings?: { microphoneEnabled?, cameraEnabled?,
                      microphoneDeviceId?, cameraDeviceId? }

  // Product feature toggles — does this UI HAVE the feature at all.
  // (Permissions are NOT props: whether the user MAY act comes from
  // capabilities in the snapshot.)
  features?: { chat?, participants?, admission?, screenShare?,
               whiteboard?, reactions?, handRaise?, info?, settings? }

  // Appearance
  theme?: ChalkTheme                // token overrides per 2026-08-01 mockups
  logoUrl?: string
  spaceName?: string                // header display; defaults from Space
  inviteLink?: string               // shown in the info panel
  layout?: ConferenceLayout         // controlled optional
  onLayoutChange?: (layout) => void
  className?: string

  // Events (mirror client.on)
  onJoined? onLeft? onEpisodeEnded?
  onParticipantJoined? onParticipantLeft?
  onScreenShareStarted? onScreenShareStopped?
  onError?
/>
```

### Deaths from today's `VideoConferenceProps` (~45 props), with reasons

| Today                                                | Fate                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `roomId`                                             | → `space` (slug; glossary)                                     |
| `userName`                                           | → `displayName`                                                |
| `meetingLink`                                        | → `inviteLink` (meeting is dead vocabulary)                    |
| `roomName`                                           | → `spaceName`                                                  |
| `role: "host" \| "participant"`                      | DIES — roles are customer-defined; UI derives from snapshot    |
| `canShareScreen/…/canLeave` (9 props)                | DIE — capabilities in the snapshot answer "may I"; never props |
| `chatEnabled/…/settingsEnabled` (9 props)            | → one `features` object                                        |
| `createSession`                                      | DIES — `space`+`getAccess` (or `client`) replace it            |
| `autoJoin`, `initialPhase`, `phase`, `onPhaseChange` | → `preJoin` + lifecycle events                                 |
| `initialJoinSettings`                                | → `initialSettings`                                            |
| `onSessionChange`                                    | DIES — headless needs use the `client` prop rung               |
| `onSessionEnded`                                     | → `onEpisodeEnded`                                             |
| `onLeave` + `onClose`                                | → `onLeft` (one exit event)                                    |

## `<ChalkProvider>` + hooks (React custom-UI rung)

```tsx
<ChalkProvider client={spaceClient}>…</ChalkProvider>
```

Hooks become selectors over the store (ratified: hooks derive from
store; the mirror layers die). Naming preview for the React wave:
`useSpaceClient()`, `useSpaceSelector(sel, eq?)`, `useConnection()`,
`useSelf()`, `useParticipants()`, `useLocalMedia()`, `useRemoteMedia()`,
`useChat()`, `useReactions()`, `useWhiteboard()`. Prebuilt components
(ControlBar, ParticipantGrid, ChatPanel, …) consume the same context —
what `<Chalk />` composes internally.

## DECIDE (Hasan)

**RULED (Hasan, 2026-08-03 night): 1 = flat `endEpisode`/`extendEpisode`
on the client; 2 = `client.on(...)` typed emitter in the core; 3 = one
`features` object.** Controlled `phase` mode dies regardless of item 4's
outcome (no one asked to keep it).

Open items from the same exchange:

4. **"Pre-join" concept + name rejected by Hasan** ("what is even
   preJoin … i don't even like the naming at all. prejoin itself not
   just the prop"). What it actually is: the screen before entering —
   guest types a name, toggles mic/cam with a camera preview, presses
   join. The concept earns its place (device permission + "check
   yourself" before being visible is expected in conferencing; guests
   need a name prompt) but the name is developer-jargon. PROPOSED:
   rename to **green room** — the theater term for where participants
   prepare before going on, a natural sibling of Space/Episode/
   Participant. Prop: `greenRoom?: boolean` (default true; false =
   instant join).
5. **AccessGrant explained** (Hasan: "what was AccessGrant?"): it is
   today's `ParticipantAccess` envelope renamed — the bundle the
   customer's backend receives from Chalk when it asks "admit this
   person to this Space as this role": signed sync token + media token
   - participant identity + expirations. The backend forwards it to the
     client verbatim; `getAccess` returns it; Connection consumes it.
     Opaque = customers never construct or read its fields. Name itself
     open: `AccessGrant` vs keeping `ParticipantAccess`.
6. **`initialSettings` doubted.** SpaceClient.join() needs initial
   mic/cam state regardless (headless users must say). PROPOSED
   slimming for `<Chalk />`: `initialSettings?: { microphoneEnabled?,
cameraEnabled? }` only — device _selection_ is remembered by the SDK
   (persisted preference), not passed as props.
7. **`className` doubted** ("should we even have that?"). PROPOSED:
   keep it root-only for layout/sizing (height/width/positioning in the
   host page), explicitly NOT a theming mechanism; internal DOM class
   names are not API. Alternative: drop it and require a wrapper div.
8. **`theme` — RULED (Hasan, 2026-08-03: "ok that theme decision makes
   sense").** Mechanism locked: typed closed token set delivered as CSS
   custom properties scoped to the Chalk root; simple knobs
   (`colorScheme`, `accent`) + `tokens?: Partial<ChalkThemeTokens>`;
   TS rejects unknown keys; CI gate forbids literal colors in component
   styles so tokens provably reach every surface we render; external
   CSS against our DOM is out of contract. Token LIST arrives with
   Hasan's design pass (2026-08-01 mockups are canon).

### Second round (Hasan, same night)

- **Pre-join name: wants more candidates discussed** (green room was
  one option, not yet accepted). Candidate field with collision notes:
  green room (theater; fits Space/Episode/Participant; zero product
  collisions), preview (literal self-check; universally understood;
  slightly undersells the name-entry part), lobby (familiar BUT
  Teams/Zoom use it for admission-waiting — collides with our knock
  flow), check-in (event vocabulary; hints attendance recording),
  backstage (StreamYard uses it for hosts-only pre-show — collides
  with a plausible future feature), entry/setup (plain, unpoetic),
  ready check (gaming), foyer (theater-true but obscure). Claude rec:
  green room first, preview second.
- **`initialSettings` name rejected, concept fine.** Hasan floated a
  `defaults` object. PROPOSED: `defaults?: { microphone?: boolean;
camera?: boolean }` — short keys, no "Enabled" suffix (the object is
  about starting state, context makes it unambiguous). Headless mirror
  keeps the same keys: `client.join({ displayName?, microphone?,
camera? })`.
- **`className` — RULED (Hasan): dropped entirely** ("we should leave
  containerClassName or className out, it just adds to the confusion").
  `<Chalk />` fills its parent container; sizing/placement belongs to
  the host's wrapper element; `theme` is the only styling door.
- **Envelope name — RULED (Hasan): `AccessGrant`** (renames today's
  `ParticipantAccess`; stays fully opaque).
- **Green room REJECTED (Hasan: "absolutely confusing"); third naming
  round asked, thinking along and outside Space/Episode lines.**
  Candidates offered: **entrance** (spatial sibling of Space — every
  Space has an entrance; unifies device-setup AND knock-waiting as one
  place; `entrance={false}` = walk straight in), **join screen**
  (maximally literal; the screen with the Join button), **arrival**,
  **soundcheck** (broadcast-flavored device check; audio-biased),
  **welcome** (generic-warm). Claude rec: entrance first, join screen
  as the bulletproof literal. Lobby stays vetoed (admission-waiting
  collision in Teams/Zoom).
- **RULED (Hasan, fourth round): "Entrance is PERFECT!"** The screen is
  the Entrance; `entrance?: boolean` on `<Chalk />`; `<Entrance />`
  replaces `PreJoinScreen`; knock-admission waiting happens at the
  entrance too. `defaults` shape stands as proposed (Hasan's own
  suggestion, unvetoed across two rounds). Sheet closed.
