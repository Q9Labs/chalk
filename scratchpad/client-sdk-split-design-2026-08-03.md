# Client SDK split design — client wave — 2026-08-03

Co-design sheet for the ratified ChalkSession split (option A, locked:
narrow connection coordinator + feature controllers behind one UI-facing
store). Grounded in `sdks/typescript/client/src/session/chalk-session.ts`
(1,464 lines) and `session/dependencies.ts` at master. Sections marked
**DECIDE** are being ruled live with Hasan.

## Code reality: seven jobs in one class

`ChalkSession` today:

1. **Lifecycle state machine** (~330 lines): idle/joining/live/
   reconnecting/leaving/left/failed, epoch fencing, join orchestration
   (acquire media → access → create media client → create sync client →
   parallel start with join-trace spans), teardown with durable-leave
   confirmation.
2. **Recovery engine** (~200 lines): budget/attempt loops for sync and
   media, watchdog timers, scheduled access refresh.
3. **Media command surface** (~250 lines): local track ownership,
   per-source serialized command tails, mic/camera/screen enablement,
   permission-denied mapping.
4. **Chat store** (~400 lines): messages, pending sends, read receipts,
   pagination, cursor-reset handling, the catch-up loop, input validation.
5. **Reactions + incoming media requests** (~120 lines): expiring-timer
   bookkeeping for both.
6. **Moderation/roster forwarding**: fifteen one-line forwards to the sync
   client (roles, admission, mute-others, remove, endSession…).
7. **Snapshot projection + publish** fan-out.

The forwarding disease, concretely: adding one command today means a sync
client method + a hand-copied method on the `ChalkSessionSyncClient`
structural type in dependencies.ts + a ChalkSession forward + a snapshot
projection change + a React hook mirror + an RN hook mirror. The media
contract leaks: `ChalkSessionMediaClient extends V3ClientMediaPlane` from
`sync/v3-types.ts`, so media types are owned by the sync module.

## Target shape

- **`SpaceClient`** — the public object (client SDK entry). Lifecycle stays
  flat on it: `join()`, `leave()`, `subscribe()`, `getSnapshot()`,
  diagnostics. Features hang off named controllers: `.media`, `.chat`,
  `.participants`, `.reactions`, `.whiteboard`, `.files`.
- **`Connection`** (internal coordinator) — jobs 1+2 only: state machine,
  epoch, join orchestration, recovery, access refresh, teardown. Zero
  feature knowledge. Exposes to controllers: the live sync/media ports, a
  command gate (`requireLive()` + epoch assertion), and lifecycle events.
- **Controllers** — each owns its state slice and its commands, subscribes
  to its own upstream events, and writes its slice to the store. A new
  command = one method on one controller + its slice. Nothing else moves.
- **`SpaceStore`** — one store, one immutable snapshot assembled from
  slices, `subscribe/getSnapshot` compatible with `useSyncExternalStore`.
  Hooks in React/RN become selectors over this store — the mirror layers
  die (their cure, recorded for the React wave).
- **Command port** — controllers call the sync client's own exported
  interface; dependencies.ts stops re-declaring every command structurally.
- **Media contract extraction** — a neutral `media/plane.ts` owns the media
  plane contract; sync imports it, never the reverse.

## DECIDE (live, with Hasan)

1. **Public command grammar**: namespaced (`client.chat.send(…)`,
   `client.media.setMicrophoneEnabled(…)`) vs today's flat surface
   (`session.sendChatMessage(…)`). Rec: namespaced; lifecycle stays flat.
2. **Piece names** (glossary grammar, no Chalk prefix): `SpaceClient`
   public entry; `Connection` internal coordinator; `SpaceSnapshot` with
   slices `connection`, `self`, `participants`, `media`, `chat`,
   `reactions`, `whiteboard`; controllers `MediaController`,
   `ChatController`, `ParticipantsController`, `ReactionsController`,
   `WhiteboardController`.
3. **Controller set boundaries**: reactions as their own tiny controller
   (not folded into chat); incoming media requests (request-unmute /
   request-camera) live in `MediaController`; roster + moderation +
   admission together in `ParticipantsController`. Hand-raise and
   rename-self are participant actions → `ParticipantsController`.
4. **Snapshot contract**: one snapshot document with per-slice referential
   stability (a chat event must not re-create the media slice), so React
   selectors get cheap equality.
5. **Error codes**: move to glossary `noun.condition` grammar
   (`episode.ended`, `access.invalid`, `chat.payload_invalid`) in this
   wave, since it is already a breaking wave — vs keeping today's flat
   codes (`session_ended`, `invalid_access`) and renaming later. Rec:
   adopt the grammar now; never touch the surface twice.
6. **Vocabulary mapping** (mechanical once ruled): ChalkSession →
   SpaceClient; endSession → endEpisode; transferHost + setParticipantRole
   → assignRole; participantSessionId → participantId; "room actions" as a
   concept dissolves into the controllers that own each action.

## Rulings landed live (Hasan, 2026-08-03 night)

- **D1 ruled: namespaced command grammar.** **D5 ruled: adopt
  `noun.condition` error codes in this wave.** **D6 ruled: vocabulary
  mapping approved.** Controller set confirmed by Hasan (media, chat,
  participants, reactions, whiteboard); chat-file transport folds under
  chat (`client.chat.files`), not a sixth controller.
- **R1 (new requirement, from Hasan's production pain): access refresh
  must survive real conditions.** Today's client HAS automatic refresh
  but it is timer-shaped and fail-hard: a scheduled timer fires at
  expiry−60s (only while `live`), `getSyncToken`/`getMediaToken` refresh
  lazily inside the refresh window, and recovery refreshes explicitly.
  Gaps that bite: background tabs / backgrounded RN apps throttle timers
  so expiry passes silently; there is NO reactive refresh — an auth
  rejection (`invalid_access` subject mismatch) fails the whole session
  instead of refreshing once and retrying; pre-join access that expires
  before `join()` throws instead of re-fetching. The rebuilt Connection
  owns access as a first-class loop: (a) keep the scheduled refresh,
  (b) revalidate freshness on wake/foreground (visibilitychange /
  AppState) and before every command, (c) on ANY port rejecting with
  `access.invalid`: refresh once, retry once, only then surface failure,
  (d) stale access at join → silent re-fetch, never a user-facing error.
- **Controller communication law**: controllers never call each other.
  Three channels only: read sibling state from the store snapshot;
  everything shared (ports, command gate, lifecycle events, access)
  flows through Connection; a cross-feature action belongs wholly to the
  controller that owns its outcome (accept-unmute lives entirely in
  media). If a future action truly spans controllers it composes
  top-down in SpaceClient — sideways calls stay banned.
- **D7 (pending Hasan confirmation): Effect-TS placement.** Read of
  Hasan's instruction: the rebuilt core is written in Effect (join,
  recovery, serialized commands as Effect programs; tagged errors
  carrying the `noun.condition` codes; interruption replacing hand-rolled
  epoch plumbing where it can do so without changing semantics), while
  the public SDK surface stays Promise-based for customers, with an
  Effect-native entry exported for Effect users (today's `src/effect.ts`
  precedent). React/RN consume the store, not Effect.

## Execution notes (for the wave worker, after ratification)

Depends on the contract wave's regenerated types (spaces/episodes wire
surface). Strict scope: split + rename inside the client SDK only; no
behavior changes to recovery/lifecycle semantics (the state machine,
epoch fencing, and durable-leave logic move verbatim); React/RN adaptation
is the following wave. The 325-test client suite is the safety net and
gets reorganized per controller.
