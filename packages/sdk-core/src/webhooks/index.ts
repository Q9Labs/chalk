/**
 * Webhook handling exports for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/webhooks
 */

export {
  createWebhookHandler,
  type WebhookHandlerOptions,
  type WebhookEvent,
} from "./handler";
export { chalkWebhookMiddleware } from "./express";
export {
  WebhookPayload,
  WebhookMeeting,
  WebhookRecording,
  WebhookTranscript,
  WebhookError,
  TranscriptSegment,
} from "./schemas";
