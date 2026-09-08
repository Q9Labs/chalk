import type { DiagnosticEventDraft } from "@q9labsai/diagnostics-contracts";
import type { TelemetryEvent } from "../telemetry/types";

export const FEEDBACK_EVIDENCE_SCHEMA_VERSION = "FeedbackEvidence/v1" as const;
export const FEEDBACK_REQUEST_SCHEMA_VERSION = "FeedbackReportRequest/v1" as const;
export const FEEDBACK_RECEIPT_SCHEMA_VERSION = "FeedbackReportReceipt/v1" as const;
export const FEEDBACK_SCREENSHOT_SCHEMA_VERSION = "FeedbackScreenshot/v1" as const;
export const FEEDBACK_LOCAL_STATE_REGISTRY_VERSION = "FeedbackLocalState/v1" as const;
export const FEEDBACK_COOKIE_REGISTRY_VERSION = "FeedbackCookies/v1" as const;

export const FEEDBACK_MAX_MESSAGE_BYTES = 8_000 as const;
export const FEEDBACK_MAX_EVIDENCE_BYTES = 128 * 1024;
export const FEEDBACK_MAX_REQUEST_BYTES = 1 << 20;
export const FEEDBACK_MAX_SCREENSHOT_BYTES = 450 * 1024;
export const FEEDBACK_MAX_SCREENSHOT_WIDTH = 1_920;
export const FEEDBACK_MAX_SCREENSHOT_HEIGHT = 1_080;
export const FEEDBACK_MAX_TELEMETRY_EVENTS = 50;
export const FEEDBACK_MAX_DIAGNOSTIC_EVENTS = 50;
export const FEEDBACK_MAX_LOCAL_STATE_ENTRIES = 32;
export const FEEDBACK_MAX_COOKIE_ENTRIES = 16;

export type FeedbackCategory = "bug" | "feature_request" | "other";
export type FeedbackSource = "embedded" | "chalk_web" | "chalk_mobile" | "dashboard";
export type FeedbackPlatformKind = "web" | "ios" | "android" | "macos";
export type FeedbackDeviceClass = "phone" | "tablet" | "desktop";
export type FeedbackDiagnosticAvailability = "available" | "disabled" | "disposed" | "unavailable";
export type FeedbackScreenshotState = "captured" | "partial" | "removed" | "unavailable";
export type FeedbackScreenshotFailureCode = "capture_failed" | "unsupported" | "tainted" | "secure_surface" | "too_large";

export type FeedbackAppV1 = Readonly<{
  name: string;
  version?: string;
  build?: string;
}>;

export type FeedbackSDKV1 = Readonly<{
  client: string;
  react?: string;
  react_native?: string;
}>;

export type FeedbackPlatformV1 = Readonly<{
  kind: FeedbackPlatformKind;
  os_name?: string;
  os_version?: string;
  browser_name?: string;
  browser_version?: string;
  device_class?: FeedbackDeviceClass;
  device_model?: string;
}>;

export type FeedbackConnectionV1 = Readonly<{
  state: string;
  error_code?: string;
}>;

export type FeedbackScopeV1 = Readonly<{
  space_id?: string;
  episode_id?: string;
  participant_id?: string;
}>;

export type FeedbackCorrelationsV1 = Readonly<{
  journey_id?: string;
  root_journey_id?: string;
  trace_id?: string;
  span_id?: string;
  request_id?: string;
  command_id?: string;
  diagnostic_reference?: string;
}>;

export type FeedbackLocalStateEntryV1 = Readonly<{
  key: string;
  value: FeedbackLocalStateValue;
}>;

export type FeedbackLocalStateValue = FeedbackTelemetryStorageSummaryV1 | string | boolean | number;

export type FeedbackCookieEntryV1 = Readonly<{
  name: "chalk_theme" | "chalk_sidebar_state" | "account" | "csrf";
  present: boolean;
  value?: "light" | "dark" | "system" | "true" | "false";
}>;

export type FeedbackTelemetryStorageSummaryV1 = Readonly<{
  pending_count?: number;
  timeline_count?: number;
  dropped_count?: number;
}>;

export type FeedbackDiagnosticsV1 = Readonly<{
  availability: FeedbackDiagnosticAvailability;
  dropped_count: number;
  telemetry_events: readonly TelemetryEvent[];
  diagnostic_events: readonly DiagnosticEventDraft[];
}>;

export type FeedbackScreenshotStateV1 = Readonly<{
  state: FeedbackScreenshotState;
  captured_at?: string;
  failure_code?: FeedbackScreenshotFailureCode;
}>;

export type FeedbackEvidenceV1 = Readonly<{
  schema_version: typeof FEEDBACK_EVIDENCE_SCHEMA_VERSION;
  collected_at: string;
  app?: FeedbackAppV1;
  sdk: FeedbackSDKV1;
  platform: FeedbackPlatformV1;
  connection?: FeedbackConnectionV1;
  scope?: FeedbackScopeV1;
  correlations: FeedbackCorrelationsV1;
  diagnostics: FeedbackDiagnosticsV1;
  local_state: Readonly<{
    registry_version: typeof FEEDBACK_LOCAL_STATE_REGISTRY_VERSION;
    entries: readonly FeedbackLocalStateEntryV1[];
  }>;
  cookies: Readonly<{
    registry_version: typeof FEEDBACK_COOKIE_REGISTRY_VERSION;
    entries: readonly FeedbackCookieEntryV1[];
  }>;
  screenshot: FeedbackScreenshotStateV1;
}>;

export type FeedbackScreenshotV1 = Readonly<{
  schema_version: typeof FEEDBACK_SCREENSHOT_SCHEMA_VERSION;
  mime_type: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  captured_at: string;
  data_base64: string;
}>;

export type FeedbackReportRequestV1 = Readonly<{
  schema_version: typeof FEEDBACK_REQUEST_SCHEMA_VERSION;
  category: FeedbackCategory;
  message: string;
  source: FeedbackSource;
  evidence: FeedbackEvidenceV1;
  screenshot?: FeedbackScreenshotV1;
}>;

export type FeedbackReportReceiptV1 = Readonly<{
  schema_version: typeof FEEDBACK_RECEIPT_SCHEMA_VERSION;
  id: string;
  submitted_at: string;
}>;

export type FeedbackScreenshotCapture = Readonly<{
  state: "captured" | "partial";
  mime_type: FeedbackScreenshotV1["mime_type"];
  width: number;
  height: number;
  captured_at: string;
  data_base64: string;
}>;

export type FeedbackScreenshotUnavailable = Readonly<{
  state: "removed" | "unavailable";
  failure_code?: FeedbackScreenshotFailureCode;
}>;

export type FeedbackScreenshotProvider = () => FeedbackScreenshotCapture | FeedbackScreenshotUnavailable | Promise<FeedbackScreenshotCapture | FeedbackScreenshotUnavailable>;

export type FeedbackTelemetrySnapshot = Readonly<{
  events?: readonly TelemetryEvent[];
  pending_count?: number;
  timeline_count?: number;
  dropped_count?: number;
  storage_key?: "chalk.web.telemetry.v1" | "chalk.mobile.telemetry.v1";
}>;

export type FeedbackLocalStateInput = Readonly<{
  telemetry?: FeedbackTelemetrySnapshot;
  tenant_hint?: string;
  dashboard_requests?: readonly Readonly<{ action: string; pending: boolean }>[];
}>;

export type FeedbackCookieInput = Readonly<{
  theme?: "light" | "dark" | "system";
  sidebar_state?: boolean;
  account_present?: boolean;
  csrf_present?: boolean;
}>;

export type FeedbackEvidenceInput = Readonly<{
  app?: FeedbackAppV1;
  sdk: FeedbackSDKV1;
  platform: FeedbackPlatformV1;
  local_state?: FeedbackLocalStateInput;
  cookies?: FeedbackCookieInput;
  screenshot?: FeedbackScreenshotCapture | FeedbackScreenshotUnavailable;
}>;

export type FeedbackPrepareInput = Readonly<{
  source?: FeedbackSource;
  evidence?: Partial<FeedbackEvidenceInput>;
  screenshot_provider?: FeedbackScreenshotProvider;
  screenshotProvider?: FeedbackScreenshotProvider;
}>;

export type FeedbackSendInput = Readonly<{
  category: FeedbackCategory;
  message: string;
  source?: FeedbackSource;
  evidence?: FeedbackEvidenceInput;
  screenshot?: FeedbackScreenshotCapture | FeedbackScreenshotUnavailable;
  idempotency_key?: string;
  idempotencyKey?: string;
}>;

export type FeedbackPrepared = Readonly<{
  readonly idempotency_key: string;
  readonly evidence: FeedbackEvidenceV1;
  readonly screenshot?: FeedbackScreenshotV1;
  readonly collect: (input?: FeedbackEvidenceInput) => FeedbackEvidenceV1;
  readonly send: (input: Readonly<{ category: FeedbackCategory; message: string }>) => Promise<FeedbackReportReceiptV1>;
}>;

export type FeedbackController = Readonly<{
  readonly prepare: (input?: FeedbackPrepareInput) => Promise<FeedbackPrepared>;
  readonly send: (input: FeedbackSendInput) => Promise<FeedbackReportReceiptV1>;
  readonly dispose: () => void;
}>;
