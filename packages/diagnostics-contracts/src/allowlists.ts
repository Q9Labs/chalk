import type { CheckpointClass, DiagnosticEventSource, DiagnosticEventState, Environment, SafeUnknownReason } from "./types.js";

export const ENVIRONMENTS = ["localhost", "development", "staging", "production"] as const satisfies readonly Environment[];
export const EVENT_SOURCES = ["ui", "sdk", "api", "sync", "rtc", "provider", "worker"] as const satisfies readonly DiagnosticEventSource[];
export const EVENT_STATES = ["started", "observed", "succeeded", "failed", "cancelled", "timed_out", "not_observable", "late_observed"] as const satisfies readonly DiagnosticEventState[];
export const CHECKPOINT_CLASSES = ["required", "conditional", "best_effort"] as const satisfies readonly CheckpointClass[];
export const UNKNOWN_REASONS = ["not_retained", "not_observable", "redacted", "provider_opaque", "expired", "not_available", "invalid", "diagnostics_disabled", "permission_denied", "unknown"] as const satisfies readonly SafeUnknownReason[];

export const EVENT_PHASES = [
  "intent",
  "validation",
  "authorized",
  "denied",
  "enqueued",
  "attempt",
  "retry",
  "started",
  "observed",
  "connected",
  "authenticated",
  "snapshot",
  "live",
  "reconnected",
  "disconnected",
  "acquired",
  "prepared",
  "published",
  "subscribed",
  "first_frame",
  "committed",
  "receipt",
  "projected",
  "paged",
  "read",
  "deduped",
  "expired",
  "callback",
  "finalized",
  "delivered",
  "exhausted",
  "fan_in",
  "unsupported",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "not_observable",
  "late_observed",
] as const;

export const ATTRIBUTE_KEYS = [
  "action",
  "checkpoint",
  "reason",
  "result",
  "status",
  "kind",
  "direction",
  "transport",
  "media_kind",
  "track_state",
  "permission",
  "target_state",
  "response_class",
  "delivery_status",
  "storage_state",
  "object_ref_class",
  "attachment_type",
  "size_bucket",
  "safe_id_class",
  "visibility",
  "recipient_count",
  "projection_count",
  "observable_recipient_count",
  "attempt",
  "retryable",
  "budget_remaining",
  "duration_ms",
  "latency_ms",
  "bytes",
  "count",
  "cursor",
  "sequence",
  "grace_ms",
  "deadline_ms",
  "state_version",
  "policy_version",
  "release_channel",
] as const;

export const CORRELATION_KEYS = ["journeyId", "traceId", "spanId", "requestId", "commandId", "providerId", "retryGroupRef", "attempt"] as const;

export const EVENT_NAME_EXTRA_ROOTS = [
  "coverage.started_late",
  "coverage.gap",
  "coverage.rejected",
  "operation.started",
  "operation.ended",
  "checkpoint.observed",
  "checkpoint.missed",
  "issue.opened",
  "issue.resolved",
  "branch.started",
  "branch.ended",
  "diagnostic.created",
  "diagnostic.ended",
  "diagnostic.completed",
] as const;

export const MAX_DIAGNOSTIC_EVENT_BYTES = 2 * 1024;
export const MAX_EVENT_ID_LENGTH = 128;
export const MAX_OPERATION_REF_LENGTH = 128;
export const MAX_EVENT_NAME_LENGTH = 96;
export const MAX_PHASE_LENGTH = 48;
export const MAX_ATTRIBUTE_COUNT = 32;
export const MAX_ATTRIBUTE_KEY_LENGTH = 64;
export const MAX_ATTRIBUTE_STRING_LENGTH = 256;
export const MAX_SAFE_IDENTIFIER_LENGTH = 160;
export const MAX_PAGE_SIZE = 1_000;

export const SAFE_ID_CLASSES = {
  "chalk.request": { storage: "raw", copyable: true, maxLength: 128, alphabet: "token" },
  "chalk.command": { storage: "raw", copyable: true, maxLength: 128, alphabet: "token" },
  "chalk.journey": { storage: "raw", copyable: true, maxLength: 128, alphabet: "token" },
  "chalk.participant": { storage: "raw", copyable: true, maxLength: 128, alphabet: "token" },
  "chalk.service": { storage: "raw", copyable: true, maxLength: 64, alphabet: "token" },
  "chalk.retry": { storage: "raw", copyable: true, maxLength: 128, alphabet: "token" },
  "w3c.trace": { storage: "raw", copyable: true, maxLength: 32, alphabet: "hex" },
  "w3c.span": { storage: "raw", copyable: true, maxLength: 16, alphabet: "hex" },
  provider: { storage: "hmac", copyable: false, maxLength: 160, alphabet: "safe" },
  integration: { storage: "hmac", copyable: false, maxLength: 160, alphabet: "safe" },
  diagnostic: { storage: "raw", copyable: true, maxLength: 128, alphabet: "token" },
  operation: { storage: "raw", copyable: true, maxLength: 128, alphabet: "token" },
  issue: { storage: "raw", copyable: true, maxLength: 128, alphabet: "token" },
  event: { storage: "raw", copyable: true, maxLength: 128, alphabet: "token" },
} as const;

export type SafeIdClass = keyof typeof SAFE_ID_CLASSES | (string & {});
export type KnownSafeIdClass = keyof typeof SAFE_ID_CLASSES;

export const isEnvironment = (value: unknown): value is Environment => (ENVIRONMENTS as readonly string[]).includes(value as string);
export const isEventSource = (value: unknown): value is DiagnosticEventSource => (EVENT_SOURCES as readonly string[]).includes(value as string);
export const isEventState = (value: unknown): value is DiagnosticEventState => (EVENT_STATES as readonly string[]).includes(value as string);
export const isCheckpointClass = (value: unknown): value is CheckpointClass => (CHECKPOINT_CLASSES as readonly string[]).includes(value as string);
export const isUnknownReason = (value: unknown): value is SafeUnknownReason => (UNKNOWN_REASONS as readonly string[]).includes(value as string);

export const isAllowedAttributeKey = (key: string): boolean => (ATTRIBUTE_KEYS as readonly string[]).includes(key) && key.length <= MAX_ATTRIBUTE_KEY_LENGTH;

export const isAllowedPhase = (phase: string): boolean => (EVENT_PHASES as readonly string[]).includes(phase) && phase.length <= MAX_PHASE_LENGTH;

export const isSafeIdClass = (idClass: string): idClass is SafeIdClass => /^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)*$/.test(idClass);
