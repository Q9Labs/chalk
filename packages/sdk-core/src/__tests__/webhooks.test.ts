import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { chalkWebhookMiddleware, chalkWebhookParserErrorMiddleware, normalizeChalkSignatureHeader } from "../webhooks/index.ts";

const SECRET = "whsec_test_secret";

async function createHmacSignature(secret: string, message: string) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(message);
  const cryptoKey = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function createPayload() {
  return JSON.stringify({
    event: "meeting.recording_ready",
    timestamp: "2026-03-17T00:00:00Z",
    meeting: {
      id: "meeting_123",
      name: "Algebra Session",
      started_at: "2026-03-17T00:00:00Z",
      ended_at: "2026-03-17T01:00:00Z",
      duration_seconds: 3600,
      participant_count: 2,
    },
    participants: [
      {
        id: "participant_1",
        external_user_id: "user_1",
        display_name: "Ada",
        role: "host",
        joined_at: "2026-03-17T00:00:00Z",
      },
    ],
    recording: {
      id: "recording_123",
      duration_seconds: 3600,
      size_bytes: 1024,
      download_url: "https://example.com/recording.webm",
      download_api: "https://api.example.com/recording",
      expires_at: "2026-03-17T02:00:00Z",
    },
    transcript: {
      id: "transcript_123",
      text: "hello world",
      word_count: 2,
      language: "en",
      provider: "whisper",
      segments: [{ start: 0, end: 1, text: "hello" }],
    },
    summary: "lesson summary",
    action_items: ["follow up"],
  });
}

function createResponseRecorder() {
  const state = {
    statusCode: 200,
    body: undefined as unknown,
  };

  const response = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
  } as unknown as Response;

  return { response, state };
}

function createRequest(
  overrides: Partial<Request> & {
    headers?: Record<string, string | undefined>;
    body?: unknown;
    isJson?: boolean;
  } = {},
) {
  const headers = overrides.headers ?? {};

  return {
    body: overrides.body,
    headers,
    id: overrides.id ?? "req_123",
    is: vi.fn((value: string) => (value === "application/json" ? (overrides.isJson ?? true) : false)),
    originalUrl: overrides.originalUrl ?? "/webhook/chalk",
  } as unknown as Request;
}

describe("webhook express adapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes raw hex signatures", () => {
    const raw = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(normalizeChalkSignatureHeader(raw)).toBe(`sha256=${raw}`);
    expect(normalizeChalkSignatureHeader(`sha256=${raw}`)).toBe(`sha256=${raw}`);
  });

  it("rejects invalid content type with 415", async () => {
    const middleware = chalkWebhookMiddleware({ secret: SECRET });
    const req = createRequest({
      isJson: false,
      headers: {
        "x-chalk-signature": "sha256=abc",
        "x-chalk-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: Buffer.from("{}"),
    });
    const { response, state } = createResponseRecorder();
    const next = vi.fn(() => {});

    await middleware(req, response, next);

    expect(state.statusCode).toBe(415);
    expect(state.body).toEqual({
      error: "Webhook content type must be application/json",
      errorCode: "WEBHOOK_CONTENT_TYPE_INVALID",
      retryable: false,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects missing body with 400", async () => {
    const middleware = chalkWebhookMiddleware({ secret: SECRET });
    const req = createRequest({
      headers: {
        "x-chalk-signature": "sha256=abc",
        "x-chalk-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: undefined,
    });
    const { response, state } = createResponseRecorder();

    await middleware(
      req,
      response,
      vi.fn(() => {}),
    );

    expect(state.statusCode).toBe(400);
    expect(state.body).toEqual({
      error: "Webhook body missing",
      errorCode: "WEBHOOK_BODY_MISSING",
      retryable: false,
    });
  });

  it("accepts valid payloads and enriches request context", async () => {
    const middleware = chalkWebhookMiddleware({ secret: SECRET });
    const body = createPayload();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await createHmacSignature(SECRET, `${timestamp}.${body}`);
    const req = createRequest({
      body: Buffer.from(body),
      headers: {
        "content-type": "application/json",
        "x-chalk-delivery-id": "delivery_123",
        "x-chalk-event": "meeting.recording_ready",
        "x-chalk-signature": signature,
        "x-chalk-timestamp": timestamp,
      },
    });
    const { response, state } = createResponseRecorder();
    const next = vi.fn(() => {});

    await middleware(req, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(state.body).toBeUndefined();
    expect(req.chalkDeliveryId).toBe("delivery_123");
    expect(req.chalkHeaderEventType).toBe("meeting.recording_ready");
    expect(req.chalkTimestampHeader).toBe(timestamp);
    expect(req.chalkWebhookBodySha256).toBe(await sha256Hex(body));
    expect(req.chalkEvent?.type).toBe("meeting.recording_ready");
    expect(req.chalkEvent?.payload.meeting.id).toBe("meeting_123");
  });

  it("accepts raw hex signatures for compatibility", async () => {
    const middleware = chalkWebhookMiddleware({ secret: SECRET });
    const body = createPayload();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await createHmacSignature(SECRET, `${timestamp}.${body}`);
    const req = createRequest({
      body: Buffer.from(body),
      headers: {
        "content-type": "application/json",
        "x-chalk-signature": signature,
        "x-chalk-timestamp": timestamp,
      },
    });
    const next = vi.fn(() => {});

    await middleware(req, createResponseRecorder().response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.chalkEvent?.type).toBe("meeting.recording_ready");
  });

  it("maps invalid payloads to 400", async () => {
    const middleware = chalkWebhookMiddleware({ secret: SECRET });
    const body = JSON.stringify({ nope: true });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await createHmacSignature(SECRET, `${timestamp}.${body}`);
    const req = createRequest({
      body: Buffer.from(body),
      headers: {
        "content-type": "application/json",
        "x-chalk-signature": signature,
        "x-chalk-timestamp": timestamp,
      },
    });
    const { response, state } = createResponseRecorder();

    await middleware(
      req,
      response,
      vi.fn(() => {}),
    );

    expect(state.statusCode).toBe(400);
    expect(state.body).toEqual({
      error: "Webhook payload validation failed",
      errorCode: "WEBHOOK_PAYLOAD_INVALID",
      retryable: false,
    });
  });

  it("maps expired timestamps to 401", async () => {
    const middleware = chalkWebhookMiddleware({ secret: SECRET });
    const body = createPayload();
    const timestamp = String(Math.floor(Date.now() / 1000) - 3600);
    const signature = await createHmacSignature(SECRET, `${timestamp}.${body}`);
    const req = createRequest({
      body: Buffer.from(body),
      headers: {
        "content-type": "application/json",
        "x-chalk-signature": signature,
        "x-chalk-timestamp": timestamp,
      },
    });
    const { response, state } = createResponseRecorder();

    await middleware(
      req,
      response,
      vi.fn(() => {}),
    );

    expect(state.statusCode).toBe(401);
    expect(state.body).toEqual({
      error: "Webhook timestamp outside tolerance window",
      errorCode: "WEBHOOK_TIMESTAMP_EXPIRED",
      retryable: false,
    });
  });

  it("maps parser errors to exact JSON responses", () => {
    const middleware = chalkWebhookParserErrorMiddleware();
    const { response, state } = createResponseRecorder();
    const next = vi.fn(() => {});

    middleware({ type: "entity.too.large" }, createRequest({ originalUrl: "/webhook/chalk" }), response, next);

    expect(state.statusCode).toBe(413);
    expect(state.body).toEqual({
      error: "Webhook payload exceeded configured size limit",
      errorCode: "WEBHOOK_BODY_TOO_LARGE",
      retryable: false,
    });
    expect(next).not.toHaveBeenCalled();
  });
});
