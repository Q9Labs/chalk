/**
 * Effect Service Context Tags for Chalk SDK
 *
 * Defines service interfaces as Context Tags for dependency injection.
 * Enables swapping implementations for testing.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect
 */

import { Context, Effect, Layer } from "effect";
import type { TokenProvider, ConferenceClientConfig } from "../types";
import type { AuthError } from "./errors";
import { wideEventsCollector } from "../wide-events/collector";

/**
 * Token service for managing JWT tokens
 */
export interface TokenServiceInterface {
  /** Get current token (if set) */
  readonly get: Effect.Effect<string | undefined>;
  /** Set token */
  readonly set: (token: string) => Effect.Effect<void>;
  /** Refresh token using provider (serialized) */
  readonly refresh: Effect.Effect<string, AuthError>;
  /** Clear token */
  readonly clear: Effect.Effect<void>;
}

export class TokenService extends Context.Tag("@chalk/TokenService")<
  TokenService,
  TokenServiceInterface
>() {}

/**
 * Token provider callback service
 */
export class TokenProviderService extends Context.Tag("@chalk/TokenProviderService")<
  TokenProviderService,
  TokenProvider | undefined
>() {}

/**
 * Configuration service
 */
export class ConfigService extends Context.Tag("@chalk/ConfigService")<
  ConfigService,
  ConferenceClientConfig
>() {}

/**
 * Logger service for debug output
 */
export interface LoggerInterface {
  readonly debug: (message: string, data?: Record<string, unknown>) => Effect.Effect<void>;
  readonly info: (message: string, data?: Record<string, unknown>) => Effect.Effect<void>;
  readonly warn: (message: string, data?: Record<string, unknown>) => Effect.Effect<void>;
  readonly error: (message: string, data?: Record<string, unknown>) => Effect.Effect<void>;
}

export class LoggerService extends Context.Tag("@chalk/LoggerService")<
  LoggerService,
  LoggerInterface
>() {}

/**
 * Event emitter service for SDK events
 */
export interface EventEmitterInterface<T extends Record<string, unknown>> {
  readonly emit: <K extends keyof T>(event: K, data: T[K]) => Effect.Effect<void>;
}

export class EventEmitterService extends Context.Tag("@chalk/EventEmitterService")<
  EventEmitterService,
  EventEmitterInterface<Record<string, unknown>>
>() {}

/**
 * Create a no-op logger layer (for production/silent mode)
 */
export const NoopLoggerLive = Layer.succeed(
  LoggerService,
  {
    debug: () => Effect.void,
    info: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
  }
);

/**
 * Create a console logger layer (for debug mode)
 * Now enriches the active wide event context instead of direct console output
 */
export const ConsoleLoggerLive = Layer.succeed(
  LoggerService,
  {
    debug: (message, data) => Effect.sync(() => {
      wideEventsCollector.enrichActiveContext(`debug:${message}`, data);
    }),
    info: (message, data) => Effect.sync(() => {
      wideEventsCollector.enrichActiveContext(`info:${message}`, data);
    }),
    warn: (message, data) => Effect.sync(() => {
      wideEventsCollector.enrichActiveContext(`warn:${message}`, data);
    }),
    error: (message, data) => Effect.sync(() => {
      wideEventsCollector.enrichActiveContext(`error:${message}`, data);
    }),
  }
);

/**
 * Create a logger layer based on debug config
 */
export const makeLoggerLayer = (debug: boolean) =>
  debug ? ConsoleLoggerLive : NoopLoggerLive;

/**
 * Create config layer from ConferenceClientConfig
 */
export const makeConfigLayer = (config: ConferenceClientConfig) =>
  Layer.succeed(ConfigService, config);

/**
 * Create token provider layer
 */
export const makeTokenProviderLayer = (provider: TokenProvider | undefined) =>
  Layer.succeed(TokenProviderService, provider);
