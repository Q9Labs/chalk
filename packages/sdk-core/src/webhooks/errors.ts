/**
 * Tagged errors for webhook verification pipeline
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/webhooks
 */

import { Data } from "effect";

/**
 * HMAC signature mismatch or crypto failure
 */
export class WebhookSignatureError extends Data.TaggedError("WebhookSignatureError")<{
  readonly message: string;
  readonly recoverable: false;
}> {}

/**
 * Timestamp expired or unparseable
 */
export class WebhookTimestampError extends Data.TaggedError("WebhookTimestampError")<{
  readonly message: string;
  readonly recoverable: false;
  readonly receivedTimestamp: string;
  readonly toleranceSeconds: number;
}> {}

/**
 * JSON parse or schema validation failure
 */
export class WebhookPayloadError extends Data.TaggedError("WebhookPayloadError")<{
  readonly message: string;
  readonly recoverable: false;
  readonly cause?: unknown;
}> {}

/**
 * Union of all webhook verification errors
 */
export type WebhookVerifyError = WebhookSignatureError | WebhookTimestampError | WebhookPayloadError;
