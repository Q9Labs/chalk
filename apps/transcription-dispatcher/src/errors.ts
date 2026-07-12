export type ProviderFailureKind = "retryable" | "nonretryable" | "schema" | "timeout";

export class ProviderError extends Error {
  readonly kind: ProviderFailureKind;
  readonly status: number | undefined;
  readonly providerCode: string | undefined;

  constructor(message: string, kind: ProviderFailureKind, options?: { status?: number; providerCode?: string }) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = options?.status;
    this.providerCode = options?.providerCode;
  }
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

export function providerFailureKind(error: unknown): ProviderFailureKind {
  if (error instanceof ProviderError) return error.kind;
  if (error instanceof AssignmentError) return error.retryable ? "retryable" : "nonretryable";
  if (error instanceof ControlApiError) return error.retryable ? "retryable" : "nonretryable";
  if (error instanceof DOMException && error.name === "AbortError") return "timeout";
  if (error instanceof TypeError) return "retryable";
  return "nonretryable";
}

export function safeErrorCode(error: unknown): string {
  if (error instanceof ProviderError) {
    if (error.kind === "timeout") return "provider_timeout";
    if (error.kind === "schema") return "provider_schema_invalid";
    if (error.status === 429) return "provider_rate_limited";
    if (error.status && error.status >= 500) return "provider_unavailable";
    return "provider_rejected";
  }
  if (error instanceof AssignmentError) return error.retryable ? "chunk_download_retryable" : "assignment_invalid";
  if (error instanceof ControlApiError) return "control_api_rejected";
  if (error instanceof DOMException && error.name === "AbortError") return "timeout";
  if (error instanceof TypeError) return "network_failure";
  return "dispatcher_failure";
}
