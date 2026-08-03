# Wave 2 prompt — client SDK split

You are executing wave 2 of the Chalk vocabulary-and-boundary restructure.
This prompt is self-contained; assume no other conversation context.

## Mission

Replace the ChalkSession fusion with the ratified SpaceClient
architecture in `@q9labsai/chalk-client`: a framework-agnostic core that
React and React Native only ever see through one snapshot store.

## Read first (binding, not open for redesign)

- `GLOSSARY.md` — vocabulary, SpaceClient and AccessGrant entries.
- `scratchpad/client-sdk-split-design-2026-08-03.md` — the architecture
  this wave implements.
- `scratchpad/public-surface-design-2026-08-03.md` — the full public
  surface: every method, slice, and death is enumerated there.

## Blocked on (verify before starting)

- Wave 1 merged (this wave consumes the renamed contract; the wire
  already says AccessGrant, space, episode).

Version is ruled: bump every `@q9labsai/*` package to `4.0.0` in this
wave. Do NOT publish to npm — publishing is a separate manual step after
wave 4 and Hasan's verification pass.

## Scope

SpaceClient (public, Promise-based; Effect-native entry also exported):

- Flat lifecycle: `join({ displayName?, microphone?, camera? })`,
  `leave`, `subscribe`, `getSnapshot`, `endEpisode`, `extendEpisode`,
  plus a typed `client.on(...)` emitter.
- Namespaced controllers, exactly these five: `media` (set/select
  devices, screen share, accept/declineRequest), `chat` (send,
  loadOlder, markRead, `chat.files.upload/url`), `participants`
  (assignRole, mute, stopVideo, stopScreenShare, requestMedia, remove,
  admit, deny, raiseHand, lowerHand, renameSelf), `reactions` (send),
  `whiteboard` (transport()). Controllers NEVER call each other — they
  talk to the store, the Connection, or their own domain only.

Connection (internal):

- Owns the state machine, epoch, recovery, and the access loop.
- R1 access-refresh requirement, in full: scheduled refresh before
  expiry; revalidation on wake/foreground; refresh-once-retry-once on
  auth rejection; silent re-fetch while in the Entrance. This exists
  because production joins failed on stale grants — do not weaken it.

Access:

- `getAccess(ctx: { space, reason: "join" | "refresh" | "retry" })
=> Promise<AccessGrant>` is the entire integration seam. AccessGrant
  is opaque: customers never construct or inspect it. The server-SDK
  subpath (`src/server/`) mints it and adopts the AccessGrant name from
  the wave-1 wire contract.

Store:

- One SpaceSnapshot store with per-slice referential stability; slices:
  connection, self, participants, media, chat, reactions, whiteboard.
- Capabilities live in the snapshot; `can(capability)` helper on the
  self slice answers "may I" — UI never infers authority from roles.

Vocabulary and structure:

- endSession→endEpisode; transferHost + setParticipantRole→assignRole;
  participantSessionId→participantId; error codes `noun.condition`.
- The media-plane contract moves out of the sync types into its own
  neutral contract module.
- Effect-TS core per the design sheet; Promise surface public.

React/React Native — mechanical rebinding ONLY:

- The minimal edits to hooks/providers so both packages compile and
  their tests pass against SpaceClient. The component redesign
  (`<Chalk />`, Entrance, store-bound hooks) is wave 3 — do not start it.

## Definition of done

- Commit gate green; client + react + react-native typecheck, tests,
  builds, publint, and attw all pass.
- Ratchet counts fall for the client surface; lock with
  `pnpm run language:ratchet:update`, baseline staged in the same commit.
- `ChalkSession` and `ParticipantAccess` no longer exist in
  `@q9labsai/chalk-client`.

## Environment notes

- Before typechecks or the gate, build the library chain sequentially or
  `packages/ui` fails on missing dists:
  `pnpm --filter '@q9labsai/chalk-assets...' --filter '@q9labsai/facehash...' --filter '@q9labsai/chalk-ui...' --filter '@q9labsai/chalk-whiteboard...' --filter '@q9labsai/chalk-client...' --filter '@q9labsai/chalk-react...' --filter '@q9labsai/chalk-react-native...' --workspace-concurrency=1 run build`
- Keep `--workspace-concurrency=1` on workspace-wide builds.
- `pnpm run gate -- --full` is red for pre-existing, unrelated reasons;
  the per-commit gate is the standard.
- Keep `.worktrees/` clean; gate vitest filters match stale copies.
