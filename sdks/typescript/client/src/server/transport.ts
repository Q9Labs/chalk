import { ChalkAPIError, errorCode, requestId } from "./errors.js";
import type { ChalkIdempotencyOptions, ChalkServerClientOptions } from "./types.js";

type RetryMode = "never" | "always" | "caller_idempotency";
export type ServerRequest = {
  readonly body?: unknown;
  readonly expectedStatus: number;
  readonly idempotency?: ChalkIdempotencyOptions;
  readonly method: "DELETE" | "GET" | "POST";
  readonly path: string;
  readonly retry: RetryMode;
};

type Attempt = {
  readonly apiBaseURL: string;
  readonly apiKey: string;
  readonly fetch: typeof globalThis.fetch;
  readonly idempotencyKey: string | undefined;
  readonly input: ServerRequest;
  readonly options: ChalkServerClientOptions;
  readonly retries: number;
};

const retryableStatuses = new Set([429, 502, 503, 504]);
const maxRetries = 2;

export function createServerRequester(options: ChalkServerClientOptions, apiKey: string, apiBaseURL: string, fetchImplementation: typeof globalThis.fetch) {
  return <T>(input: ServerRequest): Promise<T> => {
    const suppliedKey = input.idempotency?.idempotencyKey;
    const attempt = {
      apiBaseURL,
      apiKey,
      fetch: fetchImplementation,
      idempotencyKey: idempotencyKey(input.retry, suppliedKey),
      input,
      options,
      retries: retryCount(input.retry, suppliedKey),
    };
    return performAttempt<T>(attempt, 0);
  };
}

async function performAttempt<T>(attempt: Attempt, index: number): Promise<T> {
  const response = await fetchAttempt(attempt, index);
  if (response.status === attempt.input.expectedStatus) return decodeSuccess<T>(response);
  if (canRetryResponse(response, attempt.retries, index)) return retryResponse<T>(response, attempt, index);
  throw await responseError(response);
}

async function fetchAttempt(attempt: Attempt, index: number): Promise<Response> {
  try {
    return await attempt.fetch(requestURL(attempt), requestInit(attempt));
  } catch {
    return retryTransport(attempt, index);
  }
}

async function retryTransport(attempt: Attempt, index: number): Promise<Response> {
  if (index >= attempt.retries) throw new ChalkAPIError({ code: "network_error", retryable: true, status: 0 });
  await retryDelay(index);
  return fetchAttempt(attempt, index + 1);
}

async function retryResponse<T>(response: Response, attempt: Attempt, index: number): Promise<T> {
  await discard(response);
  await retryDelay(index);
  return performAttempt<T>(attempt, index + 1);
}

async function decodeSuccess<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new ChalkAPIError({ code: "invalid_response", requestId: requestId(response.headers), retryable: false, status: response.status });
  }
}

function canRetryResponse(response: Response, retries: number, index: number): boolean {
  if (index >= retries) return false;
  return retryableStatuses.has(response.status);
}

function requestURL(attempt: Attempt): URL {
  return new URL(attempt.input.path.replace(/^\/+/u, ""), attempt.apiBaseURL);
}

function requestInit(attempt: Attempt): RequestInit {
  return {
    method: attempt.input.method,
    headers: requestHeaders(attempt.options, attempt.apiKey, attempt.input.body !== undefined, attempt.idempotencyKey),
    ...serializedBody(attempt.input.body),
  };
}

function serializedBody(body: unknown): { readonly body?: string } {
  if (body === undefined) return {};
  return { body: JSON.stringify(body) };
}

function requestHeaders(options: ChalkServerClientOptions, apiKey: string, hasBody: boolean, idempotencyKeyValue: string | undefined): Headers {
  const headers = new Headers(options.headers);
  setContentType(headers, hasBody);
  setTelemetryHeaders(headers, options);
  setOptionalHeader(headers, "idempotency-key", idempotencyKeyValue);
  headers.set("authorization", `Bearer ${apiKey}`);
  return headers;
}

function setContentType(headers: Headers, hasBody: boolean): void {
  if (hasBody) headers.set("content-type", "application/json");
}

function setTelemetryHeaders(headers: Headers, options: ChalkServerClientOptions): void {
  if (!options.telemetry) return;
  headers.set("x-chalk-journey-id", options.telemetry.journeyId);
  headers.set("traceparent", options.telemetry.traceparent);
  setOptionalHeader(headers, "tracestate", options.telemetry.tracestate);
}

function setOptionalHeader(headers: Headers, name: string, value: string | undefined): void {
  if (value !== undefined) headers.set(name, value);
}

async function responseError(response: Response): Promise<ChalkAPIError> {
  return new ChalkAPIError({ code: errorCode(await errorBody(response)), requestId: requestId(response.headers), retryable: retryableStatuses.has(response.status), status: response.status });
}

async function errorBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function idempotencyKey(mode: RetryMode, suppliedKey: string | undefined): string | undefined {
  if (mode !== "caller_idempotency") return undefined;
  return suppliedKey ?? globalThis.crypto.randomUUID();
}

function retryCount(mode: RetryMode, suppliedKey: string | undefined): number {
  if (mode === "always") return maxRetries;
  if (mode === "caller_idempotency") return suppliedKey === undefined ? 0 : maxRetries;
  return 0;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // The retry decision is based on status; an unreadable error body must not widen it.
  }
}

function retryDelay(attempt: number): Promise<void> {
  const ceiling = Math.min(400, 50 * 2 ** attempt);
  return new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * (ceiling + 1))));
}
