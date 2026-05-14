/**
 * Webhook handling exports for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/webhooks
 */

export { WebhookPayloadError, WebhookSignatureError, WebhookTimestampError, type WebhookVerifyError } from "./errors";
export {
  chalkWebhookMiddleware,
  chalkWebhookParserErrorMiddleware,
  normalizeChalkSignatureHeader,
  type ChalkWebhookExpressOptions,
  type ChalkWebhookParserErrorOptions,
} from "./express";
export { createWebhookHandler, type WebhookEvent, type WebhookHandlerOptions } from "./handler";
export { TranscriptSegment, WebhookError, WebhookMeeting, WebhookParticipant, WebhookPayload, WebhookPayloadFromJson, WebhookRecording, WebhookTranscript } from "./schemas";
