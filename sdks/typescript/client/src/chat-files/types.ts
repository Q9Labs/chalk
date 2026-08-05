import type { ChalkChatAttachment, ChalkChatAttachmentMimeType } from "../collaboration/types";

export type ChalkChatFileOperation = "initiate_upload" | "finalize_upload" | "get_download";

export type ChalkChatFileErrorCode = "access.invalid" | "unavailable" | "permission_denied" | "invalid_payload" | "conflict" | "not_found" | "expired" | "file_transfer_failed";

export type ChalkChatFileFailure = {
  readonly operation: ChalkChatFileOperation;
  readonly code: ChalkChatFileErrorCode;
  readonly recoverable: boolean;
  readonly message: string;
};

export class ChalkChatFileError extends Error {
  readonly operation: ChalkChatFileOperation;
  readonly code: ChalkChatFileErrorCode;
  readonly recoverable: boolean;

  constructor(failure: ChalkChatFileFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "ChalkChatFileError";
    this.operation = failure.operation;
    this.code = failure.code;
    this.recoverable = failure.recoverable;
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
