import type { ChalkChatAttachment, ChalkChatAttachmentMimeType } from "../collaboration/types";

export type ChalkChatFileOperation = "initiate_upload" | "store_upload" | "finalize_upload" | "get_download";

export const CHAT_FILE_REACHABILITY_MESSAGE = "Could not reach the chat attachment service (network or browser access failure).";

export const CHAT_FILE_STORAGE_UNREACHABLE_MESSAGE = "Could not send the file to storage (network or browser access failure).";

/** Where an upload broke. `storage_unreachable` means the browser never got an HTTP answer from storage: a network failure or a CORS block. */
export type ChatUploadFailureKind = "initiate_failed" | "storage_unreachable" | "storage_rejected" | "finalize_failed";

export type ChalkChatFileErrorCode = "access.invalid" | "unavailable" | "permission_denied" | "invalid_payload" | "conflict" | "not_found" | "expired" | "file_transfer_failed";

export type ChalkChatFileFailure = {
  readonly operation: ChalkChatFileOperation;
  readonly code: ChalkChatFileErrorCode;
  readonly recoverable: boolean;
  readonly message: string;
  readonly stage?: "token" | "request";
  /** HTTP status of the answer that failed the operation, when there was one. */
  readonly httpStatus?: number;
};

export class ChalkChatFileError extends Error {
  readonly operation: ChalkChatFileOperation;
  readonly code: ChalkChatFileErrorCode;
  readonly recoverable: boolean;
  readonly stage: "token" | "request";
  readonly httpStatus: number | undefined;

  constructor(failure: ChalkChatFileFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "ChalkChatFileError";
    this.operation = failure.operation;
    this.code = failure.code;
    this.recoverable = failure.recoverable;
    this.stage = failure.stage ?? "request";
    this.httpStatus = failure.httpStatus;
  }
}

export type ChalkChatFileTransport = {
  readonly initiateUpload: (input: { readonly clientAttachmentId: string; readonly fileName: string; readonly mimeType: ChalkChatAttachmentMimeType; readonly byteLength: number; readonly sha256: string }) => Promise<{
    readonly attachmentId: string;
    readonly uploadId: string;
    readonly method: "PUT";
    readonly uploadUrl: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly expiresAt: string;
  }>;
  readonly finalizeUpload: (uploadId: string) => Promise<ChalkChatAttachment>;
  readonly getDownloadUrl: (attachmentId: string) => Promise<{
    readonly downloadUrl: string;
    readonly expiresAt: string;
  }>;
};

export function chatUploadFailureOf(cause: unknown): { readonly kind: ChatUploadFailureKind; readonly httpStatus?: number } | null {
  if (!(cause instanceof ChalkChatFileError)) return null;
  const httpStatus = cause.httpStatus === undefined ? {} : { httpStatus: cause.httpStatus };
  switch (cause.operation) {
    case "initiate_upload":
      return { kind: "initiate_failed", ...httpStatus };
    case "finalize_upload":
      return { kind: "finalize_failed", ...httpStatus };
    case "store_upload":
      return { kind: cause.code === "unavailable" ? "storage_unreachable" : "storage_rejected", ...httpStatus };
    case "get_download":
      return null;
  }
}

/** Sends the bytes to the presigned storage URL and keeps the cause: no HTTP answer at all versus an HTTP status. */
export async function storeUpload(fetch: typeof globalThis.fetch, upload: { readonly uploadUrl: string; readonly method: string; readonly headers: Readonly<Record<string, string>> }, bytes: ArrayBuffer): Promise<void> {
  let response: Response;
  try {
    response = await fetch(upload.uploadUrl, { method: upload.method, headers: upload.headers, body: bytes });
  } catch (cause) {
    throw new ChalkChatFileError({ operation: "store_upload", code: "unavailable", recoverable: true, message: CHAT_FILE_STORAGE_UNREACHABLE_MESSAGE }, { cause });
  }
  if (!response.ok) {
    throw new ChalkChatFileError({ operation: "store_upload", code: "file_transfer_failed", recoverable: response.status >= 500, message: `Attachment upload failed with HTTP ${response.status}`, httpStatus: response.status });
  }
}
