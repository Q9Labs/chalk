# Chalk SDK Ubiquitous Language

This document defines the canonical language for Chalk SDKs. It applies to
public SDK types, methods, hooks, components, props, events, files, examples,
and documentation across platforms.

Server routes, persistence, infrastructure, providers, and wire-protocol
internals are outside its scope. SDKs may expose domain concepts supplied by the
shared contract, but this document governs how SDK developers encounter and
compose them.

Current SDKs may use different names. Those differences are migration work, not
alternate vocabulary. Historical React and React Native APIs do not constrain
the redesign.

## Core rules

1. One concept has one public name across every SDK.
2. Platform packages provide platform implementations without `Web`, `Native`,
   `Mobile`, or `Desktop` prefixes on shared public symbols.
3. A suffix states the UI shape. A prefix states the subject: `ChatPanel`,
   `SettingsDialog`, and `LayoutPicker`.
4. Responsive presentation does not create another component name.
5. Public names describe developer intent rather than implementation machinery.
6. The React package root exports the turnkey `VideoConference` and its public
   types. Composable visuals are exported from the `/components` subpath.
7. Historical names are removed without compatibility aliases.

## SDK layers and ownership

The SDK family has three conceptual layers:

1. The **client SDK** owns headless runtime state, commands, events, media,
   admission, permissions, recovery, and diagnostics.
2. A **UI SDK** binds client state and commands to platform components and
   interaction patterns.
3. An **application** supplies product policy, credentials, navigation, and
   application-specific composition.

The client SDK is the source of truth for live Session behavior. UI SDKs project
that truth; they do not recreate participant state, capabilities, media state,
message delivery, admission, or reconnection in component-local state.

### Client

**Client** is the configured entry point for headless Chalk capabilities. The
canonical factory is `createClient(options)`. Package context makes
`ChalkClient` redundant.

Client resolves invitations, coordinates explicitly named credentials through
an application-supplied credential provider, and creates a SessionClient. It
does not represent an active Session itself.

### SessionClient

**SessionClient** is one local SDK instance participating in one Session. It
owns the local join lifecycle, observable state, commands, subscriptions,
recovery, and cleanup.

Session is the shared occurrence. SessionClient is the local handle. Closing a
SessionClient does not imply ending the shared Session.

Related capabilities may be grouped into domain **facets**, such as `devices`,
`media`, `chat`, `admission`, and `diagnostics`. Facets keep the primary handle
navigable without introducing Manager, Service, Helper, Controller, or Util
objects.

### Snapshot and subscription

A **Snapshot** is an immutable, internally consistent view of current client
state. Public Snapshot types qualify their subject, such as SessionSnapshot.
`getSnapshot()` reads it and `subscribe(listener)` observes changes. Framework
bindings select projections from this external store.

React hooks use `useSyncExternalStore` or an equivalent library adapter over
this contract. Mirroring a Snapshot into component state with an Effect is not
part of the architecture.

**State** means a structured current snapshot. **Status** means one enum field
within state. **Event** means a fact that occurred. Events are not the durable
source of current UI state.

## SDK runtime nouns

These nouns describe the runtime objects and projections that SDK consumers use.

### Room

A **Room** is the durable, reusable place in which Sessions occur. It may exist
without an active Session and keeps the same identity across occurrences.

Room is a runtime noun, not a visual component name.

### Session

A **Session** is one active or historical occurrence inside a Room. Rejoining
the same occurrence does not create another Session. A later occurrence in the
same Room does.

Session data describes the shared occurrence. Local actions, subscriptions, and
connection lifecycle are exposed through SessionClient.

### User

A **User** is a durable authenticated identity that may participate across
Rooms and Sessions. A Participant is the Session-scoped projection of a User or
guest. User and Participant IDs are never interchangeable.

### Participant

A **Participant** is an identity inside one Session. Participant is the base
public type shared by local and remote projections.

ParticipantId identifies one attendance in one Session. It remains stable
across reconnects and changes on rejoin. The same User joining from two devices
creates two Participants with one UserId and distinct ParticipantIds.

### LocalParticipant

The **LocalParticipant** is the Participant controlled by the current SDK
instance. It exposes local media and interaction actions.

### RemoteParticipant

A **RemoteParticipant** is another Participant observed by the current SDK
instance. Its state is read-only from the local SDK's perspective except through
explicit moderation actions.

### PendingParticipant

A **PendingParticipant** has requested admission and is not yet part of the
active participant roster. Host-facing admission UI displays
PendingParticipants.

### Connection

A **Connection** is the SDK's projection of transport connectivity for the
current Session. Consumers observe Connection status; they do not construct
Connections or use them as Participant identity.

ConnectionId identifies one transport connection. It changes during reconnect
and remains internal unless advanced diagnostics require it.

Canonical ConnectionStatus values are:

- `connecting`
- `connected`
- `reconnecting`
- `disconnected`

### Presence

**Presence** is the live availability projection for a Participant. It includes
ephemeral facts such as online state, speaking state, and last activity. Media
publication state and durable Participant profile data remain separate.

## Client lifecycle

### JoinStatus

**JoinStatus** describes the local participant's membership lifecycle:

- `idle` — no join attempt has started.
- `joining` — a join attempt is in progress.
- `waiting` — an AdmissionRequest is awaiting a decision.
- `joined` — the LocalParticipant belongs to the Session.
- `leaving` — local departure is being finalized.
- `left` — local membership has ended cleanly.
- `denied` — admission ended with an expected negative decision.
- `failed` — the join or leave operation reached a terminal failure.

JoinStatus and ConnectionStatus are separate. A joined participant may move
from `connected` to `reconnecting` without joining again.

### ConnectionStatus

**ConnectionStatus** is the transport projection already described by
Connection: `connecting`, `connected`, `reconnecting`, or `disconnected`.

The UI derives ConferencePhase from JoinStatus and ConnectionStatus. It does not
maintain an independent competing lifecycle machine.

### Invitation and credentials

An **Invitation** is a shareable reference that resolves to a Room and its join
requirements. It is not synonymous with a bearer credential.

A **JoinToken** is a short-lived credential authorizing a specific join. A
**UserAccessToken** authenticates a durable User to client-accessible account
capabilities. Generic `token`, `key`, and `secret` names are prohibited.

A **CredentialProvider** is an application-supplied function that obtains and
refreshes the credential the Client requests. Browser and mobile SDKs never
receive server secrets.

### Join and leave

**Join** establishes the LocalParticipant's membership in a Session. **Leave**
ends only that local membership. **EndSession** ends the shared Session for
everyone and requires the corresponding capability.

Unexpected disconnection does not mean Leave. Recovery preserves the same
Participant and Session identity whenever the server accepts continuity.

### Reconnect and rejoin

**Reconnect** is automatic, transport-level, and identity-preserving. A
successful reconnect keeps the same Session and Participant identities.

**Rejoin** is a new Join after local membership ended. It targets the same
Session when that Session remains active and creates a new Participant identity.
Applications may offer rejoin; the client SDK performs reconnect automatically.

## Media and devices

### MediaDevice

A **MediaDevice** is a selectable local hardware or virtual input/output. Its
kind is `microphone`, `camera`, or `speaker`. Device availability is separate
from whether media is currently enabled.

Use `selectCamera(deviceId)`, `selectMicrophone(deviceId)`, and
`selectSpeaker(deviceId)` for device choice. **Speaker** means an output device;
voice activity uses `isSpeaking` and `dominantSpeaker`.

### DevicePermission

**DevicePermission** is the operating-system or browser grant for microphone or
camera access. Its status is `prompt`, `granted`, or `denied`. Session authority
uses Capability and never DevicePermission.

### MediaTrack

A **MediaTrack** is one live audio or video flow. Its kind is `audio` or `video`;
its source is `microphone`, `camera`, `screen`, or `screenAudio`. A local track
captures media; a remote track receives media. Track identity is not Participant
identity.

### MediaPublication

A **MediaPublication** is a Participant's advertised media source and metadata.
It may exist while its MediaTrack is unavailable, paused, or unsubscribed.

### MediaSubscription

A **MediaSubscription** is the local receiving relationship to a remote
MediaPublication. Subscription policy belongs to the client SDK; rendering
belongs to the UI SDK.

### Microphone and camera intent

Use idempotent command pairs `enableMicrophone()` and `disableMicrophone()`, and
`enableCamera()` and `disableCamera()`. `toggleMicrophone` and `toggleCamera` are
avoided because their result depends on possibly stale state. UI components may
present one toggle control by selecting the correct explicit command from the
current Snapshot.

**Enabled** describes local capture and publishing intent. **Mute** is reserved
for moderation of another Participant. Local playback uses volume or
subscription controls and is not called mute.

### ScreenShare

**ScreenShare** is shared visual media, optionally with audio, published by a
Participant. It is not a Participant, Layout, or Stage. Use
`startScreenShare(options)` and `stopScreenShare()` for commands and
`ScreenShareStartedEvent` and `ScreenShareStoppedEvent` for facts.

## Communication and collaboration

### ChatMessage

A **ChatMessage** is a message sent within a Session. A locally created message
has a stable client-generated identity so delivery can move through `sending`,
`sent`, and `failed` without duplicating the message.

Use `sendMessage(input)` for the command. **Message** alone is too broad for a
public type when chat is the subject.

### AppData

**AppData** is application-defined machine-readable data sent through a Session.
It has no chat history, human authorship, or presentation semantics. Use
`sendData(payload, options)` and AppDataReceivedEvent.

ChatMessage and AppData are separate. `signal`, `broadcast`, `channel`, and
generic `message` do not name AppData.

### Reaction

A **Reaction** is an ephemeral expression from a Participant. It is not a
ChatMessage and does not enter chat history. Use `sendReaction(reaction)`.

### RaisedHand

**RaisedHand** is participant state expressing a request for attention. Use
`raiseHand()` and `lowerHand()`; do not model it as a Reaction.

### Transcript and TranscriptSegment

A **Transcript** is the ordered textual record associated with a Session or
Recording. A **TranscriptSegment** is one attributed, time-bounded unit within
it. **Transcription** names the process that produces a Transcript.

### Recording

A **Recording** is a captured media artifact from one Session. Recording state
describes capture and processing separately; a stopped recording may still be
processing and is not yet ready for playback or download.

### Whiteboard

**Whiteboard** is shared collaborative state associated with a Session.
Whiteboard commands and state belong to the owning headless package;
WhiteboardView presents that state inside Stage.

## Admission, capabilities, and moderation

### AdmissionRequest

An **AdmissionRequest** is a request to join a Session that requires a decision.
It references a PendingParticipant and has the status `pending`, `admitted`,
`denied`, `cancelled`, or `expired`.

Use `admit(requestId)` and `deny(requestId)` for commands. `WaitingRoom` is not a
headless runtime noun.

### Role and Capability

A **Role** is a named bundle of expected authority. A **Capability** is the
client's current evaluated answer to whether an action is available after roles,
Session policy, and runtime conditions are applied.

UI SDKs render capabilities such as `canShareScreen`, `canAdmit`, and
`canEndSession`. They do not infer authority from role names.

**Permission** is reserved for operating-system and browser device grants and
appears publicly as DevicePermission. It does not name Session authority.

### Moderation

**Moderation** is the capability-gated action set that changes another
Participant's participation. Commands name the exact action:
`muteParticipant`, `removeParticipant`, `admit`, and `deny`.

**RemoveParticipant** ends one Participant's membership. **EndSession** ends the
shared Session. **Ban** is reserved for policy that prevents a later join and is
not a synonym for removal.

## Commands, events, and queries

### Commands

A **Command** requests a state change. Public command methods use an imperative
verb and return only after the request is accepted or rejected. Commands that
may be retried accept or create an idempotency key internally.

Canonical verbs are:

- `join` and `leave` for local membership.
- `set` for an idempotent value assignment.
- `enable` and `disable` for local media capture.
- `select` for device choice.
- `start` and `stop` for an ongoing process.
- `send` for a new communication item.
- `admit`, `deny`, `remove`, and `end` for distinct authority boundaries.

`toggle`, `handle`, `process`, and `do` are not public command verbs.

### Events

An **Event** is an immutable completed fact. Event names and discriminants use
past tense: ParticipantJoined, ParticipantLeft, ScreenShareStarted,
MessageSent, AdmissionDenied, and SessionEnded.

Public event types use `<Subject><PastTenseVerb>Event`. Event payloads include
stable subject identity and occurrence time. Ordering metadata remains an SDK
concern unless consumers need it to reconcile state.

`on(event, listener)` observes discrete facts and returns an unsubscribe
function. `subscribe(listener)` observes Snapshot replacement. Commands, events,
and Snapshots describe the same state machine from different perspectives.

### Queries

A **Query** reads without changing state. Use `get<Noun>` for one known identity,
`list<PluralNoun>` for a collection, and `subscribe` for ongoing observation.
`fetch`, `load`, and `read` are not interchangeable aliases.

## Errors and diagnostics

### ClientError

**ClientError** is the public base error across SDKs. It carries a stable `code`,
a safe human-readable `message`, the originating `operation`, whether the
operation is `retryable`, and an optional `cause`.

Error codes are stable lowercase namespaced strings that describe the condition
rather than transport details, for example `room.not-found`,
`join.token-expired`, `device.permission-denied`, and `connection.lost`.
Consumers match `code`, never `message`.

### Failure and disconnection

A **Failure** is a terminal unsuccessful operation. A **Disconnection** is a
Connection status and may be recoverable. A **Rejection** is an intentional
negative decision, such as denied admission or insufficient permission.

These terms are not interchangeable in errors, events, or UI copy.

Expected lifecycle conclusions are not ClientErrors. Admission denial,
Participant removal, and a host ending the Session are represented by status,
state, and reason-carrying events. ClientError represents an operation that
failed to produce its defined outcome.

### DiagnosticReport

A **DiagnosticReport** is a privacy-safe snapshot and timeline intended for
support. It excludes credentials, raw media, message content, transcript text,
and customer identifiers without redaction.

## Generated and ergonomic client surfaces

Generated HTTP and synchronization artifacts represent transport contracts.
They do not define the ergonomic client vocabulary.

Generated schemas, frames, request bodies, provider configuration, and raw
endpoint groups belong behind an explicit low-level subpath such as
`/generated`. The client package root exports the configured Client,
SessionClient, snapshots, commands, events, domain types, and errors that
application developers intentionally use.

UI packages depend on the ergonomic client surface. They do not import raw
frames, acknowledgements, HTTP path parameters, or generated provider types.

### Client naming map

| Current or transport name     | Canonical ergonomic name                          |
| ----------------------------- | ------------------------------------------------- |
| `createChalkEffectClient`     | `createClient`                                    |
| `ChalkEffectClientOptions`    | `ClientOptions`                                   |
| `ChalkAuth`                   | The exact credential provider or credential type  |
| `RoomSession`                 | `Session`                                         |
| `RoomSessionId`               | `SessionId`                                       |
| generic `Snapshot`            | `SessionSnapshot` when exposed publicly           |
| `RaiseHandCommandFrame`       | transport-only frame for `raiseHand()`            |
| `ParticipantJoinedEventFrame` | transport-only frame for `ParticipantJoinedEvent` |
| `ErrorResponse`               | transport-only response mapped to `ClientError`   |

`Effect`, HTTP, WebSocket, schema-library, and provider names are implementation
details. They do not appear in ergonomic root symbols unless the consumer has
explicitly imported an integration-specific subpath.

## Turnkey lifecycle

### VideoConference

**VideoConference** is the turnkey component that owns the complete embedded
conference experience. It coordinates lifecycle screens, the active conference
view, panels, dialogs, overlays, and the end state.

`VideoConference` is the only component exported from the React package root.
Its future props will be designed from the new runtime contract. Historical
props and types are discarded.

`Conference` is UI-composition language. It does not introduce a parallel
runtime entity such as `ConferenceId` or `ConferenceSession`.

### ConferencePhase

**ConferencePhase** is the exhaustive lifecycle phase rendered by
VideoConference:

- `prejoin` — the local participant configures identity and devices.
- `joining` — the join attempt and transports are being established.
- `waiting` — admission has been requested and a host decision is pending.
- `active` — the ConferenceView and Stage are mounted.
- `reconnecting` — the active view remains mounted while connectivity recovers.
- `ended` — the local conference experience has ended.

`Reconnecting` is represented by an Overlay over the active ConferenceView. It
does not replace the Stage with another lifecycle Screen.

### Lifecycle surfaces

| Component             | Meaning                                                     |
| --------------------- | ----------------------------------------------------------- |
| `PreJoinScreen`       | Full-surface local identity and device setup before joining |
| `JoiningScreen`       | Full-surface progress while a join attempt is established   |
| `WaitingScreen`       | Joiner-facing full-surface wait for admission               |
| `ConferenceView`      | The active in-session composition                           |
| `ReconnectingOverlay` | Recovery state layered over ConferenceView                  |
| `EndScreen`           | Full-surface result after leaving, removal, or Session end  |

The host-facing list currently called `WaitingRoom` becomes `AdmissionPanel`.
The joiner-facing lifecycle surface becomes `WaitingScreen`.

## ConferenceView anatomy

**ConferenceView** is the active composition rendered during the `active` and
`reconnecting` phases.

```text
ConferenceView
├── ConferenceHeader
├── Stage
│   ├── ParticipantGrid
│   ├── ParticipantTile
│   ├── Filmstrip
│   ├── ScreenShareView
│   └── WhiteboardView
├── Sidebar
│   └── Panel
├── ControlBar
├── Overlay
├── ToastStack
└── AudioOutput
```

### Screen

A **Screen** owns a full-surface lifecycle phase outside the active conference.
Screens replace the ConferenceView.

Use Screen for PreJoinScreen, JoiningScreen, and EndScreen. Do not use Screen
for content displayed inside the Stage or Sidebar.

### ConferenceView

A **View** is a substantial presentation region. ConferenceView is the entire
active composition. ScreenShareView and WhiteboardView are content
presentations placed inside the Stage.

View is not a synonym for lifecycle phase, layout, modal surface, or small
component.

### Stage

The **Stage** is the primary content region inside ConferenceView. It arranges
participant media and shared content according to the selected Layout.

There is one Stage. Side-by-side content is expressed through a Layout within
that Stage. `SplitStage` and multiple-stage composition are retired.

### Layout

A **Layout** is the strategy used by Stage to arrange its content:

- `grid` — Participants receive approximately equal visual weight.
- `focus` — one pinned or dominant Participant is primary; others appear in a
  Filmstrip.
- `presentation` — shared content such as a screen share or whiteboard is
  primary; Participants appear in a Filmstrip.

`Spotlight` is renamed `focus`. `Sidebar` is a chrome region, not a participant
layout. `ScreenShare` is content state, not a layout name.

### ParticipantGrid

**ParticipantGrid** arranges ParticipantTiles with approximately equal visual
weight. It replaces `VideoGrid`: a tile may display video, an avatar, or a
fallback, so Participant is the accurate subject.

Stage owns layout selection; ParticipantGrid remains independently composable
through `/components`.

### ParticipantTile

A **ParticipantTile** is the canonical Stage unit for one Participant. It may
contain video, avatar fallback, name, role, and read-only state Indicators.

`VideoTile` is renamed `ParticipantTile`.

### Filmstrip

A **Filmstrip** is an ordered row or column of secondary ParticipantTiles in
focus and presentation layouts. Orientation is a prop rather than a different
component or layout name.

### ScreenShareView

**ScreenShareView** renders one shared-screen source as Stage content.

### WhiteboardView

**WhiteboardView** renders the collaborative whiteboard as Stage content.
`WhiteboardPanel` is retired because the whiteboard is primary Stage content,
not secondary chrome.

## Conference chrome

**Chrome** is the collective UI surrounding Stage content. It is design and
layout vocabulary, not a public component suffix.

### ConferenceHeader

A **Header** is persistent top chrome containing conference identity, elapsed
time, and high-level state. The canonical component is ConferenceHeader.

`MeetingHeader` is renamed `ConferenceHeader`.

### ControlBar

A **ControlBar** is the persistent primary action strip for microphone, camera,
screen share, reactions, panels, and leave.

ControlBar is the semantic component name on every platform. **Dock** describes
a floating placement of ControlBar and is not another component. Responsive
compact or sheet presentation does not create `MobileControlBar` or
`MobileControlSheet`.

Placement and density are separate concerns:

- `placement`: `inline` or `floating`
- `density`: `comfortable` or `compact`

`fixed`, `mobile`, `minimal`, and `dock` are retired as overloaded variants.

### ControlBarButton

A **ControlBarButton** is an action owned by ControlBar. `ControlButton` is
renamed because it is otherwise indistinguishable from a generic IconButton.

### Sidebar

A **Sidebar** is the ConferenceView region adjacent to Stage that hosts a Panel.
The same Panel may be presented as a bottom sheet on a compact viewport without
changing the Panel's public name.

Sidebar is never the secondary strip of participant tiles; that is Filmstrip.

### Panel

A **Panel** is dismissible complementary content that coexists with Stage.
Canonical Panels include:

- `ChatPanel`
- `ParticipantsPanel`
- `TranscriptPanel`
- `AdmissionPanel`
- `SettingsPanel`

`ParticipantList` remains the reusable list inside ParticipantsPanel.
`TranscriptionPanel` becomes TranscriptPanel because the Panel presents a
Transcript; transcription names the process.

### Dialog

A **Dialog** is a modal, focus-managed surface requiring a decision or explicit
dismissal. Canonical Dialogs include SettingsDialog, InviteDialog, and
LeaveDialog.

`Modal` is retired as a component suffix. `InviteModal` becomes InviteDialog,
and `LeaveConfirmationDialog` becomes LeaveDialog.

### Sheet

A **Sheet** is an edge-attached presentation of Panel or Dialog content,
typically on a compact viewport. Responsive adaptation should happen inside the
semantic component. `MobilePanel` and `MobileControlSheet` are retired.

Sheet may be used as a low-level shared primitive; feature components should
not include viewport names.

### Popover

A **Popover** is non-modal rich content anchored to a trigger. It dismisses on
outside interaction or Escape. Device controls may use DevicePopover.

### Menu

A **Menu** is an anchored list of actions. Use Menu for participant actions and
other command lists; use Popover for richer controls or information.

### Overlay

An **Overlay** is a state-driven layer over ConferenceView or Stage. It does not
participate in normal layout. ReconnectingOverlay is the canonical connection
recovery example.

### Banner

A **Banner** is a persistent inline notice that occupies layout space. Use it
for ongoing states that remain visible until resolved or dismissed.

### Toast

A **Toast** is a transient notice that dismisses automatically. **ToastStack**
is the single host for Toasts. `NotificationStack` is renamed ToastStack.

### Picker

A **Picker** selects from a small, known set using a visual choice surface.
Examples include LayoutPicker, ReactionPicker, and BackgroundPicker.

`LayoutSwitcher` becomes LayoutPicker.

### Selector

A **Selector** selects from a dynamic enumerated source. Device inputs use
MicrophoneSelector, CameraSelector, and SpeakerSelector.

### Indicator

An **Indicator** is a non-interactive state signal. Canonical examples include
AudioLevelIndicator, ConnectionQualityIndicator, HandRaiseIndicator,
SpeakingIndicator, and RecordingIndicator.

Indicators never handle the action whose state they display.

### Preview

A **Preview** renders local or provisional content before it becomes live.
Canonical examples include CameraPreview and AudioLevelPreview.

### AudioOutput

**AudioOutput** owns non-visual playback for remote audio. `AudioRenderer` is
retired because Output describes its purpose and Renderer exposes an
implementation detail.

## Component naming map

| Current name                                  | Canonical name                          |
| --------------------------------------------- | --------------------------------------- |
| `NativeVideoConference`                       | `VideoConference`                       |
| `MeetingRoom`, `NativeMeetingRoom`            | `ConferenceView`                        |
| `MeetingHeader`                               | `ConferenceHeader`                      |
| `MeetingHub`                                  | `ConferenceInfoDialog`                  |
| `PreJoinLobby`, `NativePreJoinLobby`          | `PreJoinScreen`                         |
| `LoadingScreen`, `NativeJoiningLoadingScreen` | `JoiningScreen`                         |
| host-facing `WaitingRoom`                     | `AdmissionPanel`                        |
| `EndScreen`, `NativeEndScreen`                | `EndScreen`                             |
| `SplitStage`                                  | Stage with a Layout                     |
| `VideoGrid`                                   | `ParticipantGrid`                       |
| `VideoTile`                                   | `ParticipantTile`                       |
| `Thumbnail`                                   | `ParticipantTile` with `size="compact"` |
| `WhiteboardPanel`                             | `WhiteboardView`                        |
| `ParticipantList` used as a full panel        | `ParticipantsPanel`                     |
| `TranscriptionPanel`                          | `TranscriptPanel`                       |
| `ControlButton`                               | `ControlBarButton`                      |
| `MobilePanel`                                 | responsive Panel presentation           |
| `MobileControlSheet`                          | responsive ControlBar presentation      |
| `InviteModal`                                 | `InviteDialog`                          |
| `LeaveConfirmationDialog`                     | `LeaveDialog`                           |
| `ConnectionLostOverlay`                       | `ReconnectingOverlay`                   |
| `NotificationStack`                           | `ToastStack`                            |
| `AudioRenderer`                               | `AudioOutput`                           |
| `LayoutSwitcher`                              | `LayoutPicker`                          |

## Cross-platform public symbols

Package names provide the platform namespace. Shared public symbols use the same
name on React and React Native:

```ts
import { VideoConference } from "@q9labsai/chalk-react";
import { VideoConference } from "@q9labsai/chalk-react-native";
```

Do not prefix shared public symbols with `Chalk`, `Web`, `Native`, `Mobile`,
`Desktop`, `Ios`, or `Android`. Platform-specific implementation filenames may
use platform extensions without changing the exported symbol.

Use a platform qualifier only when the capability itself is platform-specific,
such as CallKit or Android Connection Service.

## Components, files, and exports

Directories use lowercase kebab-case. The primary public component in a
directory uses a PascalCase filename matching its symbol. Reusable leaves,
helpers, hooks, types, and tests use lowercase kebab-case filenames.

```text
components/
├── stage/
│   └── Stage.tsx
├── participant-grid/
│   └── ParticipantGrid.tsx
├── filmstrip/
│   └── Filmstrip.tsx
├── participant-tile/
│   ├── ParticipantTile.tsx
│   └── speaking-indicator.tsx
├── control-bar/
│   ├── ControlBar.tsx
│   └── control-bar-button.tsx
├── chat-panel/
│   └── ChatPanel.tsx
└── index.ts
```

`/components` uses explicit named exports. It does not export internal helpers,
feature barrels, namespace objects, or wildcard category trees.

Generic design-system primitives such as Button, Card, TextField, Switch, and
Tooltip belong to `packages/ui`. The SDK component catalog owns conference
components rather than a second generic design system.

## Props, events, and hooks

### Props

- Controlled state uses the conventional noun and change callback: `open` with
  `onOpenChange`, `layout` with `onLayoutChange`, and `phase` with
  `onPhaseChange`.
- Boolean state uses adjectives such as `disabled`, `muted`, `pinned`, and
  `active`.
- Feature availability uses `<feature>Enabled`, such as `chatEnabled`.
- Capability props use `can<Action>`, such as `canShareScreen`.
- Slots use a `slots` object or children. `renderHeader`-style callback props are
  reserved for cases that require data-dependent rendering.
- Layout selection always uses `layout`; `mode` and `view` are not synonyms.
- Responsive behavior does not use `isMobile` or platform-specific public props.

### Events and callbacks

- Controlled-state callbacks use `on<Noun>Change`.
- Domain-event callbacks name a completed fact: `onParticipantJoined`,
  `onParticipantLeft`, `onScreenShareStarted`, and `onSessionEnded`.
- Action callbacks use the action directly: `onLeave`, `onAdmit`, `onDeny`, and
  `onSendMessage`.
- Generic `onChange`, `onAction`, and `onEvent` are prohibited when the subject
  is known.
- Event payload types use `<Subject><PastTenseVerb>Event`, such as
  `ParticipantJoinedEvent`.

### Hooks

A hook names the noun or capability it exposes:

- `useRoom`
- `useSession`
- `useSessionClient`
- `useLocalParticipant`
- `useRemoteParticipants`
- `useParticipant`
- `useConnection`
- `useCapabilities`
- `useConferencePhase`
- `useLayout`
- `useMediaDevices`
- `useDevicePermissions`
- `useMicrophone`
- `useCamera`
- `useScreenShare`
- `useChat`
- `useChatMessages`
- `useAppData`
- `useTranscript`
- `useAdmissionRequests`
- `usePendingParticipants`

Package context supplies the active runtime. Repeating `Chalk`, `Native`, or
platform names in shared hooks is prohibited.

## Anti-glossary

| Retired or restricted term                          | Canonical language                         |
| --------------------------------------------------- | ------------------------------------------ |
| Atomic, Composite, Full                             | No public component categories             |
| `Native*`, `Web*`, `Mobile*`, `Desktop*`            | Shared symbol plus platform implementation |
| Meeting or Call in public symbols                   | Conference UI or Session runtime noun      |
| MeetingRoom                                         | ConferenceView                             |
| Hub                                                 | Name the actual Dialog, Panel, or View     |
| Lobby for pre-join setup                            | PreJoinScreen                              |
| WaitingRoom for the joiner lifecycle surface        | WaitingScreen                              |
| WaitingRoom for host admission controls             | AdmissionPanel                             |
| LoadingScreen                                       | JoiningScreen                              |
| Multiple or split Stages                            | One Stage with a Layout                    |
| Spotlight layout                                    | Focus layout                               |
| Sidebar layout or participant sidebar               | Focus layout plus Filmstrip                |
| Screen-share layout                                 | Presentation layout                        |
| VideoGrid                                           | ParticipantGrid                            |
| VideoTile                                           | ParticipantTile                            |
| Generic Thumbnail                                   | ParticipantTile with a compact size        |
| WhiteboardPanel                                     | WhiteboardView                             |
| Dock component                                      | Floating ControlBar placement              |
| Viewport-specific component names                   | Responsive presentation                    |
| Modal suffix                                        | Dialog                                     |
| Notification                                        | Toast or Banner according to persistence   |
| Switcher                                            | Picker                                     |
| Renderer, Manager, Handler, Wrapper, Container      | Name the SDK or UI responsibility          |
| User, Peer, Member, or Client for a roster identity | Participant                                |
| Generic `mode` or `view` layout prop                | `layout`                                   |
| RoomSession                                         | Session                                    |
| Generic `token`, `key`, or `secret`                 | The exact credential, such as JoinToken    |
| WaitingRoom as headless state                       | AdmissionRequest                           |
| Toggle media commands                               | Explicit enable or disable commands        |
| Message when chat is the subject                    | ChatMessage                                |
| Message when application data is the subject        | AppData                                    |
| Disconnect as a synonym for Leave                   | ConnectionStatus or Leave by meaning       |
| Transport errors in ergonomic APIs                  | Stable ClientError code                    |
| State as an enum                                    | Status                                     |
| Permission for Session authority                    | Capability                                 |
| Stream as a public media noun                       | MediaTrack                                 |
| Active speaker                                      | Dominant speaker                           |
