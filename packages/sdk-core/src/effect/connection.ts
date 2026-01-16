/**
 * Effect-based Connection Management for Chalk SDK
 *
 * Provides scoped resources with automatic cleanup using acquireRelease.
 * Replaces manual cleanup patterns in client.ts and room.ts.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect
 */

import { Effect, Scope, pipe, Deferred, Option } from "effect";
import type RealtimeKitClient from "@cloudflare/realtimekit";
import { ConnectionError, TimeoutError } from "./errors";
import { LoggerService } from "./services";

/**
 * RTK connection options
 */
export interface RTKConnectionOptions {
  authToken: string;
  audio?: boolean;
  video?: boolean;
}

/**
 * WebSocket connection options
 */
export interface WSConnectionOptions {
  url: string;
  token: string;
  roomId: string;
}

/**
 * Connect to RealtimeKit with automatic cleanup
 *
 * Uses acquireRelease pattern:
 * - Acquire: Initialize RTK client
 * - Release: Leave and cleanup RTK connection
 */
export const connectRealtimeKit = (options: RTKConnectionOptions) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const logger = yield* LoggerService;
      yield* logger.debug("Initializing RealtimeKit", { hasToken: !!options.authToken });

      // Dynamic import to handle browser/SSR
      const { default: RTK } = yield* Effect.tryPromise({
        try: () => import("@cloudflare/realtimekit"),
        catch: (error) =>
          new ConnectionError({
            code: "CONNECTION_FAILED",
            message: "Failed to load RealtimeKit module",
            recoverable: false,
            cause: error,
          }),
      });

      const client = yield* Effect.tryPromise({
        try: () =>
          RTK.init({
            authToken: options.authToken,
            defaults: {
              audio: options.audio ?? false,
              video: options.video ?? false,
            },
          }),
        catch: (error) =>
          new ConnectionError({
            code: "CONNECTION_FAILED",
            message: error instanceof Error ? error.message : "RealtimeKit init failed",
            recoverable: true,
            cause: error,
          }),
      });

      if (!client) {
        return yield* Effect.fail(
          new ConnectionError({
            code: "CONNECTION_FAILED",
            message: "RealtimeKit init returned null client",
            recoverable: false,
          })
        );
      }

      yield* logger.debug("RealtimeKit initialized");
      return client as RealtimeKitClient;
    }),
    (client) =>
      Effect.gen(function* () {
        const logger = yield* LoggerService;
        yield* logger.debug("Cleaning up RealtimeKit connection");
        yield* Effect.tryPromise({
          try: () => client.leave(),
          catch: () => undefined, // Ignore cleanup errors
        });
      }).pipe(Effect.ignore)
  );

/**
 * Join RTK room with timeout
 *
 * Wraps rtkClient.join() with configurable timeout
 */
export const joinRTKRoom = (
  client: RealtimeKitClient,
  timeoutMs: number = 10000
) =>
  Effect.gen(function* () {
    const logger = yield* LoggerService;
    yield* logger.debug("Joining RealtimeKit room");

    const result = yield* pipe(
      Effect.tryPromise({
        try: () => client.join(),
        catch: (error) =>
          new ConnectionError({
            code: "CONNECTION_FAILED",
            message: error instanceof Error ? error.message : "RTK join failed",
            recoverable: true,
            cause: error,
          }),
      }),
      Effect.timeoutOption(`${timeoutMs} millis`)
    );

    if (Option.isNone(result)) {
      return yield* Effect.fail(
        new TimeoutError({
          message: `Room join timed out after ${timeoutMs}ms`,
          operation: "joinRTKRoom",
          timeoutMs,
        })
      );
    }

    yield* logger.debug("Joined RealtimeKit room");
    return result.value;
  });

/**
 * Connect WebSocket with automatic cleanup
 */
export const connectWebSocket = (url: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const logger = yield* LoggerService;
      yield* logger.debug("Connecting WebSocket", { url });

      const ws = yield* Effect.sync(() => new WebSocket(url));

      // Wait for open or error
      yield* Effect.async<void, ConnectionError>((resume) => {
        const onOpen = () => {
          ws.removeEventListener("error", onError);
          resume(Effect.succeed(void 0));
        };

        const onError = (event: Event) => {
          ws.removeEventListener("open", onOpen);
          resume(
            Effect.fail(
              new ConnectionError({
                code: "WEBSOCKET_ERROR",
                message: "WebSocket connection failed",
                recoverable: true,
                cause: event,
              })
            )
          );
        };

        ws.addEventListener("open", onOpen, { once: true });
        ws.addEventListener("error", onError, { once: true });

        return Effect.sync(() => {
          ws.removeEventListener("open", onOpen);
          ws.removeEventListener("error", onError);
        });
      });

      yield* logger.debug("WebSocket connected");
      return ws;
    }),
    (ws) =>
      Effect.sync(() => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, "Effect cleanup");
        }
      })
  );

/**
 * Create a connection-ready deferred for async signaling
 */
export const makeConnectionReady = () => Deferred.make<void, ConnectionError>();

/**
 * Utility: Run scoped effect and return the value
 * Resources are cleaned up when the returned scope is closed
 */
export const runScoped = <A, E, R>(
  effect: Effect.Effect<A, E, R | Scope.Scope>
) =>
  Effect.scoped(effect);

/**
 * Create a join semaphore (mutex) for serializing join operations
 *
 * Returns Effect that creates a Semaphore with 1 permit.
 * Use `semaphore.withPermits(1)(effect)` to serialize.
 */
export const makeJoinSemaphore = () => Effect.makeSemaphore(1);

/**
 * Execute effect with join lock (semaphore permit)
 *
 * Ensures only one join operation runs at a time.
 * Other callers wait for the permit to be released.
 */
export const withJoinLock = <A, E, R>(
  semaphore: Effect.Semaphore,
  effect: Effect.Effect<A, E, R>
) => semaphore.withPermits(1)(effect);

/**
 * Create an operation lock for serializing async operations (Promise-based)
 *
 * For use outside Effect runtime. Uses promise-based mutex pattern.
 */
export const createOperationLock = () => {
  let isLocked = false;
  let pendingPromise: Promise<void> | null = null;

  return {
    /**
     * Execute operation with lock
     * If already locked, waits for current operation to complete
     */
    withLock: async <T>(operation: () => Promise<T>): Promise<T> => {
      // Wait for any pending operation
      while (isLocked && pendingPromise) {
        await pendingPromise;
      }

      isLocked = true;
      let resolve: () => void;
      pendingPromise = new Promise((r) => { resolve = r; });

      try {
        return await operation();
      } finally {
        isLocked = false;
        resolve!();
        pendingPromise = null;
      }
    },

    isLocked: () => isLocked,
  };
};

export type OperationLock = ReturnType<typeof createOperationLock>;
