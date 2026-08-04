import { Clock, Context, Data, Effect, Layer, SynchronizedRef } from "effect";
import type { ParsedAccessGrant, ParticipantMediaCredential, ParticipantSyncCredential } from "./access-grant";
import type { ConnectionAccessReason, ConnectionAccessRequest } from "./dependencies";

const DEFAULT_REFRESH_WINDOW_MS = 60_000;

export class ConnectionAccessFailure extends Data.TaggedError("ConnectionAccessFailure")<{
  readonly code: "access.invalid" | "access.unavailable";
  readonly cause: unknown;
}> {}

export type ConnectionAccessEffectProvider = (request: ConnectionAccessRequest) => Effect.Effect<ParsedAccessGrant, ConnectionAccessFailure>;

export type ConnectionAccessEffectService = {
  readonly current: Effect.Effect<ParsedAccessGrant | null>;
  readonly currentUnsafe: () => ParsedAccessGrant | null;
  readonly initialize: (reason?: "join" | "access_retry") => Effect.Effect<ParsedAccessGrant, ConnectionAccessFailure>;
  readonly ensureFresh: (reason?: ConnectionAccessReason) => Effect.Effect<ParsedAccessGrant, ConnectionAccessFailure>;
  readonly refresh: (reason: Exclude<ConnectionAccessReason, "join">, replaceMediaConnection: boolean) => Effect.Effect<ParsedAccessGrant, ConnectionAccessFailure>;
  readonly refreshAfterRejection: () => Effect.Effect<ParsedAccessGrant, ConnectionAccessFailure>;
  readonly getSyncToken: (reason?: ConnectionAccessReason) => Effect.Effect<ParticipantSyncCredential, ConnectionAccessFailure>;
  readonly getMediaToken: () => Effect.Effect<ParticipantMediaCredential, ConnectionAccessFailure>;
  readonly requiresRefresh: Effect.Effect<boolean>;
  readonly millisecondsUntilRefresh: Effect.Effect<number | null>;
  readonly clear: Effect.Effect<void>;
};

export class ConnectionAccessService extends Context.Service<ConnectionAccessService, ConnectionAccessEffectService>()("@chalk/client/ConnectionAccess") {}

type AccessState = { readonly access: ParsedAccessGrant | null };

/**
 * The sole R1 owner. SynchronizedRef keeps a refresh and its state commit
 * indivisible, while Clock keeps expiry decisions deterministic in tests.
 */
export const makeConnectionAccessLayer = (provider: ConnectionAccessEffectProvider, refreshWindowMs = DEFAULT_REFRESH_WINDOW_MS) =>
  Layer.effect(
    ConnectionAccessService,
    Effect.gen(function* () {
      const state = yield* SynchronizedRef.make<AccessState>({ access: null });
      const fetch = (reason: ConnectionAccessReason, replaceMediaConnection: boolean, force: boolean): Effect.Effect<ParsedAccessGrant, ConnectionAccessFailure> =>
        SynchronizedRef.modifyEffect(state, (current) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (!force && current.access && millisecondsUntil(current.access, now, refreshWindowMs) > 0) return [current.access, current] as const;
            const request = Object.freeze({
              reason,
              replaceMediaConnection,
              ...(current.access
                ? {
                    currentMediaToken: current.access.media.token,
                    expectedParticipantGeneration: current.access.subject.participantGeneration,
                  }
                : {}),
            });
            const next = yield* provider(request);
            try {
              validateExpiration(next, now);
              if (current.access) validateRefresh(current.access, next, replaceMediaConnection);
            } catch (cause) {
              return yield* Effect.fail(new ConnectionAccessFailure({ code: "access.invalid", cause }));
            }
            return [next, { access: next }] as const;
          }),
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
        refreshAfterRejection: () => fetch("access_retry", false, true),
        getSyncToken: (reason = "sync_recovery") => ensureFresh(reason).pipe(Effect.map((access) => access.sync.token)),
        getMediaToken: () => ensureFresh("scheduled_refresh").pipe(Effect.map((access) => access.media.token)),
        requiresRefresh: millisecondsUntilRefresh.pipe(Effect.map((milliseconds) => milliseconds === null || milliseconds === 0)),
        millisecondsUntilRefresh,
        clear: SynchronizedRef.set(state, { access: null }),
      } satisfies ConnectionAccessEffectService;
    }),
  );

export const makeFakeConnectionAccessLayer = makeConnectionAccessLayer;

function millisecondsUntil(access: ParsedAccessGrant, now: number, refreshWindowMs: number): number {
  return Math.max(0, Math.min(expiresAt(access.sync.expiresAt), expiresAt(access.media.expiresAt)) - now - refreshWindowMs);
}

function validateExpiration(access: ParsedAccessGrant, now: number): void {
  if (expiresAt(access.sync.expiresAt) <= now || expiresAt(access.media.expiresAt) <= now) throw new TypeError("Access grant is expired");
}

function validateRefresh(previous: ParsedAccessGrant, next: ParsedAccessGrant, replaceMediaConnection: boolean): void {
  const left = previous.subject;
  const right = next.subject;
  if (left.tenantId !== right.tenantId || left.spaceId !== right.spaceId || left.episodeId !== right.episodeId || left.participantId !== right.participantId || left.participantGeneration !== right.participantGeneration) {
    throw new TypeError("Access grant refresh changed its subject");
  }
  if (!replaceMediaConnection && previous.media.clientPayload.connectionId !== next.media.clientPayload.connectionId) throw new TypeError("Access grant refresh unexpectedly replaced its media connection");
}

function expiresAt(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("Access grant expiration is invalid");
  return timestamp;
}
