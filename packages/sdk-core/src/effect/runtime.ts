/**
 * Effect Runtime for Chalk SDK
 *
 * Provides the bridge between Effect-based internals and Promise-based public API.
 * Handles error conversion and event emission.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect
 */

import { Effect, Layer, ManagedRuntime, pipe, Option } from "effect";
import type { ConferenceClientConfig, ChalkError as ChalkErrorInterface } from "../types";
import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";
import { type SDKError, toChalkError, TimeoutError } from "./errors";
import {
  ConfigService,
  LoggerService,
  TokenProviderService,
  makeConfigLayer,
  makeLoggerLayer,
  makeTokenProviderLayer,
} from "./services";

/**
 * Combined SDK services type
 */
export type SDKServices = ConfigService | LoggerService | TokenProviderService;

/**
 * Error emitter interface for bridging to EventEmitter
 */
export interface ErrorEmitter {
  emit(event: "error", error: ChalkErrorInterface): void;
}

/**
 * Options for running SDK effects
 */
export interface RunSDKEffectOptions {
  /** Optional error emitter for event-based error handling */
  emitter?: ErrorEmitter;
  /** Whether to suppress throwing on error (emit only) */
  emitOnly?: boolean;
}

/**
 * Create the base SDK layer from config
 */
export const makeSDKLayer = (config: ConferenceClientConfig) =>
  Layer.mergeAll(
    makeConfigLayer(config),
    makeLoggerLayer(config.debug ?? false),
    makeTokenProviderLayer(config.tokenProvider)
  );

/**
 * Create a managed runtime for the SDK
 */
export const makeSDKRuntime = (config: ConferenceClientConfig) =>
  ManagedRuntime.make(makeSDKLayer(config));

/**
 * Run an Effect and convert to Promise with error handling
 *
 * - Converts SDK errors to ChalkError for backwards compatibility
 * - Optionally emits errors to EventEmitter
 * - Returns Promise<A> for public API compatibility
 */
export const runSDKEffect = <A, E extends SDKError>(
  effect: Effect.Effect<A, E, SDKServices>,
  layer: Layer.Layer<SDKServices, never, never>,
  options?: RunSDKEffectOptions
): Promise<A> => {
  const program = pipe(
    effect,
    Effect.catchAll((error) => {
      const chalkError = toChalkError(error);

      if (options?.emitter) {
        options.emitter.emit("error", {
          code: chalkError.code,
          message: chalkError.message,
          details: chalkError.details,
        });
      }

      if (options?.emitOnly) {
        return Effect.fail(error);
      }

      return Effect.fail(error);
    }),
    Effect.provide(layer)
  );

  return Effect.runPromise(program).catch((error) => {
    if (error instanceof ChalkError) {
      throw error;
    }
    if (error && typeof error === "object" && "_tag" in error) {
      throw toChalkError(error as SDKError);
    }
    throw new ChalkError(ChalkErrorCode.UNKNOWN, String(error));
  });
};

/**
 * Run an Effect with automatic error emission (no throw)
 *
 * Useful for fire-and-forget operations where errors should
 * only be emitted as events.
 */
export const runSDKEffectEmitOnly = <A, E extends SDKError>(
  effect: Effect.Effect<A, E, SDKServices>,
  layer: Layer.Layer<SDKServices, never, never>,
  emitter: ErrorEmitter
): Promise<A | undefined> => {
  return runSDKEffect(effect, layer, { emitter, emitOnly: true }).catch(() => undefined);
};

/**
 * Convert a Promise-returning function to an Effect
 */
export const fromPromise = <A>(
  promise: () => Promise<A>,
  mapError: (error: unknown) => SDKError
): Effect.Effect<A, SDKError> =>
  Effect.tryPromise({
    try: promise,
    catch: mapError,
  });

/**
 * Create a timed effect with timeout handling
 */
export const withTimeout = <A, E>(
  effect: Effect.Effect<A, E>,
  timeoutMs: number,
  operation: string
): Effect.Effect<A, E | TimeoutError> =>
  pipe(
    effect,
    Effect.timeoutOption(`${timeoutMs} millis`),
    Effect.flatMap((option) =>
      Option.isSome(option)
        ? Effect.succeed(option.value)
        : Effect.fail(
            new TimeoutError({
              message: `${operation} timed out after ${timeoutMs}ms`,
              operation,
              timeoutMs,
            })
          )
    )
  );
