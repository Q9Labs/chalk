/**
 * Effect-based Token Service for Chalk SDK
 *
 * Provides serialized token refresh with Semaphore and exponential backoff retry.
 * Replaces manual isRefreshingToken/refreshPromise pattern.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect
 */

import { Effect, Layer, Ref, Schedule, pipe } from "effect";
import { TokenService, LoggerService } from "./services";
import { AuthError } from "./errors";
import type { TokenProvider } from "../types";

/**
 * Retry schedule for token refresh
 * - Exponential backoff starting at 500ms
 * - Max 3 attempts
 * - Jitter for distributed retry
 */
const refreshRetrySchedule = pipe(
  Schedule.exponential("500 millis"),
  Schedule.jittered,
  Schedule.compose(Schedule.recurs(3))
);

/**
 * Create TokenService live implementation
 *
 * Uses Semaphore to serialize concurrent refresh requests.
 */
export const makeTokenServiceLive = (
  initialToken?: string,
  tokenProvider?: TokenProvider
) =>
  Layer.effect(
    TokenService,
    Effect.gen(function* () {
      const tokenRef = yield* Ref.make<string | undefined>(initialToken);
      // Semaphore with 1 permit = mutex for serializing refresh
      const refreshSemaphore = yield* Effect.makeSemaphore(1);
      const logger = yield* LoggerService;

      const refreshCore = Effect.gen(function* () {
        if (!tokenProvider) {
          return yield* Effect.fail(
            new AuthError({
              code: "TOKEN_REFRESH_FAILED",
              message: "No token provider configured",
              recoverable: false,
            })
          );
        }

        yield* logger.debug("Refreshing token");

        const newToken = yield* pipe(
          Effect.tryPromise({
            try: () => tokenProvider(),
            catch: (error) =>
              new AuthError({
                code: "TOKEN_REFRESH_FAILED",
                message: error instanceof Error ? error.message : "Token provider failed",
                recoverable: true,
                cause: error,
              }),
          }),
          Effect.retry(refreshRetrySchedule),
          Effect.tapError((e) => logger.error("Token refresh failed", { error: e.message }))
        );

        if (!newToken) {
          return yield* Effect.fail(
            new AuthError({
              code: "TOKEN_REFRESH_FAILED",
              message: "Token provider returned empty token",
              recoverable: false,
            })
          );
        }

        yield* Ref.set(tokenRef, newToken);
        yield* logger.debug("Token refreshed successfully");

        return newToken;
      });

      // Wrap refresh with semaphore permit
      const refresh = refreshSemaphore.withPermits(1)(refreshCore);

      return {
        get: Ref.get(tokenRef),
        set: (token: string) => Ref.set(tokenRef, token),
        refresh,
        clear: Ref.set(tokenRef, undefined),
      };
    })
  );

/**
 * Effect for refreshing token and retrying a request
 *
 * This effect:
 * 1. Attempts to refresh the token (serialized via semaphore)
 * 2. If successful, runs the retry effect
 * 3. If refresh fails, returns the failure
 */
export const refreshAndRetry = <A, E>(
  retryEffect: Effect.Effect<A, E, TokenService>
) =>
  Effect.gen(function* () {
    const tokenService = yield* TokenService;
    yield* tokenService.refresh;
    return yield* retryEffect;
  });

/**
 * Create a standalone token manager (for use outside Effect runtime)
 *
 * This provides a Promise-based interface for token management.
 * Uses promise-based serialization for environments not using Effect runtime.
 */
export const createTokenManager = (initialToken?: string, tokenProvider?: TokenProvider) => {
  let currentToken = initialToken;
  let isRefreshing = false;
  let refreshPromise: Promise<string | null> | null = null;

  return {
    get: () => currentToken,

    set: (token: string) => {
      currentToken = token;
    },

    clear: () => {
      currentToken = undefined;
    },

    /**
     * Refresh token with serialization
     * Multiple concurrent calls will share the same refresh operation
     */
    refresh: async (): Promise<string | null> => {
      if (!tokenProvider) {
        return null;
      }

      // If already refreshing, return the existing promise (serialization)
      if (isRefreshing && refreshPromise) {
        return refreshPromise;
      }

      isRefreshing = true;
      refreshPromise = (async () => {
        try {
          const newToken = await tokenProvider();
          if (newToken) {
            currentToken = newToken;
            return newToken;
          }
          return null;
        } catch {
          return null;
        } finally {
          isRefreshing = false;
          refreshPromise = null;
        }
      })();

      return refreshPromise;
    },

    hasProvider: () => !!tokenProvider,
  };
};

export type TokenManager = ReturnType<typeof createTokenManager>;
