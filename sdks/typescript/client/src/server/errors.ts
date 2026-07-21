export type ChalkAPIErrorCode = "network_error" | "invalid_response" | "request_failed" | (string & {});

const safeCodePattern = /^[a-z][a-z0-9_]{0,63}$/u;
const safeRequestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/u;

export class ChalkAPIError extends Error {
  readonly code: ChalkAPIErrorCode;
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  readonly status: number;

  constructor(input: { code: ChalkAPIErrorCode; requestId?: string; retryable: boolean; status: number }) {
    super(messageFor(input.code, input.status));
    this.name = "ChalkAPIError";
    this.code = input.code;
    this.status = input.status;
    this.retryable = input.retryable;
    this.requestId = input.requestId;
  }
}

export class ChalkServerOnlyError extends Error {
  constructor() {
    super("The Chalk server client is available only in Node.js runtimes.");
    this.name = "ChalkServerOnlyError";
  }
}

export function errorCode(value: unknown): ChalkAPIErrorCode {
  return safeErrorCode(errorCodeValue(value));
}

export function requestId(headers: Headers): string | undefined {
  return safeRequestId(headers.get("x-request-id") ?? headers.get("x-chalk-request-id"));
}

function errorCodeValue(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  if (!isRecord(value.error)) return undefined;
  return value.error.code;
}

function safeErrorCode(value: unknown): ChalkAPIErrorCode {
  if (typeof value !== "string") return "request_failed";
  if (!safeCodePattern.test(value)) return "request_failed";
  return value;
}

function safeRequestId(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!safeRequestIdPattern.test(value)) return undefined;
  return value;
}

function messageFor(code: ChalkAPIErrorCode, status: number): string {
  if (code === "network_error") return "The Chalk API could not be reached.";
  if (code === "invalid_response") return "The Chalk API returned an invalid response.";
  return status > 0 ? `The Chalk API request failed with HTTP ${status}.` : "The Chalk API request failed.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object") return false;
  if (value === null) return false;
  return !Array.isArray(value);
}
