import { WebhookVerificationError } from "./errors.js";
import { knownWebhookEventNamesV1, type KnownWebhookEventNameV1, type KnownWebhookEventV1 } from "./generated/event-v1.js";
import type { UnknownWebhookEvent, WebhookDiagnosticEvent, WebhookHandlerMap, WebhookInbox, WebhookProcessResult } from "./types.js";
import { verifyWebhook } from "./verify.js";

const knownNames = new Set<string>(knownWebhookEventNamesV1);
const MAX_LEASE_MILLISECONDS = 300_000;

export type WebhookProcessorInput = {
  rawBody: Uint8Array;
  headers: Headers | Record<string, string | string[] | undefined>;
};

export type WebhookProcessor = { process(input: WebhookProcessorInput): Promise<WebhookProcessResult> };

export type CreateWebhookProcessorOptions = {
  secrets: readonly string[] | (() => Promise<readonly string[]>);
  inbox: WebhookInbox;
  handlers: Partial<WebhookHandlerMap>;
  /** Observes authenticated Event names unknown to this SDK. Its result is not awaited and failures are ignored. */
  onUnknownEvent?: (event: UnknownWebhookEvent) => Promise<void> | void;
  /** Observes bounded processing metadata. Its result is not awaited and failures are ignored. */
  onDiagnostic?: (event: WebhookDiagnosticEvent) => Promise<void> | void;
  toleranceSeconds?: number;
  leaseMilliseconds?: number;
};

const result = (value: WebhookProcessResult): WebhookProcessResult => Object.freeze(value);

const observe = (callback: (() => Promise<void> | void) | undefined) => {
  if (!callback) return;
  try {
    void Promise.resolve(callback()).catch(() => undefined);
  } catch {
    // Observers cannot change receiver processing or acknowledgement.
  }
};

const emitDiagnostic = (callback: CreateWebhookProcessorOptions["onDiagnostic"], event: Omit<WebhookDiagnosticEvent, "durationMilliseconds">, startedAt: number) => {
  observe(callback ? () => callback(Object.freeze({ ...event, durationMilliseconds: Math.max(0, performance.now() - startedAt) })) : undefined);
};

const safeRetryAfter = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(300, Math.ceil(value));
};

const releaseLease = async (inbox: WebhookInbox, eventId: string, token: string) => {
  try {
    await inbox.release({ eventId, token });
  } catch {
    // Lease expiry still permits recovery when the inbox is temporarily unavailable.
  }
};

type EventIdentity = Readonly<{ eventId: string; eventName: string; apiVersion: number }>;
type AcquiredClaim = Readonly<{ state: "acquired"; token: string }>;

const failedResult = (options: CreateWebhookProcessorOptions, startedAt: number, errorCode: string, identity: EventIdentity | Record<string, never> = {}): WebhookProcessResult => {
  emitDiagnostic(options.onDiagnostic, { phase: "failed", outcome: "failed", ...identity }, startedAt);
  return result({ status: 500, outcome: "failed", errorCode, ...identity });
};

type SecretLoad = Readonly<{ ok: true; secrets: readonly string[] }> | Readonly<{ ok: false; failure: WebhookProcessResult }>;

const loadSecrets = async (options: CreateWebhookProcessorOptions, startedAt: number): Promise<SecretLoad> => {
  try {
    const secrets = typeof options.secrets === "function" ? await options.secrets() : options.secrets;
    return { ok: true, secrets };
  } catch {
    return { ok: false, failure: failedResult(options, startedAt, "secret_provider_unavailable") };
  }
};

const rejectedResult = (options: CreateWebhookProcessorOptions, startedAt: number, error: unknown): WebhookProcessResult => {
  const errorCode = error instanceof WebhookVerificationError ? error.code : "verification_failed";
  if (errorCode === "invalid_secret") return failedResult(options, startedAt, errorCode);
  emitDiagnostic(options.onDiagnostic, { phase: "rejected", outcome: "rejected" }, startedAt);
  return result({ status: errorCode === "invalid_signature" ? 401 : 400, outcome: "rejected", errorCode });
};

const verifyInput = async (input: WebhookProcessorInput, secrets: readonly string[], options: CreateWebhookProcessorOptions, startedAt: number) => {
  try {
    return await verifyWebhook({ ...input, secrets, toleranceSeconds: options.toleranceSeconds });
  } catch (error) {
    return rejectedResult(options, startedAt, error);
  }
};

const acquireLease = async (options: CreateWebhookProcessorOptions, leaseMilliseconds: number, identity: EventIdentity, startedAt: number): Promise<AcquiredClaim | WebhookProcessResult> => {
  try {
    const claim = await options.inbox.acquire({ eventId: identity.eventId, leaseMilliseconds });
    if (claim.state === "completed") return result({ status: 200, outcome: "duplicate", ...identity });
    if (claim.state === "busy") return result({ status: 503, outcome: "busy", retryAfterSeconds: safeRetryAfter(claim.retryAfterSeconds), ...identity });
    return claim;
  } catch {
    return failedResult(options, startedAt, "inbox_unavailable", identity);
  }
};

const knownHandler = (event: KnownWebhookEventV1, handlers: Partial<WebhookHandlerMap>) => handlers[event.event as KnownWebhookEventNameV1] as ((event: KnownWebhookEventV1) => Promise<void> | void) | undefined;

const handleKnownEvent = async (event: KnownWebhookEventV1, options: CreateWebhookProcessorOptions): Promise<"handler_missing" | undefined> => {
  const handler = knownHandler(event, options.handlers);
  if (typeof handler !== "function") return "handler_missing";
  await handler(event);
  return undefined;
};

const observeUnknownEvent = (event: UnknownWebhookEvent, callback: CreateWebhookProcessorOptions["onUnknownEvent"]): void => {
  if (!callback) return;
  observe(() => callback(event));
};

const handleAuthenticatedEvent = async (event: KnownWebhookEventV1 | UnknownWebhookEvent, options: CreateWebhookProcessorOptions): Promise<"handler_missing" | undefined> => {
  if (knownNames.has(event.event)) return handleKnownEvent(event as KnownWebhookEventV1, options);
  observeUnknownEvent(event as UnknownWebhookEvent, options.onUnknownEvent);
  return undefined;
};

const handleEvent = async (event: KnownWebhookEventV1 | UnknownWebhookEvent, claim: AcquiredClaim, options: CreateWebhookProcessorOptions, identity: EventIdentity, startedAt: number): Promise<WebhookProcessResult | undefined> => {
  try {
    const errorCode = await handleAuthenticatedEvent(event, options);
    if (errorCode) {
      await releaseLease(options.inbox, event.id, claim.token);
      return failedResult(options, startedAt, errorCode, identity);
    }
    emitDiagnostic(options.onDiagnostic, { phase: "handled", outcome: "processed", ...identity }, startedAt);
    return undefined;
  } catch {
    await releaseLease(options.inbox, event.id, claim.token);
    return failedResult(options, startedAt, "handler_failed", identity);
  }
};

const completeLease = async (claim: AcquiredClaim, options: CreateWebhookProcessorOptions, identity: EventIdentity, startedAt: number): Promise<WebhookProcessResult | undefined> => {
  try {
    await options.inbox.complete({ eventId: identity.eventId, token: claim.token });
    return undefined;
  } catch {
    return failedResult(options, startedAt, "inbox_complete_failed", identity);
  }
};

const requireSecretLoad = (load: SecretLoad): readonly string[] => {
  if (!load.ok) throw new ProcessingStopped(load.failure);
  return load.secrets;
};

const requireValue = <Value>(value: Value | WebhookProcessResult): Value => {
  if ("status" in (value as Value & WebhookProcessResult)) throw new ProcessingStopped(value as WebhookProcessResult);
  return value as Value;
};

const requireSuccess = (failure: WebhookProcessResult | undefined): void => {
  if (failure) throw new ProcessingStopped(failure);
};

class ProcessingStopped extends Error {
  constructor(readonly processResult: WebhookProcessResult) {
    super("Webhook processing stopped with a bounded result.");
  }
}

const runProcessingStages = async (input: WebhookProcessorInput, options: CreateWebhookProcessorOptions, leaseMilliseconds: number, startedAt: number): Promise<WebhookProcessResult> => {
  const secrets = requireSecretLoad(await loadSecrets(options, startedAt));
  const event = requireValue(await verifyInput(input, secrets, options, startedAt));
  const identity = { eventId: event.id, eventName: event.event, apiVersion: event.api_version };
  emitDiagnostic(options.onDiagnostic, { phase: "verified", outcome: "processed", ...identity }, startedAt);

  const claim = requireValue(await acquireLease(options, leaseMilliseconds, identity, startedAt));
  emitDiagnostic(options.onDiagnostic, { phase: "acquired", outcome: "processed", ...identity }, startedAt);
  requireSuccess(await handleEvent(event, claim, options, identity, startedAt));
  requireSuccess(await completeLease(claim, options, identity, startedAt));

  const outcome = knownNames.has(event.event) ? "processed" : "ignored";
  emitDiagnostic(options.onDiagnostic, { phase: "completed", outcome, ...identity }, startedAt);
  return result({ status: 200, outcome, ...identity });
};

const processWebhook = async (input: WebhookProcessorInput, options: CreateWebhookProcessorOptions, leaseMilliseconds: number): Promise<WebhookProcessResult> => {
  const startedAt = performance.now();
  try {
    return await runProcessingStages(input, options, leaseMilliseconds, startedAt);
  } catch (error) {
    if (error instanceof ProcessingStopped) return error.processResult;
    throw error;
  }
};

export const createWebhookProcessor = (options: CreateWebhookProcessorOptions): WebhookProcessor => {
  const leaseMilliseconds = options.leaseMilliseconds ?? 30_000;
  if (!validLeaseMilliseconds(leaseMilliseconds)) {
    throw new RangeError("Webhook leaseMilliseconds must be an integer from 1 through 300000.");
  }
  return {
    process: (input) => processWebhook(input, options, leaseMilliseconds),
  };
};

const validLeaseMilliseconds = (value: number): boolean => Number.isInteger(value) && value >= 1 && value <= MAX_LEASE_MILLISECONDS;

export const toWebhookResponse = (processResult: WebhookProcessResult): Response => {
  const headers = new Headers();
  if (processResult.retryAfterSeconds !== undefined) headers.set("Retry-After", String(processResult.retryAfterSeconds));
  return new Response(null, { status: processResult.status, headers });
};
