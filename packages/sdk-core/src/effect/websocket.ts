/**
 * Effect-based WebSocket Resilience for Chalk SDK
 *
 * Provides reconnection with exponential backoff, heartbeat management,
 * and message queue for backpressure handling.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect
 */

import { Effect, Schedule, Fiber, Ref, Queue, Stream, pipe, Duration } from "effect";
import { ConnectionError, AuthError } from "./errors";
import { LoggerService } from "./services";
import type { TokenProvider } from "../types";

/**
 * WebSocket configuration
 */
export interface WSConfig {
  /** Base delay for exponential backoff (default: 1000ms) */
  baseDelay?: number;
  /** Maximum reconnect attempts (default: 5) */
  maxAttempts?: number;
  /** Heartbeat interval (default: 30000ms) */
  heartbeatInterval?: number;
  /** Heartbeat timeout threshold (default: 2.5x interval) */
  heartbeatTimeout?: number;
  /** Add jitter to backoff (default: true) */
  jitter?: boolean;
}

const DEFAULT_CONFIG: Required<WSConfig> = {
  baseDelay: 1000,
  maxAttempts: 5,
  heartbeatInterval: 30000,
  heartbeatTimeout: 75000, // 2.5x interval
  jitter: true,
};

/**
 * Create reconnect schedule with exponential backoff
 *
 * Replaces manual RECONNECT_DELAYS array:
 * ```ts
 * const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];
 * ```
 *
 * With Effect Schedule:
 * - Exponential backoff starting at baseDelay
 * - Optional jitter to prevent thundering herd
 * - Max attempts limit
 */
export const makeReconnectSchedule = (config: WSConfig = {}) => {
  const { baseDelay, maxAttempts, jitter } = { ...DEFAULT_CONFIG, ...config };

  let schedule = Schedule.exponential(Duration.millis(baseDelay));

  if (jitter) {
    schedule = Schedule.jittered(schedule);
  }

  return pipe(
    schedule,
    Schedule.compose(Schedule.recurs(maxAttempts))
  );
};

/**
 * Connect with automatic retry using Effect Schedule
 */
export const connectWithRetry = <A>(
  connect: Effect.Effect<A, ConnectionError>,
  schedule: Schedule.Schedule<unknown, unknown>
) =>
  pipe(
    connect,
    Effect.retry(schedule),
    Effect.tapError((error) =>
      Effect.gen(function* () {
        const logger = yield* LoggerService;
        yield* logger.error("Max reconnect attempts reached", { error: error.message });
      })
    )
  );

/**
 * Heartbeat effect that runs in a Fiber
 *
 * Replaces manual setInterval:
 * ```ts
 * this.heartbeatTimer = setInterval(() => { ... }, HEARTBEAT_INTERVAL);
 * ```
 *
 * With Effect Fiber:
 * - Auto-interrupted when parent scope exits
 * - Type-safe timeout detection
 * - Proper cleanup without manual clearInterval
 */
export const makeHeartbeat = (
  sendPing: Effect.Effect<void>,
  lastPongRef: Ref.Ref<number>,
  config: WSConfig = {}
) => {
  const { heartbeatInterval, heartbeatTimeout } = { ...DEFAULT_CONFIG, ...config };

  return Effect.gen(function* () {
    const logger = yield* LoggerService;

    while (true) {
      yield* Effect.sleep(Duration.millis(heartbeatInterval));

      const lastPong = yield* Ref.get(lastPongRef);
      const elapsed = Date.now() - lastPong;

      if (elapsed > heartbeatTimeout) {
        yield* logger.warn("Heartbeat timeout", { elapsed, threshold: heartbeatTimeout });
        return yield* Effect.fail(
          new ConnectionError({
            code: "CONNECTION_LOST",
            message: `Heartbeat timeout - no pong received in ${elapsed}ms`,
            recoverable: true,
          })
        );
      }

      yield* sendPing;
    }
  });
};

/**
 * Run effect with heartbeat fiber
 *
 * Heartbeat fiber is automatically interrupted when:
 * - Main effect completes
 * - Main effect fails
 * - Scope is closed
 */
export const withHeartbeat = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  sendPing: Effect.Effect<void>,
  lastPongRef: Ref.Ref<number>,
  config?: WSConfig
) =>
  Effect.gen(function* () {
    const heartbeatFiber = yield* Effect.fork(makeHeartbeat(sendPing, lastPongRef, config));

    // Ensure heartbeat is interrupted on cleanup
    yield* Effect.addFinalizer(() => Fiber.interrupt(heartbeatFiber));

    return yield* effect;
  });

/**
 * Token refresh with retry for reconnection
 */
export const refreshTokenForReconnect = (tokenProvider: TokenProvider | undefined) =>
  Effect.gen(function* () {
    if (!tokenProvider) {
      return yield* Effect.fail(
        new AuthError({
          code: "TOKEN_REFRESH_FAILED",
          message: "No token provider configured for reconnection",
          recoverable: false,
        })
      );
    }

    const logger = yield* LoggerService;
    yield* logger.debug("Refreshing token before reconnect");

    const token = yield* Effect.tryPromise({
      try: () => tokenProvider(),
      catch: (error) =>
        new AuthError({
          code: "TOKEN_REFRESH_FAILED",
          message: error instanceof Error ? error.message : "Token refresh failed",
          recoverable: false,
          cause: error,
        }),
    });

    yield* logger.info("Token refreshed successfully");
    return token;
  });

/**
 * Message queue strategies for different message types
 */
export const MessageQueueStrategies = {
  /**
   * Bounded queue - blocks producer when full
   * Use for: chat messages, participant updates
   */
  bounded: <A>(capacity: number) => Queue.bounded<A>(capacity),

  /**
   * Sliding queue - drops oldest when full
   * Use for: cursor updates, audio levels
   */
  sliding: <A>(capacity: number) => Queue.sliding<A>(capacity),

  /**
   * Dropping queue - drops newest when full
   * Use for: low-priority updates
   */
  dropping: <A>(capacity: number) => Queue.dropping<A>(capacity),

  /**
   * Unbounded queue - no limit (use carefully)
   */
  unbounded: <A>() => Queue.unbounded<A>(),
};

/**
 * Create a message processor from a queue
 *
 * Processes messages at consumer's pace with backpressure
 */
export const processMessageQueue = <A, E, R>(
  queue: Queue.Queue<A>,
  handler: (message: A) => Effect.Effect<void, E, R>
) =>
  pipe(
    Stream.fromQueue(queue),
    Stream.mapEffect(handler),
    Stream.runDrain
  );

/**
 * WebSocket message with type for routing
 */
export interface TypedWSMessage<T extends string = string> {
  type: T;
  payload?: unknown;
}

/**
 * Create typed message handler effect
 */
export const handleWSMessage = <T extends string>(
  message: TypedWSMessage<T>,
  handlers: Partial<Record<T, (payload: unknown) => Effect.Effect<void>>>
) =>
  Effect.gen(function* () {
    const handler = handlers[message.type];
    if (handler) {
      yield* handler(message.payload);
    } else {
      const logger = yield* LoggerService;
      yield* logger.warn("Unknown message type", { type: message.type });
    }
  });

/**
 * Create last pong ref for heartbeat tracking
 */
export const makeLastPongRef = () => Ref.make(Date.now());

/**
 * Update last pong time (call on pong received)
 */
export const updateLastPong = (ref: Ref.Ref<number>) =>
  Ref.set(ref, Date.now());
