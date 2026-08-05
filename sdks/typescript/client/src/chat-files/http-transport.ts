import { CHALK_CHAT_ATTACHMENT_LIMITS, CHALK_CHAT_ATTACHMENT_MIME_TYPES, type ChalkChatAttachmentMimeType } from "../collaboration/types";
import { ChalkChatFileError, type ChalkChatFileFailure, type ChalkChatFileOperation, type ChalkChatFileTransport } from "./types";

export type ChalkChatFileHttpTransportOptions = {
  readonly baseUrl: string;
  readonly token: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
};

const encoder = new TextEncoder();
const sha256Pattern = /^[0-9a-f]{64}$/u;

export function createChalkChatFileHttpTransport(options: ChalkChatFileHttpTransportOptions): ChalkChatFileTransport {
  const request = createChatFileRequest(options);
  return {
    initiateUpload: async (input) => {
      validateUploadInput(input);
      return request(
        "initiate_upload",
        "/v1/chat/attachments/uploads",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        isInitiateUploadResponse,
      );
    },
    finalizeUpload: (uploadId) => request("finalize_upload", `/v1/chat/attachments/uploads/${encodeURIComponent(uploadId)}/finalize`, { method: "POST" }, isAttachment),
    getDownloadUrl: (attachmentId) => request("get_download", `/v1/chat/attachments/${encodeURIComponent(attachmentId)}/download`, { method: "GET" }, isDownloadResponse),
  };
}

function validateUploadInput(input: Parameters<ChalkChatFileTransport["initiateUpload"]>[0]): void {
  requireByteLength(input.clientAttachmentId, 16, 64, "Chat attachment client IDs must be between 16 and 64 bytes.");
  requireByteLength(input.fileName, 1, CHALK_CHAT_ATTACHMENT_LIMITS.maximumFileNameBytes, `Chat attachment filenames must be between 1 and ${CHALK_CHAT_ATTACHMENT_LIMITS.maximumFileNameBytes} bytes.`);
  if (!validAttachmentByteLength(input.byteLength)) invalidUpload(`Chat attachments must be between 1 and ${CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength} bytes.`);
  if (!isAllowedMimeType(input.mimeType) || !sha256Pattern.test(input.sha256)) invalidUpload("Chat attachment MIME type or SHA-256 digest is invalid.");
}

function requireByteLength(value: string, minimum: number, maximum: number, message: string): void {
  const byteLength = encoder.encode(value).byteLength;
  if (byteLength < minimum || byteLength > maximum) invalidUpload(message);
}

function validAttachmentByteLength(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength;
}

function invalidUpload(message: string): never {
  throw chatFileError("initiate_upload", "invalid_payload", false, message);
}

function createChatFileRequest(options: ChalkChatFileHttpTransportOptions) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  return async function request<T>(operation: ChalkChatFileOperation, path: string, init: RequestInit, accepts: (value: unknown) => value is T): Promise<T> {
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${await options.token()}`);
      response = await fetchImplementation(`${baseUrl}${path}`, { ...init, headers });
    } catch (cause) {
      throw new ChalkChatFileError({ operation, code: "unavailable", recoverable: true, message: "Chat attachment storage is unavailable." }, { cause });
    }
    if (!response.ok) throw responseError(response, operation);
    let value: unknown;
    try {
      value = await response.json();
    } catch (cause) {
      throw new ChalkChatFileError({ operation, code: "file_transfer_failed", recoverable: false, message: "Chat attachment service returned invalid JSON." }, { cause });
    }
    if (!accepts(value)) throw chatFileError(operation, "file_transfer_failed", false, "Chat attachment service returned an invalid response.");
    return value;
  };
}

function responseError(response: Response, operation: ChalkChatFileOperation): ChalkChatFileError {
  const code = responseErrorCode(response.status);
  return chatFileError(operation, code, response.status === 429 || response.status >= 500, "Chat attachment request failed.");
}

function responseErrorCode(status: number): ChalkChatFileFailure["code"] {
  if (status === 401) return "access.invalid";
  if (status === 403) return "permission_denied";
  if (status === 400) return "invalid_payload";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 410) return "expired";
  if (status === 429 || status >= 500) return "unavailable";
  return "file_transfer_failed";
}

function chatFileError(operation: ChalkChatFileOperation, code: ChalkChatFileFailure["code"], recoverable: boolean, message: string): ChalkChatFileError {
  return new ChalkChatFileError({ operation, code, recoverable, message });
}

function isInitiateUploadResponse(value: unknown): value is Awaited<ReturnType<ChalkChatFileTransport["initiateUpload"]>> {
  return hasOnlyKeys(value, "attachmentId,expiresAt,headers,method,uploadId,uploadUrl") && typeof value.attachmentId === "string" && typeof value.uploadId === "string" && value.method === "PUT" && isHttpUrl(value.uploadUrl) && isStringRecord(value.headers) && isDate(value.expiresAt);
}

function isAttachment(value: unknown): value is Awaited<ReturnType<ChalkChatFileTransport["finalizeUpload"]>> {
  return hasOnlyKeys(value, "attachmentId,byteLength,fileName,mimeType") && typeof value.attachmentId === "string" && typeof value.fileName === "string" && isAllowedMimeType(value.mimeType) && typeof value.byteLength === "number" && validAttachmentByteLength(value.byteLength);
}

function isDownloadResponse(value: unknown): value is Awaited<ReturnType<ChalkChatFileTransport["getDownloadUrl"]>> {
  return hasOnlyKeys(value, "downloadUrl,expiresAt") && isHttpUrl(value.downloadUrl) && isDate(value.expiresAt);
}

function hasOnlyKeys(value: unknown, expected: string): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join(",") === expected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !URL.canParse(value)) return false;
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isAllowedMimeType(value: unknown): value is ChalkChatAttachmentMimeType {
  return typeof value === "string" && (CHALK_CHAT_ATTACHMENT_MIME_TYPES as readonly string[]).includes(value);
}
