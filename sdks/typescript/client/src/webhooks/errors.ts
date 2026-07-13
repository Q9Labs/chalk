export type WebhookErrorCode = "missing_headers" | "malformed_headers" | "invalid_secret" | "stale_timestamp" | "invalid_signature" | "invalid_json" | "identifier_mismatch" | "unsupported_api_version" | "invalid_event_body";

const messages: Record<WebhookErrorCode, string> = {
  missing_headers: "Required webhook headers are missing.",
  malformed_headers: "Webhook headers are malformed.",
  invalid_secret: "A webhook signing secret is invalid.",
  stale_timestamp: "The webhook timestamp is outside the allowed tolerance.",
  invalid_signature: "The webhook signature is invalid.",
  invalid_json: "The webhook body is not valid JSON.",
  identifier_mismatch: "The webhook identifiers do not match.",
  unsupported_api_version: "The webhook API version is unsupported.",
  invalid_event_body: "The webhook Event body is invalid.",
};

export class WebhookVerificationError extends Error {
  readonly code: WebhookErrorCode;

  constructor(code: WebhookErrorCode) {
    super(messages[code]);
    this.name = "WebhookVerificationError";
    this.code = code;
  }
}

export class WebhookServerOnlyError extends Error {
  constructor() {
    super("Chalk webhook receivers are available only in server and edge runtimes.");
    this.name = "WebhookServerOnlyError";
  }
}
