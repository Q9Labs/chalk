import { Clock, Context, Data, Deferred, Effect, Layer, SynchronizedRef } from "effect";
import type { ParsedAccessGrant, ParticipantMediaCredential, ParticipantSyncCredential } from "./grant";
import type { ConnectionAccessReason, ConnectionAccessRequest } from "../connection/dependencies";
const DEFAULT_REFRESH_WINDOW_MS = 60000;
const ACCESS_PROVIDER_TIMEOUT_MS = 7000;
export class ConnectionAccessFailure extends Data.TaggedError("ConnectionAccessFailure")<{
  readonly code: "access.invalid" | "access.unavailable";
  readonly cause: unknown;
}> {}
class MediaReplacementPending extends Data.TaggedError("MediaReplacementPending")<{ readonly done: Deferred.Deferred<void, ConnectionAccessFailure> }> {}
export type ConnectionAccessEffectProvider = (request: ConnectionAccessRequest) => Effect.Effect<ParsedAccessGrant, ConnectionAccessFailure>;
export type AutomaticMediaReplacementListener = (access: ParsedAccessGrant) => void;
export type ConnectionAccessEffectService = {
  readonly current: Effect.Effect<ParsedAccessGrant | null>;
  readonly currentUnsafe: () => ParsedAccessGrant | null;
  readonly initialize: (reason?: "join" | "access_retry") => Effect.Effect<ParsedAccessGrant, ConnectionAccessFailure>;
  readonly ensureFresh: (reason?: ConnectionAccessReason) => Effect.Effect<ParsedAccessGrant, ConnectionAccessFailure>;
  readonly refresh: (reason: Exclude<ConnectionAccessReason, "join">, replaceMediaConnection: boolean) => Effect.Effect<ParsedAccessGrant, ConnectionAccessFailure>;
  readonly refreshAfterRejection: () => Effect.Effect<ParsedAccessGrant, ConnectionAccessFailure>;
  readonly getSyncToken: (reason?: ConnectionAccessReason) => Effect.Effect<ParticipantSyncCredential, ConnectionAccessFailure>;
  readonly getMediaToken: () => Effect.Effect<ParticipantMediaCredential, ConnectionAccessFailure>;
  readonly subscribeAutomaticMediaReplacement: (listener: AutomaticMediaReplacementListener) => Effect.Effect<() => void>;
  readonly requiresRefresh: Effect.Effect<boolean>;
  readonly millisecondsUntilRefresh: Effect.Effect<number | null>;
  readonly holdMediaBinding: (binding: string) => Effect.Effect<Effect.Effect<void>>;
  readonly clear: Effect.Effect<void>;
};
export class ConnectionAccessService extends Context.Service<ConnectionAccessService, ConnectionAccessEffectService>()("@chalk/client/ConnectionAccess") {}
type AccessState = {
  readonly access: ParsedAccessGrant | null;
};
type FetchResult = {
  readonly access: ParsedAccessGrant;
  readonly automaticMediaReplacement: boolean;
};
type FetchInput = {
  readonly current: AccessState;
  readonly reason: ConnectionAccessReason;
  readonly replaceMediaConnection: boolean;
  readonly force: boolean;
  readonly refreshWindowMs: number;
  readonly replacementGate: () => Deferred.Deferred<void, ConnectionAccessFailure> | undefined;
};
/**
 * The sole R1 owner. SynchronizedRef keeps a refresh and its state commit
 * indivisible, while Clock keeps expiry decisions deterministic in tests.
 */
export const makeConnectionAccessLayer = (provider: ConnectionAccessEffectProvider, refreshWindowMs = DEFAULT_REFRESH_WINDOW_MS) =>
  Layer.effect(
    ConnectionAccessService,
    Effect.gen(function* () {
      const state = yield* SynchronizedRef.make<AccessState>({ access: null });
      const holds = new Map<string, { count: number; done: Deferred.Deferred<void, ConnectionAccessFailure> }>();
      const replacementGate = () => {
        const binding = SynchronizedRef.getUnsafe(state).access?.media.clientPayload.connectionId;
        return binding ? holds.get(binding)?.done : undefined;
      };
      const holdMediaBinding = (binding: string) =>
        Effect.gen(function* () {
          const hold = holds.get(binding) ?? { count: 0, done: yield* Deferred.make<void, ConnectionAccessFailure>() };
          hold.count++;
          holds.set(binding, hold);
          return Effect.gen(function* () {
            if (--hold.count !== 0) return;
            holds.delete(binding);
            yield* Deferred.succeed(hold.done, undefined);
          });
        });
      const automaticMediaReplacementListeners = new Set<AutomaticMediaReplacementListener>();
      const fetch = (reason: ConnectionAccessReason, replaceMediaConnection: boolean, force: boolean): Effect.Effect<ParsedAccessGrant, ConnectionAccessFailure> =>
        SynchronizedRef.modifyEffect(state, (current) => fetchAccessGrant(provider, { current, reason, replaceMediaConnection, force, refreshWindowMs, replacementGate })).pipe(
          Effect.catchTag("MediaReplacementPending", ({ done }) =>
            Deferred.await(done).pipe(
              Effect.flatMap(() => fetch(reason, replaceMediaConnection, force)),
              Effect.map((access) => ({ access, automaticMediaReplacement: false })),
            ),
          ),
          Effect.tap((result: FetchResult) => Effect.sync(() => notifyAutomaticMediaReplacement(automaticMediaReplacementListeners, result))),
          Effect.map((result: FetchResult) => result.access),
        );
      const initialize = (reason: "join" | "access_retry" = "join") =>
        fetch(reason, false, false).pipe(Effect.catchTag("ConnectionAccessFailure", (failure) => (failure.code === "access.invalid" && SynchronizedRef.getUnsafe(state).access === null ? fetch(reason, false, true) : Effect.fail(failure))));
      const millisecondsUntilRefresh = Effect.gen(function* () {
        const access = yield* SynchronizedRef.get(state);
        if (!access.access) return null;
        return millisecondsUntil(access.access, yield* Clock.currentTimeMillis, refreshWindowMs);
      });
      const ensureFresh = (reason: ConnectionAccessReason = "scheduled_refresh") => fetch(reason, false, false);
      return {
        current: SynchronizedRef.get(state).pipe(Effect.map((value) => value.access)),
        currentUnsafe: () => SynchronizedRef.getUnsafe(state).access,
        initialize,
        ensureFresh,
        refresh: (reason, replaceMediaConnection) => fetch(reason, replaceMediaConnection, true),
        refreshAfterRejection: () => fetch("access_retry", true, true),
        getSyncToken: (reason = "sync_recovery") => ensureFresh(reason).pipe(Effect.map((access) => access.sync.token)),
        getMediaToken: () => ensureFresh("scheduled_refresh").pipe(Effect.map((access) => access.media.token)),
        subscribeAutomaticMediaReplacement: (listener) =>
          Effect.sync(() => {
            automaticMediaReplacementListeners.add(listener);
            return () => automaticMediaReplacementListeners.delete(listener);
          }),
        requiresRefresh: millisecondsUntilRefresh.pipe(Effect.map((milliseconds) => milliseconds === null || milliseconds === 0)),
        millisecondsUntilRefresh,
        holdMediaBinding,
        clear: Effect.gen(function* () {
          yield* SynchronizedRef.set(state, { access: null });
          for (const hold of holds.values()) yield* Deferred.fail(hold.done, new ConnectionAccessFailure({ code: "access.unavailable", cause: "Connection closed during media rejection classification" }));
          holds.clear();
        }),
      } satisfies ConnectionAccessEffectService;
    }),
  );
export const makeFakeConnectionAccessLayer = makeConnectionAccessLayer;
function fetchAccessGrant(provider: ConnectionAccessEffectProvider, input: FetchInput) {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const currentAccess = input.current.access;
    if (canReuseAccess(input, now) && currentAccess) {
      return [{ access: currentAccess, automaticMediaReplacement: false }, input.current] as const;
    }
    const gate = input.replacementGate();
    const shouldReplaceMediaConnection = mediaReplacementRequested(input, now, Boolean(gate));
    if (shouldReplaceMediaConnection && gate) return yield* Effect.fail(new MediaReplacementPending({ done: gate }));
    const next = yield* provider(connectionAccessRequest(input, shouldReplaceMediaConnection)).pipe(
      Effect.timeout(ACCESS_PROVIDER_TIMEOUT_MS),
      Effect.mapError((cause) => (cause instanceof ConnectionAccessFailure ? cause : new ConnectionAccessFailure({ code: "access.unavailable", cause }))),
    );
    yield* Effect.try({
      try: () => {
        validateFetchedAccess(currentAccess, next, now, shouldReplaceMediaConnection);
        validateHeldBinding(input, next);
      },
      catch: (cause) => new ConnectionAccessFailure({ code: "access.invalid", cause }),
    });
    return [{ access: next, automaticMediaReplacement: currentAccess !== null && !input.replaceMediaConnection && !hasSameMediaConnection(currentAccess, next) }, { access: next }] as const;
  });
}
function connectionAccessRequest(input: FetchInput, replaceMediaConnection: boolean): Readonly<ConnectionAccessRequest> {
  return Object.freeze({
    reason: input.reason,
    replaceMediaConnection,
    ...(input.current.access
      ? {
          currentMediaToken: input.current.access.media.token,
          expectedParticipantGeneration: input.current.access.subject.participantGeneration,
          ...(replaceMediaConnection && input.reason !== "access_retry" ? { expectedMediaConnectionId: input.current.access.media.clientPayload.connectionId } : {}),
        }
      : {}),
  });
}
function validateFetchedAccess(previous: ParsedAccessGrant | null, next: ParsedAccessGrant, now: number, replaceMediaConnection: boolean): void {
  validateExpiration(next, now);
  if (previous) validateRefresh(previous, next, replaceMediaConnection);
}
function notifyAutomaticMediaReplacement(listeners: ReadonlySet<AutomaticMediaReplacementListener>, result: FetchResult): void {
  if (!result.automaticMediaReplacement) return;
  for (const listener of listeners) {
    try {
      listener(result.access);
    } catch {
      // Observers cannot roll back a committed access replacement.
    }
  }
}
function millisecondsUntil(access: ParsedAccessGrant, now: number, refreshWindowMs: number): number {
  return Math.max(0, Math.min(expiresAt(access.sync.expiresAt), expiresAt(access.media.expiresAt)) - now - refreshWindowMs);
}
function validateExpiration(access: ParsedAccessGrant, now: number): void {
  if (expiresAt(access.sync.expiresAt) <= now || expiresAt(access.media.expiresAt) <= now) throw new TypeError("Access grant is expired");
}
function validateRefresh(previous: ParsedAccessGrant, next: ParsedAccessGrant, replaceMediaConnection: boolean): void {
  if (!hasSameSubject(previous, next)) throw new TypeError("Access grant refresh changed its subject");
  if (replaceMediaConnection && hasSameMediaConnection(previous, next)) throw new TypeError("Access grant replacement did not change its media binding");
}
function hasSameMediaConnection(previous: ParsedAccessGrant, next: ParsedAccessGrant): boolean {
  return previous.media.provider === next.media.provider && mediaBinding(previous) === mediaBinding(next);
}
function hasSameSubject(previous: ParsedAccessGrant, next: ParsedAccessGrant): boolean {
  const left = previous.subject;
  const right = next.subject;
  return left.tenantId === right.tenantId && left.spaceId === right.spaceId && left.episodeId === right.episodeId && left.participantId === right.participantId && left.participantGeneration === right.participantGeneration;
}
function mediaBinding(access: ParsedAccessGrant): string {
  switch (access.media.provider) {
    case "cloudflare_sfu":
      return access.media.clientPayload.connectionId;
  }
}
function expiresAt(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("Access grant expiration is invalid");
  return timestamp;
}

function canReuseAccess(input: FetchInput, now: number): boolean {
  return !input.force && input.current.access !== null && millisecondsUntil(input.current.access, now, input.refreshWindowMs) > 0;
}

function mediaReplacementRequested(input: FetchInput, now: number, held: boolean): boolean {
  const current = input.current.access;
  return input.replaceMediaConnection || (current !== null && expiresAt(current.media.expiresAt) <= now && !held);
}

function validateHeldBinding(input: FetchInput, next: ParsedAccessGrant): void {
  const previous = input.current.access;
  if (input.replacementGate() && previous && !hasSameMediaConnection(previous, next)) throw new TypeError("Cannot replace a rejected media binding before classification");
}
