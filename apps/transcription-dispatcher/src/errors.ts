export type ProviderFailureKind = "retryable" | "nonretryable" | "schema" | "timeout";

export interface ProviderSchemaFailure {
  fieldPath: string;
  expectedType: string;
  actualType: string;
  responseSizeBytes: number;
  providerRequestId: string;
  startSeconds?: number;
  endSeconds?: number;
}

export class ProviderError extends Error {
  readonly kind: ProviderFailureKind;
  readonly status: number | undefined;
  readonly providerCode: string | undefined;
  schemaFailure: ProviderSchemaFailure | undefined;

  constructor(message: string, kind: ProviderFailureKind, options?: { status?: number; providerCode?: string }) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = options?.status;
    this.providerCode = options?.providerCode;
  }
}

export function providerSchemaError(message: string, fieldPath: string, expectedType: string, actual: unknown, responseSizeBytes = 0): ProviderError {
  const error = new ProviderError(message, "schema");
  error.schemaFailure = {
    fieldPath,
    expectedType,
    actualType: actual === null ? "null" : Array.isArray(actual) ? "array" : typeof actual,
    responseSizeBytes,
    providerRequestId: "unavailable",
  };
  return error;
}

export function providerSchemaFields(error: ProviderError): ProviderSchemaFailure {
  return error.schemaFailure ?? { fieldPath: "$", expectedType: "documented provider response", actualType: "unknown", responseSizeBytes: 0, providerRequestId: "unavailable" };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class AssignmentError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "AssignmentError";
    this.retryable = retryable;
  }
}

export class ControlApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable = false) {
    super(message);
    this.name = "ControlApiError";
    this.status = status;
    this.retryable = retryable;
  }
}

/** The control plane refused a completion or retry because the lease moved on or the work finished already. */
export function isLateCompletion(error: unknown): boolean {
  return error instanceof ControlApiError && error.status === 409;
}

/** Control plane and storage answers that a later attempt can fix. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function providerFailureKind(error: unknown): ProviderFailureKind {
  if (error instanceof ProviderError) return error.kind;
  if (error instanceof AssignmentError) return error.retryable ? "retryable" : "nonretryable";
  if (error instanceof ControlApiError) return error.retryable ? "retryable" : "nonretryable";
  if (isAbort(error)) return "timeout";
  if (error instanceof TypeError) return "retryable";
  return "nonretryable";
}

/** A terminal failure is reported once and never retried. */
export function isTerminalFailure(error: unknown): boolean {
  const kind = providerFailureKind(error);
  return kind === "nonretryable" || kind === "schema";
}

/** The caller's deadline or cancel signal fired. */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

function providerErrorCode(error: ProviderError): string {
  if (error.kind === "timeout") return "provider_timeout";
  if (error.kind === "schema") return "provider_schema_invalid";
  if (error.status === 429) return "provider_rate_limited";
  if (error.status && error.status >= 500) return "provider_unavailable";
  return "provider_rejected";
}

export function safeErrorCode(error: unknown): string {
  if (error instanceof ProviderError) return providerErrorCode(error);
  if (error instanceof AssignmentError) return error.retryable ? "chunk_download_retryable" : "assignment_invalid";
  if (error instanceof ControlApiError) return "control_api_rejected";
  if (isAbort(error)) return "timeout";
  if (error instanceof TypeError) return "network_failure";
  return "dispatcher_failure";
}
