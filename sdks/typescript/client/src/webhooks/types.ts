import type { KnownWebhookEventNameV1, KnownWebhookEventV1 } from "./generated/event-v1.js";

export type UnknownWebhookEvent = Readonly<{
  id: string;
  event: string;
  api_version: 1;
  occurred_at: string;
  tenant_id: string;
  data: Readonly<Record<string, unknown>>;
}>;

export type ChalkWebhookEvent = KnownWebhookEventV1 | UnknownWebhookEvent;

export interface WebhookInbox {
  acquire(input: { eventId: string; leaseMilliseconds: number }): Promise<{ state: "acquired"; token: string } | { state: "completed" } | { state: "busy"; retryAfterSeconds: number }>;
  complete(input: { eventId: string; token: string }): Promise<void>;
  release(input: { eventId: string; token: string }): Promise<void>;
}

export type WebhookHandlerMap = {
  [Name in KnownWebhookEventNameV1]: (event: Extract<KnownWebhookEventV1, { readonly event: Name }>) => Promise<void> | void;
};

export type WebhookProcessOutcome = "processed" | "duplicate" | "busy" | "ignored" | "rejected" | "failed";

export type WebhookProcessResult = Readonly<{
  status: 200 | 400 | 401 | 500 | 503;
  outcome: WebhookProcessOutcome;
  retryAfterSeconds?: number;
  eventId?: string;
  eventName?: string;
  apiVersion?: number;
  errorCode?: string;
}>;

export type WebhookDiagnosticEvent = Readonly<{
  phase: "verified" | "acquired" | "handled" | "completed" | "rejected" | "failed";
  outcome: WebhookProcessOutcome;
  durationMilliseconds: number;
  eventId?: string;
  eventName?: string;
  apiVersion?: number;
}>;
